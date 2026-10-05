'use strict'
// A demo music library: Kevin MacLeod tracks (incompetech.com), licensed
// Creative Commons Attribution 4.0. They are free to use on YouTube as long
// as the credit line is in the description, which the publisher adds from
// the manifest automatically. Replace or extend with your own music any time
// (music:scan); this set just gives every general mood something to play.
const fs = require('fs')
const path = require('path')
const https = require('https')
const { execFileSync } = require('child_process')
const U = require('../util')
const M = require('./manifest')

const DIR = path.join(M.MUSIC_DIR, 'kevin_macleod')
const LICENSE = 'CC BY 4.0'
const credit = (title) => `"${title}" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/`

// title, moods, tempo, intensity 1-5
const TRACKS = [
  ['Meditation Impromptu 01', ['calm', 'peaceful', 'warm'], 'slow', 1],
  ['Dreamy Flashback', ['calm', 'romantic', 'warm', 'mysterious'], 'slow', 1],
  ['Wholesome', ['warm', 'romantic', 'calm', 'hopeful'], 'slow', 2],
  ['Carefree', ['warm', 'happy', 'playful'], 'mid', 2],
  ['Heartbreaking', ['sad', 'melancholy', 'loss'], 'slow', 2],
  ['Sad Trio', ['sad', 'melancholy', 'loss'], 'slow', 2],
  ['Long Note Two', ['sad', 'dark', 'calm'], 'slow', 1],
  ['Sneaky Snitch', ['funny', 'sneaky', 'playful', 'suspense'], 'mid', 2],
  ['Monkeys Spinning Monkeys', ['funny', 'silly', 'playful', 'comedy'], 'fast', 2],
  ['Fluffing a Duck', ['funny', 'silly', 'comedy'], 'mid', 2],
  ['Investigations', ['mysterious', 'sneaky', 'suspense', 'funny'], 'mid', 2],
  ['Hidden Agenda', ['mysterious', 'suspense', 'sneaky'], 'mid', 2],
  ['Ossuary 6 - Air', ['dark', 'mysterious', 'suspense'], 'slow', 2],
  ['The Descent', ['dark', 'suspense', 'tense'], 'slow', 3],
  ['Darkest Child', ['dark', 'tense', 'suspense'], 'mid', 3],
  ['Anxiety', ['tense', 'suspense', 'dark'], 'mid', 3],
  ['Impact Moderato', ['tense', 'intense', 'suspense'], 'mid', 4],
  ['Volatile Reaction', ['intense', 'battle', 'tense'], 'fast', 5],
  ['Killers', ['intense', 'battle', 'dark'], 'fast', 5],
  ['Prelude and Action', ['intense', 'battle', 'epic'], 'fast', 5],
  ['Clash Defiant', ['epic', 'battle', 'intense'], 'fast', 5],
  ['Crusade', ['epic', 'battle', 'intense'], 'fast', 5],
  ['Five Armies', ['epic', 'battle', 'triumphant'], 'mid', 4],
  ['Heroic Age', ['epic', 'triumphant', 'heroic', 'victory'], 'mid', 4]
]

function download (url, file) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 mcmovie' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const out = fs.createWriteStream(file)
      res.pipe(out)
      out.on('finish', () => out.close(resolve))
    }).on('error', reject)
  })
}

async function install (opts = {}) {
  fs.mkdirSync(DIR, { recursive: true })
  const manifest = M.readManifest()
  // the synthetic test tracks would compete with real music for the same moods
  manifest.tracks = manifest.tracks.filter(t => !t.id.startsWith('mock_'))
  let fetched = 0
  for (const [title, moods, tempo, intensity] of TRACKS) {
    const base = title.replace(/ /g, '_').replace(/'/g, '')
    const file = path.join(DIR, base + '.mp3')
    if (!U.exists(file) || fs.statSync(file).size < 100000) {
      try { await download('https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + encodeURIComponent(title) + '.mp3', file); fetched++ } catch (e) { U.log('music', `could not fetch ${title}: ${e.message}`); continue }
    }
    const rel = path.relative(M.MUSIC_DIR, file)
    const id = 'km_' + U.slugify(title)
    let dur = null
    try { dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim()) } catch { /* keep null */ }
    const entry = { id, path: rel, title, artist: 'Kevin MacLeod', duration_sec: dur, mood_tags: moods, tempo, intensity, loopable: true, in_sec: 0, out_sec: dur, gain_db: -13, license: LICENSE, credit: credit(title), notes: 'demo library; incompetech.com' }
    const i = manifest.tracks.findIndex(t => t.id === id)
    if (i >= 0) manifest.tracks[i] = { ...manifest.tracks[i], ...entry, mood_tags: opts.keepTags ? manifest.tracks[i].mood_tags : moods }
    else manifest.tracks.push(entry)
  }
  manifest.moods = M.MOODS
  manifest.updated = new Date().toISOString()
  U.writeJson(M.MANIFEST, manifest)
  return { fetched, total: manifest.tracks.length }
}

module.exports = { install, TRACKS, DIR }
