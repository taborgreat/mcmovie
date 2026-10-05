'use strict'
// The finale: every match film plays its last kill in slow motion under one song.
//
// The song (Tabor's; dropped at the project root or in music/finale/) has a build-up and a
// drop. The finale segment is cut to it: the build-up plays under the seconds before the last
// fight (the two players closing in), the drop lands as the fight turns, the kill comes a few
// seconds after, and when the song ends the film cuts to the winner's celebration.
//
// Slow motion is real: the studio server's tick rate is lowered for that scene, so the whole
// game (swings, falls, particles, the death) runs slow and the client draws it smoothly.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const U = require('../util')
const mix = require('../assemble/mix')

const TRACK_ID = 'finale_song'
const AUDIO = /\.(mp3|wav|m4a|ogg|flac|opus|aac)$/i
const DEFAULTS = {
  enabled: true,
  track: null, // path to the song; null = the first audio file at the project root or in music/finale/
  drop_sec: 9, // where the drop is in the song
  speed: 0.5, // slow-motion speed, used only for a sudden kill (see `slow`)
  slow: 'auto', // 'auto': slow motion only for a sudden kill (a stomp, a trap, a fall, a blast, a one-second fight); 'always'; 'never'
  kill_at: 0.7, // how far through the part after the drop the kill lands (0..1)
  level_db: -21, // how loud the song sits (mean level, dB); the rest of the music is around -18
  credit: null // a line for the video description, if the song needs one
}

function config () {
  const c = { ...DEFAULTS, ...((mix.load().finale) || {}) }
  if (process.env.MCMOVIE_NO_FINALE) c.enabled = false // tests
  return c
}

function findSong (cfg = config()) {
  if (cfg.track) { const p = path.resolve(U.ROOT, cfg.track); return U.exists(p) ? p : null }
  for (const dir of [path.join(U.ROOT, 'music', 'finale'), U.ROOT]) {
    if (!U.exists(dir)) continue
    const f = fs.readdirSync(dir).filter(n => AUDIO.test(n) && fs.statSync(path.join(dir, n)).isFile()).sort()[0]
    if (f) return path.join(dir, f)
  }
  return null
}

function probe (file) {
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim())
  let mean = -16
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }).toString()
    const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/)
    if (m) mean = parseFloat(m[1])
  } catch (e) { const m = String(e.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/); if (m) mean = parseFloat(m[1]) }
  return { duration: dur, mean_db: mean }
}

// The song, registered in the music manifest so the editor can cue it. null if there is none.
function song () {
  const cfg = config()
  if (!cfg.enabled) return null
  const file = findSong(cfg)
  if (!file) return null
  const manifestFile = path.join(U.ROOT, 'music', 'music_manifest.json')
  const manifest = U.exists(manifestFile) ? U.readJson(manifestFile) : { tracks: [] }
  let t = manifest.tracks.find(x => x.id === TRACK_ID)
  const stamp = `${file}:${fs.statSync(file).size}:${cfg.level_db !== undefined ? cfg.level_db : -21}`
  if (!t || t.source !== stamp) {
    const p = probe(file)
    // a touch above the rest of the film's music, not over it
    const gain = U.clamp((cfg.level_db !== undefined ? cfg.level_db : -21) - p.mean_db - (mix.load().music_gain_db || 0), -20, 6)
    const entry = { id: TRACK_ID, path: file, duration_sec: +p.duration.toFixed(3), mood_tags: ['finale'], tempo: 'fast', intensity: 5, loopable: false, in_sec: 0, out_sec: +p.duration.toFixed(3), gain_db: +gain.toFixed(1), notes: 'the finale song: slow-motion last kill', source: stamp }
    if (cfg.credit) entry.credit = cfg.credit
    manifest.tracks = [...manifest.tracks.filter(x => x.id !== TRACK_ID), entry]
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
    U.writeJson(manifestFile, manifest)
    t = entry
  }
  return { ...t, drop_sec: cfg.drop_sec, speed: cfg.speed, kill_at: cfg.kill_at, slow: cfg.slow }
}

// Where a track is at its biggest: the start of its loudest stretch of `need` seconds. The
// celebration music comes in there, already at full height, so the ending carries straight on
// from the finale song instead of starting over from a quiet intro.
function energeticStart (file, need = 14) {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', 'aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], { maxBuffer: 16e6 }).toString()
    const rms = [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map(m => (m[1] === '-inf' ? -90 : parseFloat(m[1])))
    if (rms.length < need + 4) return 0
    let best = 0; let bestV = -Infinity
    for (let i = 0; i + need <= rms.length - 2; i++) { let v = 0; for (let j = i; j < i + need; j++) v += rms[j]; if (v > bestV + 1e-9) { bestV = v; best = i } }
    return best
  } catch { return 0 }
}

// The finale, cut to the song. Times are match seconds; film_sec is time on screen.
//
//   build  the song's build-up (to the drop): the seconds just before the last fight starts,
//          slow, on the two players' faces. Nothing is spoken.
//   fight  from the drop: the fight begins (its first hit), slow.
//   kill   the last blows and the death. If the fight is short, "fight" simply runs through
//          the kill and there is no separate part; if it is long, the middle of the fight is
//          skipped and the film cuts from its opening to its end.
function plan (rec, s = song()) {
  if (!s) return null
  const deaths = rec.events.filter(e => e.type === 'death')
  const last = deaths[deaths.length - 1]
  if (!last) return null
  const name = i => (rec.players[i] ? rec.players[i].name : null)
  const kill = last.t / 20
  // the winner is whisked to the cake tower moments after the kill: stop before that
  const jump = rec.events.find(e => e.t > last.t && (e.type === 'teleport' || (e.type === 'state' && e.state !== 'ACTIVE')))
  const end = Math.min(rec.meta.ticks / 20, kill + 0.9, jump ? Math.max(kill + 0.3, jump.t / 20 - 0.15) : Infinity)
  // where the last fight began: its first hit, walking back from the kill through the exchange
  let start = kill - 2.5
  if (last.k !== undefined) {
    const hits = rec.events.filter(e => e.type === 'hit' && e.t <= last.t && e.t > last.t - 1200 && ((e.a === last.k && e.v === last.v) || (e.a === last.v && e.v === last.k))).map(e => e.t).sort((x, y) => y - x)
    let first = hits.length ? hits[0] : null
    for (const t of hits) { if (first - t > 120) break; first = t }
    if (first !== null) start = Math.min(first / 20, kill - 0.6)
  }
  // Ordinary hand-to-hand combat plays at real speed. Slow motion is kept for the sudden
  // kill: a Stomper landing on someone, a trap, a fall, a blast, a bolt, a fight over in a blink.
  let sudden = null
  const melee = last.cause === 'entity_attack' || last.cause === 'entity_sweep_attack' || last.cause === 'projectile' || last.cause === undefined
  if (last.k === undefined) sudden = `died to the world (${String(last.cause || 'unknown').replace(/_/g, ' ')})`
  else if (!melee) sudden = `killed by ${String(last.cause).replace(/_/g, ' ')}`
  else if (kill - start <= 1.5) sudden = 'over in a blink'
  else if (/stomper/i.test(String((rec.players[last.k] || {}).kit))) {
    const tr = (rec.players[last.k] || {}).track || (rec.tracks && rec.tracks[last.k]) || []
    const near = tr.filter(p => p.t >= last.t - 50 && p.t <= last.t)
    if (near.length > 1 && Math.max(...near.map(p => p.y)) - near[near.length - 1].y >= 4) sudden = 'a stomp from above'
  }
  const mode = s.slow || 'auto'
  const slow = mode === 'always' || (mode !== 'never' && !!sudden)
  const speed = slow ? s.speed : 1
  const post = Math.max(3, s.duration_sec - s.drop_sec) // film seconds after the drop
  const r1 = x => +x.toFixed(1)
  const parts = []
  const buildFrom = Math.max(0, start - s.drop_sec * speed)
  parts.push({ id: 'finale_build', role: 'build', from_sec: r1(buildFrom), to_sec: r1(start), speed })
  const span = end - start
  if (span <= post * speed + 0.05) {
    // the whole fight fits after the drop. In slow motion a very short one is slowed further to
    // fill the song; at real speed the song simply plays on into the celebration.
    parts.push({ id: 'finale_fight', role: 'fight', from_sec: r1(start), to_sec: r1(end), speed: slow ? +U.clamp(span / post, 0.25, speed).toFixed(3) : 1 })
  } else {
    const open = 3 * speed; const close = post * speed - open
    parts.push({ id: 'finale_fight', role: 'fight', from_sec: r1(start), to_sec: r1(start + open), speed })
    parts.push({ id: 'finale_kill', role: 'kill', from_sec: r1(end - close), to_sec: r1(end), speed })
  }
  for (const p of parts) p.film_sec = +((p.to_sec - p.from_sec) / p.speed).toFixed(1)
  return {
    parts, from_sec: parts[0].from_sec, to_sec: parts[parts.length - 1].to_sec, fight_start_sec: r1(start), kill_sec: r1(kill),
    film_sec: +parts.reduce((n, p) => n + p.film_sec, 0).toFixed(1), drop_film_sec: s.drop_sec, slow, why_slow: slow ? (sudden || 'always on') : null,
    victim: name(last.v), killer: last.k !== undefined ? name(last.k) : null
  }
}

function toMarkdown (w) {
  if (!w) return ''
  const who = w.killer ? `${w.killer} kills ${w.victim}` : `${w.victim} dies`
  const focus = [w.killer, w.victim].filter(Boolean).map(n => JSON.stringify(n)).join(', ')
  const L = [
    '## The finale (required)', '',
    `The last fight (${who} at ${w.kill_sec}s; the fight starts at ${w.fight_start_sec}s) is always shown under the finale song${w.slow ? `, in slow motion this time (${w.why_slow})` : ', at real speed (slow motion is kept for sudden kills: a stomp, a trap, a fall)'}. Put exactly these segments in doc.json, in this order, and nothing else may cover ${w.from_sec}s to ${w.to_sec}s:`, '',
    '```json'
  ]
  for (const p of w.parts) L.push(`{ "id": "${p.id}", "finale": true, "from_sec": ${p.from_sec}, "to_sec": ${p.to_sec}, "focus": [${focus}], "narration": [] }${p === w.parts[w.parts.length - 1] ? '' : ','}`)
  L.push('```', '',
    `- \`finale_build\` is the song's build-up: ${w.drop_film_sec} s of film on the two players' faces as they close in, before a blow lands. NOTHING is spoken in it, and the segment before it must have finished talking by ${w.from_sec}s. Set the fight up before this point.`,
    `- The drop lands on the first hit (\`finale_fight\`)${w.parts.length > 2 ? '; the film then cuts to the last blows and the kill (`finale_kill`)' : ', which runs through the kill'}. You may narrate the fight here as you normally would (one or two lines, starting at least 0.5 s after the segment begins); do not announce the kill before it happens.`,
    '- The program sets the speed, the music and the face shots; do not add "speed", "music" or "shots" to these segments.',
    `- The segment right after is the winner's celebration: it starts at ${w.to_sec}s, runs to the end of the match, real speed, music "triumphant", and carries the lines about how it ended and the closing line about the winner.`, '')
  return L.join('\n')
}

module.exports = { TRACK_ID, config, song, plan, toMarkdown, findSong, energeticStart }
