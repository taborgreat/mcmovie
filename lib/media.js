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
    out.push({ id, type: e.type || 'overlay', register: e.register || 'clean', file: e.file, present: file ? U.exists(file) : true, builtin: !e.file, key: e.key, layout: e.layout, sound: e.sound, pause: !!e.pause, on: e.on || null, lead_sec: e.lead_sec || 0, allow_finale: !!e.allow_finale, seconds: e.out !== undefined ? +(e.out - (e.in || 0)).toFixed(1) : (e.seconds_measured || null), moods: e.moods || [], use: e.use || e.note || (id === 'rewind' ? 'over the cut back after a teaser' : id === 'fastforward' ? 'over the start of a sped-up segment' : id === 'swoosh' ? 'on the lift to the cake tower' : ''), needs_details: /TO FILL IN/i.test(e.use || '') })
  }
  return out
}

// what a plan may call for: stings and inserts (at a moment) and transitions (between segments),
// filtered by the strategy's register: 'clean' hides the memes, 'memed' shows everything
const CALLABLE = new Set(['sting', 'insert', 'transition'])
function stings (register = 'clean') {
  return catalogue().filter(m => CALLABLE.has(m.type) && m.present && !m.suspended && (register === 'memed' || m.register === 'clean'))
}

// the planner's list, in a few lines, for the register the strategy allows
function stingsMarkdown (register = 'clean', max = 1) {
  const list = stings(register)
  if (!list.length) return ''
  const moments = list.filter(m => m.type !== 'transition'); const trans = list.filter(m => m.type === 'transition')
  const line = m => `- \`${m.id}\` (${m.seconds} s${m.pause ? ', pauses the film' : ''}${m.sound === 'takeover' ? ', its sound takes over the music' : ''}${m.on && m.on !== 'any' ? `, lands on the ${m.on}` : ''}${m.register === 'memed' ? ', meme' : ''}): ${m.use}`
  const out = ['## Effects you may call for', '',
    `Short clips laid over the picture at a moment, each with a purpose. Use one only where the moment really is that; at most ${max} in this film, and most films have none. ${register === 'memed' ? 'This strategy allows memes: still one joke per moment, never a pile.' : 'Memes are not on offer under this strategy.'}`, '',
    'A call goes on the segment: `"stings": [{ "id": "<id>", "at_sec": <seconds from the segment start> }]`, or `{ "id", "on": "death" | "hit" | "start" | "end" }` to land it on the first death or first hit in the segment, its start, or its end (clips with a beat, like a countdown, are timed so the beat lands on it). Nobody talks over a sting that pauses the film (`check` refuses a line that starts inside it or runs into it). Not in the teaser or the finale unless the clip says so.', '']
  if (moments.length) out.push(...moments.map(line), '')
  if (trans.length) out.push('Transitions go on the later of two segments as `"transition": "<id>"` and wipe over the cut into it (never on the first segment):', '', ...trans.map(line), '')
  return out.join('\n')
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
