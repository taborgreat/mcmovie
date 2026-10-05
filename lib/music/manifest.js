'use strict'
// Tabor's music library. `scan` builds/updates music/music_manifest.json with
// one entry per audio file (id, path, duration). Mood tags, tempo, intensity,
// loopable and in/out points are filled in by hand or by the LLM operator.
// Films ask for music by mood ("sad", "intense", "funny"); a film can change
// mood from scene to scene. `mock` writes a small synthetic palette so the
// pipeline can be tested without a library.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const U = require('../util')

const MUSIC_DIR = path.join(U.ROOT, 'music')
const MANIFEST = path.join(MUSIC_DIR, 'music_manifest.json')
const EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus'])

// The general moods films ask for. Tag tracks with these so requests match.
const MOODS = ['calm', 'sad', 'tense', 'intense', 'battle', 'epic', 'triumphant', 'funny', 'suspense', 'dark', 'warm', 'romantic', 'mysterious']

function duration (file) {
  try {
    return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim())
  } catch { return null }
}

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.has(path.extname(e.name).toLowerCase())) out.push(p)
  }
  return out
}

function readManifest () { return U.exists(MANIFEST) ? U.readJson(MANIFEST) : { tracks: [] } }

// Mood tags guessed from the folder and file name, e.g. music/sad/rain.mp3 -> ["sad"].
function guessMoods (rel) {
  const words = rel.toLowerCase().split(/[^a-z]+/)
  return MOODS.filter(m => words.includes(m))
}

function scan (dir) {
  dir = dir ? path.resolve(dir) : MUSIC_DIR
  const manifest = readManifest()
  const byPath = new Map(manifest.tracks.map(t => [t.path, t]))
  const ids = new Set(manifest.tracks.map(t => t.id))
  const files = walk(dir)
  let added = 0
  for (const f of files) {
    const rel = path.relative(MUSIC_DIR, f).startsWith('..') ? f : path.relative(MUSIC_DIR, f)
    if (byPath.has(rel)) continue
    let id = U.slugify(path.basename(f, path.extname(f)))
    while (ids.has(id)) id += '_'
    ids.add(id)
    const d = duration(f)
    byPath.set(rel, { id, path: rel, duration_sec: d, mood_tags: guessMoods(rel), tempo: '', intensity: 3, loopable: false, in_sec: 0, out_sec: d, gain_db: -6, notes: '' })
    added++
  }
  manifest.tracks = [...byPath.values()]
  manifest.moods = MOODS
  manifest.updated = new Date().toISOString()
  U.writeJson(MANIFEST, manifest)
  return { added, total: manifest.tracks.length }
}

// Synthetic test tracks (chord pads), one per broad mood.
function mock () {
  fs.mkdirSync(MUSIC_DIR, { recursive: true })
  const tracks = [
    { id: 'mock_calm', freqs: [196, 247, 294], mood_tags: ['calm', 'warm', 'rustic', 'peaceful'], tempo: 'slow' },
    { id: 'mock_tense', freqs: [110, 131, 165], mood_tags: ['tense', 'dark', 'battle', 'intense', 'suspense'], tempo: 'fast' },
    { id: 'mock_sad', freqs: [147, 175, 220], mood_tags: ['sad', 'melancholy', 'loss'], tempo: 'slow' },
    { id: 'mock_epic', freqs: [131, 196, 262, 330], mood_tags: ['epic', 'triumphant', 'heroic', 'victory'], tempo: 'mid' },
    { id: 'mock_funny', freqs: [330, 415, 494], mood_tags: ['funny', 'comedy', 'playful', 'silly'], tempo: 'mid' }
  ]
  const manifest = readManifest()
  for (const t of tracks) {
    const file = path.join(MUSIC_DIR, `${t.id}.wav`)
    if (!U.exists(file)) {
      const expr = t.freqs.map(f => `0.12*sin(2*PI*${f}*t)*(0.7+0.3*sin(2*PI*0.25*t))`).join('+')
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=120`, '-ac', '2', file])
    }
    const existing = manifest.tracks.find(x => x.id === t.id)
    if (existing) existing.mood_tags = t.mood_tags
    else manifest.tracks.push({ id: t.id, path: `${t.id}.wav`, duration_sec: 120, mood_tags: t.mood_tags, tempo: t.tempo, intensity: 2, loopable: true, in_sec: 0, out_sec: 120, gain_db: -8, notes: 'synthetic test track' })
  }
  manifest.moods = MOODS
  manifest.updated = new Date().toISOString()
  U.writeJson(MANIFEST, manifest)
  return manifest
}

module.exports = { scan, mock, readManifest, MUSIC_DIR, MANIFEST, MOODS }
