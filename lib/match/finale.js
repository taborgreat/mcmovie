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
const R = require('./recording')
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

// The songs on offer (config/finale_songs.json), each with its own drop time and moods, and
// only those whose file is actually here. Without the list: whatever audio file is found.
function songs () {
  const f = path.join(U.ROOT, 'config', 'finale_songs.json')
  const dirs = [path.join(U.ROOT, 'music', 'finale'), U.ROOT]
  let list = []
  try { list = U.exists(f) ? (U.readJson(f).songs || []) : [] } catch { list = [] }
  let bad = new Set()
  try { bad = require('../publish/music_health').suspended() } catch { /* no record yet */ }
  const out = []
  for (const sng of list) {
    if (bad.has('finale:' + sng.id)) continue // a film with this song was muted, blocked or removed
    const dir = dirs.find(d => U.exists(path.join(d, sng.file)))
    if (dir) out.push({ ...sng, path: path.join(dir, sng.file) })
  }
  return out
}

// `choice`: a song id, a mood word, 'auto'/nothing for the default.
const RECENT = path.join(U.ROOT, 'automation', 'finale_recent.json')
function recentSongs () { try { return U.readJson(RECENT).ids || [] } catch { return [] } }
function noteSong (id) { try { const ids = [id, ...recentSongs().filter(x => x !== id)].slice(0, 4); U.writeJson(RECENT, { ids, at: new Date().toISOString() }) } catch { /* best effort */ } }

// The song for this film: the one asked for by id, or one that carries the mood asked for, or
// the default. Among several that fit, the one used least recently; a song the last two films
// used is passed over when another fits (Tabor: three films in a row on one song).
function findSong (cfg = config(), choice = null) {
  if (cfg.track) { const p = path.resolve(U.ROOT, cfg.track); return U.exists(p) ? { path: p, id: path.basename(p, path.extname(p)), drop_sec: cfg.drop_sec } : null }
  const list = songs()
  if (list.length) {
    const want = choice && choice !== 'auto' ? String(choice).toLowerCase() : null
    const recent = recentSongs()
    const rank = s => { const i = recent.indexOf(s.id); return i < 0 ? 99 : i } // higher = longer ago
    const fresh = c => c.slice().sort((a, b) => rank(b) - rank(a))[0]
    const byId = want && list.find(x => x.id === want)
    const byMood = !byId && want ? list.filter(x => (x.moods || []).includes(want)) : []
    if (byId) {
      // asked for by name: only when it was not the last two films' song and something else fits its moods
      if (recent.slice(0, 2).includes(byId.id)) { const alt = list.filter(x => x.id !== byId.id && (x.moods || []).some(m => (byId.moods || []).includes(m))); if (alt.length) return fresh(alt) }
      return byId
    }
    if (byMood.length) return fresh(byMood)
    const all = list.filter(x => !recent.slice(0, 2).includes(x.id))
    return fresh(all.length ? all : list)
  }
  for (const dir of [path.join(U.ROOT, 'music', 'finale'), U.ROOT]) {
    if (!U.exists(dir)) continue
    const n = fs.readdirSync(dir).filter(x => AUDIO.test(x) && fs.statSync(path.join(dir, x)).isFile()).sort()[0]
    if (n) return { path: path.join(dir, n), id: path.basename(n, path.extname(n)), drop_sec: cfg.drop_sec }
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
function song (choice = null) {
  const cfg = config()
  if (!cfg.enabled) return null
  const chosen = findSong(cfg, choice)
  if (!chosen) return null
  const file = chosen.path
  if (chosen.drop_sec !== undefined) cfg.drop_sec = chosen.drop_sec
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
  return { ...t, song_id: chosen.id, moods: chosen.moods || [], words: chosen.words || 'normal', soft_duck: !!chosen.soft_duck, drop_sec: cfg.drop_sec, speed: cfg.speed, kill_at: cfg.kill_at, slow: cfg.slow }
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
// A stomp is slowed until the leap, the fall and the hit take about this long on screen.
const STOMP_FILM_SEC = 5

function plan (rec, s = song()) {
  if (!s) return null
  const deaths = rec.events.filter(e => e.type === 'death')
  const last = deaths[deaths.length - 1]
  if (!last) return null
  const name = i => (rec.players[i] ? rec.players[i].name : null)
  const kill = last.t / 20
  // the winner is whisked to the cake tower moments after the kill: stop before that
  const jump = rec.events.find(e => e.t > last.t && (e.type === 'teleport' || (e.type === 'state' && e.state !== 'ACTIVE')))
  // after the blow: the loot spills and the winner turns round, up to the lift to the cake
  // (the server waits win.breath-ticks, 1.5 s, before lifting; older recordings lift at once)
  const end = Math.min(rec.meta.ticks / 20, kill + 1.3, jump ? Math.max(kill + 0.3, jump.t / 20 - 0.15) : Infinity)
  // where the last fight began: its first hit, walking back from the kill through the exchange
  let start = kill - 2.5
  if (last.k !== undefined) {
    const hits = rec.events.filter(e => e.type === 'hit' && e.t <= last.t && e.t > last.t - 1200 && ((e.a === last.k && e.v === last.v) || (e.a === last.v && e.v === last.k))).map(e => e.t).sort((x, y) => y - x)
    let first = hits.length ? hits[0] : null
    for (const t of hits) { if (first - t > 120) break; first = t }
    if (first !== null) start = Math.min(first / 20, kill - 0.6)
  }
  // A Stomper's kill is the whole leap, not just the landing: find where the fall began (the top
  // of the jump, or the edge stepped off) and open the fight there, so the film shows him leave
  // the height, the drop, and the hit. The camera for it is planned from this (build.js).
  // The stomp need not be the killing blow: a Stomper often lands on his victim and finishes
  // with a swing a few seconds later (Tabor: "it did not do the stomp kill cam on the Kaya
  // match"). So: the biggest drop of 4+ blocks in the last ten seconds whose landing was within
  // six blocks of the victim is the stomp; the fight opens half a second before the leap, the
  // fall is slowed and filmed from above, and the kill follows at real speed.
  let stomp = null
  if (last.k !== undefined && /stomper/i.test(String((rec.players[last.k] || {}).kit))) {
    const tr = ((rec.players[last.k] || {}).track || (rec.tracks && rec.tracks[last.k]) || []).filter(p => p.t >= last.t - 200 && p.t <= last.t + 2)
    const victim = rec.players[last.v]
    let best = null
    for (let i = 0; i < tr.length - 1; i++) {
      const top = tr[i]
      if (i > 0 && tr[i - 1].y > top.y + 0.05) continue // not the top of anything
      let j = i + 1
      while (j + 1 < tr.length && tr[j + 1].y <= tr[j].y + 0.05) j++
      const land = tr[j]
      const height = top.y - land.y
      if (height < 4) continue
      const vs = victim ? R.sampleAt(victim.track, land.t, 30) : null
      const lx = last.x !== undefined && Math.abs(land.t - last.t) < 20 ? last.x : land.x
      const lz = last.z !== undefined && Math.abs(land.t - last.t) < 20 ? last.z : land.z
      if (vs && Math.hypot(vs.x - lx, vs.z - lz) > 6) continue // he dropped somewhere else
      if (!best || height > best.height) best = { top, land, height, lx, lz }
    }
    if (best) {
      const leap = Math.max(kill - 10, best.top.t / 20)
      stomp = { leap_sec: +leap.toFixed(2), land_sec: +(best.land.t / 20).toFixed(2), height: +best.height.toFixed(1), from: [best.top.x, best.top.y, best.top.z], to: [best.lx, best.land.y, best.lz] }
      start = Math.min(start, Math.max(kill - 10, leap - 0.5))
    }
  }
  // Ordinary hand-to-hand combat plays at real speed. Slow motion is kept for the sudden
  // kill: a Stomper landing on someone, a trap, a fall, a blast, a bolt, a fight over in a blink.
  let sudden = null
  const melee = last.cause === 'entity_attack' || last.cause === 'entity_sweep_attack' || last.cause === 'projectile' || last.cause === undefined
  if (stomp) sudden = 'a stomp from above'
  else if (last.k === undefined) sudden = `died to the world (${String(last.cause || 'unknown').replace(/_/g, ' ')})`
  else if (!melee) sudden = `killed by ${String(last.cause).replace(/_/g, ' ')}`
  else if (kill - start <= 1.5) sudden = 'over in a blink'
  const mode = s.slow || 'auto'
  const slow = mode === 'always' || (mode !== 'never' && !!sudden)
  const speed = slow ? s.speed : 1
  const post = Math.max(3, s.duration_sec - s.drop_sec) // film seconds after the drop
  const r1 = x => +x.toFixed(1)
  const parts = []
  const buildFrom = Math.max(0, start - s.drop_sec * speed)
  parts.push({ id: 'finale_build', role: 'build', from_sec: r1(buildFrom), to_sec: r1(start), speed })
  const span = end - start
  if (stomp && end - stomp.land_sec > 0.8) {
    // the leap and the fall in slow motion from above, then the finish at real speed
    const landed = r1(stomp.land_sec + 0.3)
    // a short drop is slowed to about eight seconds on screen; a long one (off a tower) is long enough at nearly real speed
    parts.push({ id: 'finale_fight', role: 'fight', from_sec: r1(start), to_sec: landed, speed: +U.clamp((landed - start) / 8, 0.35, 1).toFixed(2) })
    parts.push({ id: 'finale_kill', role: 'kill', from_sec: landed, to_sec: r1(end), speed: 1 })
  } else if (span <= post * speed + 0.05) {
    // the whole fight fits after the drop. In slow motion a very short one is slowed further to
    // fill the song; at real speed the song simply plays on into the celebration.
    parts.push({ id: 'finale_fight', role: 'fight', from_sec: r1(start), to_sec: r1(end), speed: slow ? +U.clamp(span / (stomp ? STOMP_FILM_SEC : post), 0.25, speed).toFixed(2) : 1 })
  } else {
    const open = 3 * speed; const close = post * speed - open
    parts.push({ id: 'finale_fight', role: 'fight', from_sec: r1(start), to_sec: r1(start + open), speed })
    parts.push({ id: 'finale_kill', role: 'kill', from_sec: r1(end - close), to_sec: r1(end), speed })
  }
  // How long the celebration is worth watching. The winner gets their moment on the cake tower
  // (to jump about, crouch-dance, swing, whatever they want to show), but once they hop off or
  // just stand there the film moves on to the end card instead of holding an empty shot.
  const matchEnd = rec.meta.ticks / 20
  let celebrationTo = Math.min(matchEnd, end + 10)
  if (last.k !== undefined) {
    const tr = ((rec.players[last.k] || {}).track || (rec.tracks && rec.tracks[last.k]) || []).filter(p => p.t / 20 > end + 0.2)
    if (tr.length > 2) {
      const top = tr[0]
      let quietSince = top.t; let stop = null
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1]; const b = tr[i]
        if (b.y < top.y - 3 || Math.hypot(b.x - top.x, b.z - top.z) > 7) { stop = b.t / 20 + 0.4; break } // off the tower
        const active = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 0.15 || Math.abs((b.yaw || 0) - (a.yaw || 0)) > 12 || (b.flags !== a.flags) || ((b.flags || 0) & 16)
        if (active) quietSince = b.t
        else if (b.t - quietSince >= 50) { stop = quietSince / 20 + 1.2; break } // nothing for two and a half seconds
      }
      celebrationTo = Math.min(matchEnd, Math.max(end + 4, Math.min(stop === null ? end + 12 : stop, end + 12)))
    }
  }
  for (const p of parts) p.film_sec = +((p.to_sec - p.from_sec) / p.speed).toFixed(1)
  return {
    parts, from_sec: parts[0].from_sec, to_sec: parts[parts.length - 1].to_sec, fight_start_sec: r1(start), kill_sec: r1(kill),
    film_sec: +parts.reduce((n, p) => n + p.film_sec, 0).toFixed(1), drop_film_sec: s.drop_sec, celebration_to_sec: r1(celebrationTo),
    song_sec: +(s.duration_sec || 0).toFixed(1), song_left_sec: +Math.max(0, (s.duration_sec || 0) - parts.reduce((n, p) => n + p.film_sec, 0)).toFixed(1), slow, why_slow: slow ? (sudden || 'always on') : null, stomp,
    victim: name(last.v), killer: last.k !== undefined ? name(last.k) : null, song: s.song_id || null, song_words: s.words || 'normal', soft_duck: !!s.soft_duck
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
    `- The song is "${w.song || 'the finale song'}"${w.song_words === 'few' ? ': a feel song, so the fight carries at most ONE short line, and silence is better' : w.song_words === 'none' ? ': no words at all over it' : ''}.${w.song_words !== 'normal' && w.song_left_sec > 0 ? ` It keeps playing ${w.song_left_sec} s into the celebration: no narration there before ${w.song_left_sec} s (the picture carries the win), and nothing at all if the celebration is shorter than that.` : ''}`,
    `- The drop lands on ${w.stomp ? `the Stomper's leap: he drops ${Math.round(w.stomp.height)} blocks onto his victim, filmed from above` : 'the first hit'} (\`finale_fight\`)${w.parts.length > 2 ? '; the film then cuts to the last blows and the kill (`finale_kill`)' : ', which runs through the kill'}. You may narrate the fight here as you normally would (one or two lines, starting at least 0.5 s after the segment begins); do not announce the kill before it happens.`,
    '- The program sets the speed, the music and the face shots; do not add "speed", "music" or "shots" to these segments.',
    `- The segment right after is the winner's celebration: it starts at ${w.to_sec}s and ends at ${w.celebration_to_sec}s (the winner's moment on the cake tower: it is cut short if they hop off or stand still, so the end card comes before attention drifts), real speed, music "triumphant", and carries the lines about how it ended and the closing line about the winner.`, '')
  return L.join('\n')
}

module.exports = { noteSong, recentSongs, songs, TRACK_ID, config, song, plan, toMarkdown, findSong, energeticStart }
