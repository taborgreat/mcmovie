'use strict'
// Everything that can be put in a film besides the game itself, in one list: the finale songs
// (config/finale_songs.json), the mood tracks (music/music_manifest.json), the overlay effects and
// stings (config/effects.json), each with what it is for, how it is used, and its standing
// (lib/publish/music_health.js). Mirrored to MongoDB `media` so the record outlives this folder;
// `mcpublish media` prints it; the admin page shows it; the digest tells the planner which
// stings it may call for.
const path = require('path')
const U = require('./util')

function readIf (f) { try { return U.exists(f) ? U.readJson(f) : null } catch { return null } }

function catalogue () {
  const out = []
  let bad = new Set(); try { bad = require('./publish/music_health').suspended() } catch { /* none */ }
  const songs = (readIf(path.join(U.ROOT, 'config', 'finale_songs.json')) || {}).songs || []
  const present = new Set((() => { try { return require('./match/finale').songs().map(s => s.id) } catch { return [] } })())
  for (const s of songs) out.push({ id: 'finale:' + s.id, type: 'finale-song', title: s.id, file: s.file, present: present.has(s.id) || bad.has('finale:' + s.id), moods: s.moods || [], drop_sec: s.drop_sec, words: s.words || 'normal', soft_duck: !!s.soft_duck, default: !!s.default, use: s.feel || s.note || 'the last fight is cut to its drop', suspended: bad.has('finale:' + s.id) })
  const man = readIf(path.join(U.ROOT, 'music', 'music_manifest.json')) || { tracks: [] }
  for (const t of man.tracks || []) {
    if (t.id === 'finale_song') continue
    const file = path.isAbsolute(t.path) ? t.path : path.join(U.ROOT, 'music', t.path)
    out.push({ id: t.id, type: 'mood-track', title: t.title, artist: t.artist, file: t.path, present: U.exists(file), moods: t.mood_tags || [], tempo: t.tempo, intensity: t.intensity, seconds: t.duration_sec, license: t.license, use: t.notes || 'picked by mood for a segment', suspended: bad.has(t.id) })
  }
  const fx = (readIf(path.join(U.ROOT, 'config', 'effects.json')) || {}).effects || {}
  for (const [id, e] of Object.entries(fx)) {
    const file = e.file ? (path.isAbsolute(e.file) ? e.file : path.join(U.ROOT, e.file)) : null
    out.push({ id, type: e.type === 'sting' ? 'sting' : 'overlay', file: e.file, present: file ? U.exists(file) : true, builtin: !e.file, key: e.key, layout: e.layout, sound: e.sound, seconds: e.out !== undefined ? +(e.out - (e.in || 0)).toFixed(1) : null, moods: e.moods || [], use: e.use || e.note || (id === 'rewind' ? 'over the cut back after a teaser' : id === 'fastforward' ? 'over the start of a sped-up segment' : id === 'swoosh' ? 'on the lift to the cake tower' : ''), needs_details: /TO FILL IN/i.test(e.use || '') })
  }
  return out
}

function stings () { return catalogue().filter(m => m.type === 'sting' && m.present && !m.suspended) }

// what the planner may call for, in a few lines
function stingsMarkdown () {
  const list = stings()
  if (!list.length) return ''
  return ['## Stings you may call for', '', 'A sting is a short clip with its own sound laid over the picture at a moment (`"stings": [{ "id", "at_sec" }]` on a segment, at_sec from the segment start). Use one only where its purpose fits; never more than one per film.', '', ...list.map(m => `- \`${m.id}\` (${m.seconds} s${m.sound === 'takeover' ? ', its sound takes over the music' : ''}): ${m.use}`), ''].join('\n')
}

async function mirror () {
  try {
    const mongo = require('./publish/db'); const client = await mongo.connect({}); const col = client.db().collection('media')
    const items = catalogue()
    if (items.length) await col.bulkWrite(items.map(m => ({ updateOne: { filter: { _id: m.id }, update: { $set: { ...m, updated: new Date() } }, upsert: true } })), { ordered: false })
    await mongo.close(); return items.length
  } catch { return 0 }
}

module.exports = { catalogue, stings, stingsMarkdown, mirror }
