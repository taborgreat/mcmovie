'use strict'
// Match mode build: doc.json (the narration plan) + a recording -> the same
// stage files the staged-movie pipeline produces (replay per scene,
// timeline.json, voice.json, cast.json), so render / voice / assemble run
// unchanged. Nothing is shot: the "replay" is cut straight out of the
// recorded match, and the world comes from the match's own region files.
const path = require('path')
const Ajv = require('ajv')
const U = require('../util')
const S = require('../speeds')
const R = require('./recording')
const { AnvilWorld, TARGET_VERSION } = require('./anvil')
const { autoShots, stompShots } = require('./autoshots')
const { ReplayWriter, replayPath, actorResolver } = require('../mc/replay')
const { editScene, pickMusic, musicCues } = require('../timeline')
const { referencedActors } = require('../camera')
const formats = require('../formats')
const playerVoices = require('../voice/players')
const copy = require('../publish/copy')

const validateDoc = new Ajv({ allErrors: true, strict: false }).compile(require('../schemas/doc.schema.json'))
const DYING_TICKS = 24

// Entity type names the renderer has models for differ slightly from Bukkit's.
const ENTITY_NAMES = { spectral_arrow: 'arrow', tipped_arrow: 'arrow', fishing_hook: 'fishing_bobber', small_fireball: 'fireball', splash_potion: 'egg', potion: 'egg', wind_charge: 'snowball' }

function blockEvents (rec, mapper) {
  const out = []
  for (const e of rec.events) {
    if (e.type === 'block') out.push({ t: e.t, x: e.x, y: e.y, z: e.z, from: mapper.fromString(e.from), to: mapper.fromString(e.to) })
    else if (e.type === 'explosion') for (const b of e.blocks || []) out.push({ t: e.t, x: b[0], y: b[1], z: b[2], from: mapper.fromString(b[3]), to: 0 })
  }
  return out // already in time order (events file is appended in order)
}

// The same changes with their block names as recorded, for the studio (lib/studio/perform.js),
// which sets real blocks on a real server instead of renderer state ids.
function rawBlockEvents (rec) {
  const out = []
  for (const e of rec.events) {
    if (e.type === 'block') out.push({ t: e.t, x: e.x, y: e.y, z: e.z, from: e.from, to: e.to, how: e.how || null })
    else if (e.type === 'explosion') for (const b of e.blocks || []) out.push({ t: e.t, x: b[0], y: b[1], z: b[2], from: b[3], to: 'minecraft:air', how: 'explosion' })
  }
  return out
}

// Kit abilities. The plugin logs an `ability` line whenever a player's kit is allowed to act,
// and the studio answers each one by running the plugin's own ability code for that player at
// that tick (lib/studio/perform.js). The line only says "allowed": a click during a cooldown
// logs one too. So where an ability always leaves a mark of its own in the recording (Thor's
// and the Flash's bolt, the jump into the Gladiator's arena), the mark decides: no mark, no
// ability; and the mark is where the ability is aimed. `stands_in` means the plugin's ability
// draws that mark itself, so the studio does not also replay the recorded one.
const ABILITY_MARKS = {
  thor: { type: 'lightning', before: 3, after: 5, reach: 80, need: true, stands_in: true },
  flash: { type: 'lightning', before: 3, after: 5, reach: 80, need: true, stands_in: true },
  gladiator: { type: 'teleport', own: true, before: 3, after: 5, need: true },
  pyro: { type: 'explosion', before: 0, after: 60, reach: 80 } // where the fireball came down
}
function abilityEffects (rec) {
  const out = []
  const taken = new Set()
  const byType = {}
  for (const e of rec.events) if (e.x !== undefined && (e.type === 'lightning' || e.type === 'teleport' || e.type === 'explosion')) (byType[e.type] = byType[e.type] || []).push(e)
  for (const a of rec.events) {
    if (a.type !== 'ability' || !rec.players[a.p] || !a.kit) continue
    const p = rec.players[a.p]
    const s = R.sampleAt(p.track, a.t, 20)
    const at = a.x !== undefined ? a : s
    if (!at) continue
    const fx = { type: 'ability', player: p.name, kit: a.kit, x: at.x, y: at.y, z: at.z }
    const mark = ABILITY_MARKS[a.kit]
    let found = null
    if (mark) {
      for (const e of byType[mark.type] || []) {
        if (e.t < a.t - mark.before || e.t > a.t + mark.after || taken.has(e)) continue
        if (mark.own ? e.p !== a.p : Math.hypot(e.x - at.x, e.z - at.z) > mark.reach) continue
        if (!found || Math.abs(e.t - a.t) < Math.abs(found.t - a.t)) found = e
      }
      if (!found && mark.need) continue
      if (found) { taken.add(found); if (mark.type !== 'teleport') fx.aim = [found.x, found.y, found.z]; if (mark.stands_in) found.kit = a.kit }
    }
    out.push({ t: a.t, fx })
  }
  return out
}

// Narrator lines that quote a measurement: a number next to blocks, damage, hp or seconds.
const NUMBER = '(?:\\d[\\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)'
const RAW = new RegExp(`\\b${NUMBER}(?:[- ]${NUMBER})*\\b(?:\\s+(?:and|a|of|more|whole|full|long))?\\s+(?:blocks?|damage|hp|hit points?|health points?|seconds?)\\b`, 'i')
function rawDataLines (doc) {
  const out = []
  for (const seg of doc.segments || []) {
    for (const l of seg.narration || []) {
      if (l.chat || (l.speaker && l.speaker !== 'narrator')) continue
      if (RAW.test(String(l.text || ''))) out.push({ seg: seg.id, text: l.text, line: l })
    }
  }
  return out
}

// The finale's speed, music and face shots belong to the program, not the planner.
// strategy: the project's strategy.json, if any; it names the finale song
function applyFinale (doc, rec, strategy = null) {
  const finale = require('./finale')
  const want = strategy && strategy.knobs && strategy.knobs.music ? strategy.knobs.music.finale_song : null
  const w = finale.plan(rec, finale.song(want || null))
  if (!w) return null
  for (const seg of doc.segments || []) {
    if (!seg.finale) continue
    const part = w.parts.find(p => p.id === seg.id)
    seg.speed = part ? part.speed : w.parts[0].speed
    seg.music = { track_id: finale.TRACK_ID }
    if (part && part.role === 'build') {
      // across both faces, half the build-up each: in front of the player, looking back at them
      const half = +(part.film_sec / 2).toFixed(2)
      // far enough that head and shoulders sit in the frame with room around them, and steady:
      // the camera eases after the player rather than copying every step
      const face = (id, who, a, b, side) => ({ id, start_sec: a, end_sec: b, fov: 60, path: { type: 'follow', actor: who, rel: { back: -3.6, up: 1.75, right: side }, look: who, smoothing: 0.55, look_smoothing: 0.3 } })
      const two = [w.killer, w.victim].filter(Boolean)
      seg.shots = two.length === 2 ? [face('f1', two[0], 0, half, 0.8), face('f2', two[1], half, part.film_sec, -0.8)] : [face('f1', two[0], 0, part.film_sec, 0.8)]
    } else delete seg.shots
    // a Stomper's kill is filmed from above, from the leap to the hit (the camera is placed
    // against the terrain when the segment is built)
    if (part && part.role !== 'build' && w.stomp && seg.from_sec <= w.kill_sec && seg.to_sec >= w.kill_sec) seg.stomp = { ...w.stomp, killer: w.killer, victim: w.victim }
    else delete seg.stomp
  }
  return w
}

function finaleErrors (doc, rec, w) {
  const errors = []
  const segs = doc.segments || []
  const hint = 'Copy the segments under "The finale" at the bottom of digest.md.'
  const found = []
  for (const part of w.parts) {
    const seg = segs.find(s => s.finale && s.id === part.id)
    if (!seg) { errors.push(`doc.json needs the finale segment "${part.id}" ("finale": true, from_sec ${part.from_sec}, to_sec ${part.to_sec}). ${hint}`); continue }
    found.push(seg)
    if (Math.abs(seg.from_sec - part.from_sec) > 0.3 || Math.abs(seg.to_sec - part.to_sec) > 0.3) errors.push(`${part.id} must run from_sec ${part.from_sec} to_sec ${part.to_sec} exactly (it is cut to the song); it has ${seg.from_sec} to ${seg.to_sec}`)
    const lines = seg.narration || []
    if (part.role === 'build' && lines.length) errors.push(`${part.id} is the song's build-up on the players' faces: nothing is spoken in it (it has ${lines.length} line${lines.length > 1 ? 's' : ''}); move them to the segment before`)
    const allowed = w.song_words === 'none' ? 0 : w.song_words === 'few' ? 1 : 2
    if (part.role !== 'build' && lines.filter(l => !l.chat).length > allowed) errors.push(`${part.id} carries at most ${allowed === 0 ? 'no narration' : allowed === 1 ? 'one short narration line' : 'two narration lines'} under "${w.song}"${allowed < 2 ? ' (a feel song: the picture and the song carry it)' : ''}; the music does the talking`)
    if (part.role !== 'build') for (const l of lines) if (l.at_sec < 0.5) errors.push(`${part.id} line ${l.id}: start it at least 0.5 s in, so the drop lands clean`)
  }
  for (const s of segs) if (s.finale && !w.parts.some(p => p.id === s.id)) errors.push(`segment ${s.id} is marked "finale" but is not one of ${w.parts.map(p => p.id).join(', ')}`)
  if (found.length !== w.parts.length) return errors
  for (let i = 1; i < found.length; i++) if (segs.indexOf(found[i]) !== segs.indexOf(found[i - 1]) + 1) errors.push('the finale segments must sit together, in order: ' + w.parts.map(p => p.id).join(', '))
  for (const s of segs) {
    if (s.finale || !(s.from_sec < w.to_sec - 0.2 && s.to_sec > w.from_sec + 0.2)) continue
    // the one allowed overlap: a teaser of the kill as the very first segment, two to four seconds
    if (s.teaser && segs[0] === s) {
      const len = s.to_sec - s.from_sec
      if (len < 1.5 || len > 4.5) errors.push(`teaser ${s.id} must be two to four seconds long (it is ${len.toFixed(1)})`)
      // a glimpse, not the result: it ends on the blow (the fall, the swing), never shows the death
      if (!(s.from_sec < w.kill_sec - 0.8 && s.to_sec >= w.kill_sec - 0.2 && s.to_sec <= w.kill_sec + 0.25)) errors.push(`teaser ${s.id} must run up to the final blow and end on it (end between ${(w.kill_sec - 0.2).toFixed(1)} and ${(w.kill_sec + 0.25).toFixed(1)}s), never past it: the teaser hints, it does not spoil`)
      if (s.speed && s.speed !== 1) errors.push(`teaser ${s.id} runs at real speed`)
      continue
    }
    if (s.teaser) errors.push(`segment ${s.id}: only the first segment may be a teaser`)
    errors.push(`segment ${s.id} overlaps the finale (${w.from_sec}s to ${w.to_sec}s); end it at ${w.from_sec} or start it at ${w.to_sec}`)
  }
  // the song starts in silence: whoever was talking has finished
  const first = segs.indexOf(found[0]); const before = segs[first - 1]
  if (before) {
    const len = (before.to_sec - before.from_sec) / (before.speed || 1)
    for (const l of before.narration || []) {
      const ends = l.at_sec + S.estimateLineSeconds(String(l.text || ''))
      if (ends > len - 0.2) errors.push(`segment ${before.id} line ${l.id} is still being spoken when the finale song starts (it ends about ${ends.toFixed(1)}s into a ${len.toFixed(1)}s segment); move it earlier or shorten it`)
    }
  }
  const lastI = segs.indexOf(found[found.length - 1])
  const after = segs[lastI + 1]
  const left = rec.meta.ticks / 20 - w.to_sec
  if (left > 3 && (!after || Math.abs(after.from_sec - w.to_sec) > 1)) errors.push(`the segment right after the finale must be the winner's celebration, starting at ${w.to_sec}s and running to the end of the match (${(rec.meta.ticks / 20).toFixed(1)}s) with music "triumphant"`)
  if (after && w.celebration_to_sec && after.to_sec > w.celebration_to_sec + 0.5) errors.push(`the celebration (${after.id}) must end at ${w.celebration_to_sec}s, not ${after.to_sec}s: that is when the winner stops doing anything on the tower, and the film should reach its end card`)
  if (lastI < segs.length - 2) errors.push('the finale is the last fight: only the celebration may come after it')
  return errors
}

// The sky at a moment of the match. Newer recordings log the world's clock and weather (at the
// start, every 30 s and on every change); older ones only let us assume noon at the start.
function skyAt (rec, t) {
  let last = null
  for (const e of rec.events) { if (e.type !== 'sky') continue; if (e.t > t) break; last = e }
  if (!last) return { time: (6000 + t) % 24000, weather: 'clear' }
  const time = last.running === false ? last.time : (((last.time + (t - last.t)) % 24000) + 24000) % 24000
  return { time, weather: last.thunder ? 'thunder' : (last.storm ? 'rain' : 'clear') }
}

// opts.strategy: the project's strategy.json (lib/strategy); its rules are checked too.
// opts.digest: the digest object, for the strategy checks that look at moments.
// Where a plan's effect lands, in scene ticks: at_sec as written, or `on` snapped to the first
// death / first player hit inside the segment, its start, or its end; a clip with a beat
// (lead_sec) starts early so the beat lands on the moment. Returns [{ id, tick }].
function resolveStings (seg, rec, from, to, speed) {
  let known = {}
  try { known = Object.fromEntries(require('../media').catalogue().map(m => [m.id, m])) } catch { known = {} }
  const out = []
  for (const st of seg.stings || []) {
    const def = known[st.id] || {}
    const len = (to - from) / speed / 20
    let at = st.at_sec
    if (at === undefined || at === null) {
      const on = st.on || def.on || 'start'
      let t = null
      if (on === 'death') { const e = rec.events.find(e => e.type === 'death' && e.t >= from && e.t <= to); t = e ? e.t : null }
      else if (on === 'hit') { const e = rec.events.find(e => e.type === 'hit' && e.t >= from && e.t <= to && e.me === undefined); t = e ? e.t : null }
      else if (on === 'end') at = Math.max(0, len - (def.seconds || 3))
      else at = 0.5
      if (t !== null) at = (t - from) / speed / 20
      else if (at === undefined) at = 0.5
    }
    at = Math.max(0, at - (def.lead_sec || 0))
    out.push({ id: st.id, tick: Math.round(at * 20), on: st.on || null })
  }
  return out
}

function check (doc, rec, format, opts = {}) {
  const errors = []; const warnings = []
  if (!validateDoc(doc)) for (const e of validateDoc.errors) errors.push(`${e.instancePath || '/'} ${e.message}`)
  if (errors.length) return { errors, warnings }
  const finaleWindow = applyFinale(doc, rec, opts.strategy || null)
  if (finaleWindow) errors.push(...finaleErrors(doc, rec, finaleWindow))
  if (opts.strategy) errors.push(...require('../strategy/check').check(doc, opts.strategy, opts.digest || {}))
  // effects the plan calls for must exist, be on offer under the strategy's register, land inside
  // their segment at a moment that exists, stay out of the teaser and finale, and be rare
  try {
    const fxKnob = (opts.strategy && opts.strategy.knobs && opts.strategy.knobs.effects) || {}
    const register = fxKnob.register || 'clean'
    const maxFx = fxKnob.max !== undefined ? fxKnob.max : (register === 'memed' ? 3 : 1)
    const all = Object.fromEntries(require('../media').catalogue().map(m => [m.id, m]))
    const known = Object.fromEntries(require('../media').stings(register).map(m => [m.id, m]))
    let count = 0
    const segs = doc.segments || []
    for (const seg of segs) {
      if (seg.transition) {
        count++
        const tdef = known[seg.transition]
        if (!tdef) errors.push(`segment ${seg.id}: no transition called "${seg.transition}" on offer${all[seg.transition] && all[seg.transition].register === 'memed' ? ' (a meme; this strategy is clean)' : ''}`)
        else if (tdef.type !== 'transition') errors.push(`segment ${seg.id}: ${seg.transition} is not a transition; put it in "stings"`)
        if (seg === segs[0]) errors.push(`segment ${seg.id}: a transition wipes into a segment from the one before; the first segment has none`)
      }
      for (const st of seg.stings || []) {
      count++
      const len = (seg.to_sec - seg.from_sec) / (seg.speed || 1)
      if (!known[st.id]) { errors.push(`segment ${seg.id}: no effect called "${st.id}" on offer${all[st.id] && all[st.id].register === 'memed' ? ' (a meme; this strategy is clean)' : all[st.id] && all[st.id].type === 'transition' ? ' (a transition: "transition": "' + st.id + '" on the segment it wipes into)' : ' (the digest lists the ones you may use)'}`); continue }
      if (known[st.id].type === 'transition') { errors.push(`segment ${seg.id}: ${st.id} is a transition: put "transition": "${st.id}" on the segment it wipes into, not in "stings"`); continue }
      if (st.at_sec === undefined && !st.on && !known[st.id].on) errors.push(`segment ${seg.id}: effect ${st.id} needs "at_sec" or "on"`)
      if (st.on === 'death' || (st.at_sec === undefined && !st.on && known[st.id].on === 'death')) { if (!(rec.events || []).some(e => e.type === 'death' && e.t >= seg.from_sec * 20 && e.t <= seg.to_sec * 20)) errors.push(`segment ${seg.id}: effect ${st.id} lands on a death, but nobody dies in this segment`) }
      if (st.on === 'hit' || (st.at_sec === undefined && !st.on && known[st.id].on === 'hit')) { if (!(rec.events || []).some(e => e.type === 'hit' && e.me === undefined && e.t >= seg.from_sec * 20 && e.t <= seg.to_sec * 20)) errors.push(`segment ${seg.id}: effect ${st.id} lands on a hit, but no player hits another in this segment`) }
      if (st.at_sec !== undefined && st.at_sec > len - 1) errors.push(`segment ${seg.id}: effect ${st.id} at ${st.at_sec}s is past the segment's ${len.toFixed(1)}s of film`)
      if (st.at_sec !== undefined && st.at_sec < 0.5 && known[st.id].pause) errors.push(`segment ${seg.id}: sting ${st.id} at ${st.at_sec}s; the moment needs to be seen first (0.5s in at least)`)
      if ((seg.teaser || seg.finale || /^finale_/.test(seg.id)) && !known[st.id].allow_finale) errors.push(`segment ${seg.id}: ${st.id} belongs mid-game, not in the teaser or the finale`)
      if (!known[st.id].pause) continue
      // nobody talks over it: a line may not start inside it, and one already speaking must have finished
      const stingLen = known[st.id].seconds || 8
      for (const l of seg.narration || []) {
        const at = l.at_sec !== undefined ? l.at_sec : null
        if (at === null) continue
        const words = String(l.text || '').split(/\s+/).filter(Boolean).length
        const ends = at + words / 2.6
        if (at >= st.at_sec - 0.3 && at < st.at_sec + stingLen) errors.push(`segment ${seg.id}: line "${String(l.text).slice(0, 40)}" starts at ${at}s, inside the ${st.id} sting (${st.at_sec}s, ${stingLen}s long); nobody talks over a sting`)
        else if (at < st.at_sec && ends > st.at_sec + 0.2) errors.push(`segment ${seg.id}: line "${String(l.text).slice(0, 40)}" (${at}s, about ${ends.toFixed(1)}s) is still being said when the ${st.id} sting lands at ${st.at_sec}s`)
      }
    }
    }
    if (count > maxFx) errors.push(`${count} effects (stings and transitions) in one film; at most ${maxFx} under this strategy`)
  } catch (e) { errors.push('effects could not be checked: ' + e.message) }
  errors.push(...copy.problems(doc.title, doc.logline))
  const names = new Set(rec.players.map(p => p.name))
  // common misspellings and doubled words in narration (lib/match/proofread.js, from Max's pull request)
  errors.push(...require('./proofread').problems(doc, [...names]))
  const playerLines = (opts.strategy && opts.strategy.knobs && opts.strategy.knobs.narration && opts.strategy.knobs.narration.player_lines) || 'any'
  const total = rec.meta.ticks / 20
  const ids = new Set()
  let video = 0
  for (const seg of doc.segments) {
    if (ids.has(seg.id)) errors.push(`duplicate segment id ${seg.id}`)
    ids.add(seg.id)
    if (seg.to_sec <= seg.from_sec) errors.push(`segment ${seg.id}: to_sec must be after from_sec`)
    if (seg.to_sec > total + 1) errors.push(`segment ${seg.id}: to_sec ${seg.to_sec} is past the end of the match (${total.toFixed(1)}s)`)
    for (const f of seg.focus) if (!names.has(f)) errors.push(`segment ${seg.id}: focus "${f}" is not a player in this match (${[...names].join(', ')})`)
    const onRecord = seg.focus.map(f => rec.players.find(p => p.name === f)).filter(p => p && p.first !== null && p.first <= seg.to_sec * 20 && p.last >= seg.from_sec * 20)
    if (seg.focus.every(f => names.has(f)) && !onRecord.length) errors.push(`segment ${seg.id}: none of ${seg.focus.join(', ')} are on the record between ${seg.from_sec}s and ${seg.to_sec}s (they were out, or gone, by then); pick players who are alive in that window or move the window`)
    else for (const f of seg.focus) { const p = rec.players.find(x => x.name === f); if (p && p.last !== null && p.last < seg.from_sec * 20) warnings.push(`segment ${seg.id}: ${f} is already out at ${seg.from_sec}s (last seen ${(p.last / 20).toFixed(0)}s)`) }
    const len = (seg.to_sec - seg.from_sec) / (seg.speed || 1)
    video += len
    const lines = (seg.narration || []).slice().sort((a, b) => a.at_sec - b.at_sec)
    for (let i = 0; i < lines.length; i++) {
      const est = S.estimateLineSeconds(lines[i].text)
      const sp = lines[i].speaker
      if (sp && sp !== 'narrator' && !names.has(sp)) errors.push(`segment ${seg.id}: narration ${lines[i].id} speaker "${sp}" is not a player in this match`)
      if (lines[i].chat && sp && !rec.events.some(e => e.type === 'chat' && e.name === sp && e.text.trim().toLowerCase() === lines[i].text.trim().toLowerCase())) warnings.push(`segment ${seg.id}: ${lines[i].id} is marked chat but ${sp} never said exactly that`)
      if (lines[i].chat && (!sp || sp === 'narrator')) errors.push(`segment ${seg.id}: ${lines[i].id} is marked chat but has no player speaker`)
      // Max's rule, as a mode: under a strategy whose narration.player_lines is chat-only, a player speaks only what they really typed
      if (playerLines === 'chat-only' && sp && sp !== 'narrator' && !lines[i].chat) errors.push(`segment ${seg.id}: ${lines[i].id} puts invented words in ${sp}'s mouth; this strategy allows players only their recorded chat ("chat": true, word for word)`)
      if (lines[i].at_sec > len) errors.push(`segment ${seg.id}: narration ${lines[i].id} starts at ${lines[i].at_sec}s but the segment is ${len.toFixed(1)}s long`)
      if (i + 1 < lines.length && lines[i + 1].at_sec < lines[i].at_sec + est - 0.3) warnings.push(`segment ${seg.id}: narration ${lines[i + 1].id} starts before ${lines[i].id} probably ends (~${(lines[i].at_sec + est).toFixed(1)}s)`)
    }
    if (Array.isArray(seg.shots)) {
      for (const sh of seg.shots) for (const a of referencedActors({ path: sh.path })) if (!names.has(a)) errors.push(`segment ${seg.id} shot ${sh.id}: unknown player ${a}`)
      if (seg.shots.length && Math.min(...seg.shots.map(s => s.start_sec)) > 0) errors.push(`segment ${seg.id}: the first shot must start at 0`)
    }
  }
  // the ending must be in the film
  const deaths = rec.events.filter(e => e.type === 'death')
  const last = deaths[deaths.length - 1]
  if (last && !doc.segments.some(s => s.from_sec * 20 <= last.t && last.t <= s.to_sec * 20)) errors.push(`the final kill at ${(last.t / 20).toFixed(1)}s is not inside any segment; the film must show the ending`)
  const fmt = formats.get(format || doc.format)
  if (video < fmt.min_sec * 0.85 || video > fmt.max_sec * 1.1) warnings.push(`film runs ${video.toFixed(0)}s; a ${fmt.id} should be ${fmt.min_sec}-${fmt.max_sec}s`)
  if (fmt.id === 'short' && video > 175) errors.push(`film runs ${video.toFixed(0)}s; a Short cannot exceed 3 minutes`)
  for (const seg of doc.segments || []) if (!seg.finale && seg.speed !== undefined && seg.speed !== 1) errors.push(`segment ${seg.id} sets "speed": ${seg.speed}. Everything plays at real speed: a player running at triple speed looks like a glitch, not a time-lapse. Remove "speed" and choose the seconds that matter (for a long build or a long walk, show its last few seconds and say the rest)`)
  // Nothing the ending depends on may be skipped (digest.md, "Must be on screen").
  try {
    for (const m of require('./insight').build(rec).must_show || []) {
      const want = m.to_sec - m.from_sec
      const got = (doc.segments || []).reduce((n, seg) => n + Math.max(0, Math.min(seg.to_sec, m.to_sec) - Math.max(seg.from_sec, m.from_sec)), 0)
      if (got < want * 0.7) errors.push(`the film skips something the ending depends on: ${m.what} (${m.from_sec}s to ${m.to_sec}s of the match). Add a segment covering those seconds, lead-up included, before the finale; make room by shortening an explanation, not this.`)
    }
  } catch (e) { warnings.push('could not check the story beats: ' + e.message) }
  // A number now and then is good colour; number after number is a stats readout
  // (prompts/match.md, "Narration"). So: no two data lines in a row, and no more than
  // about one narrator line in three.
  const raw = rawDataLines(doc)
  const flags = []
  for (const seg of doc.segments || []) for (const l of seg.narration || []) if (!l.chat && (!l.speaker || l.speaker === 'narrator')) flags.push(raw.some(r => r.line === l))
  const allowed = Math.max(2, Math.floor(flags.length / 3))
  const run = flags.some((f, i) => f && flags[i + 1])
  if (raw.length > allowed || run) errors.push(`the narration ${run ? 'has data lines back to back' : 'leans on raw data'} (${raw.length} of ${flags.length} narrator lines quote blocks, damage, hp or seconds; at most ${allowed}, and never two in a row): ${raw.slice(0, 6).map(r => `[${r.seg}] "${r.text}"`).join(' | ')}. Keep the one or two numbers that land hardest and say the rest the way a caster would: hearts and how close to death, places and effort (the forcefield, across the map, right behind him), moments. See "Narrate the data" in prompts/match.md and "In plain words" at the bottom of digest.md.`)
  return { errors, warnings, video_sec: video }
}

// Feet height on the saved terrain near y, for players walked between sparse samples.
// The standing place closest to the height the path already has, so a walker passing a tree
// stays on the ground under it instead of popping up onto the canopy. Leaves only count as
// footing when the path is already at their height (someone really is up in the tree).
function standY (world, x, y, z) {
  const bx = Math.floor(x); const bz = Math.floor(z)
  const hard = { leaves: false }
  // in water the path is a swimmer's: leave it where it is instead of dropping it to the bed
  if (world.isLiquid && (world.isLiquid(bx, Math.floor(y + 0.4), bz) || world.isLiquid(bx, Math.floor(y - 0.3), bz))) return y
  let best = null
  for (let yy = Math.floor(y) + 3; yy >= Math.floor(y) - 5; yy--) {
    const feet = yy + 1
    const onLeaves = !world.isSolid(bx, yy, bz, hard) && world.isSolid(bx, yy, bz)
    if (!world.isSolid(bx, yy, bz)) continue
    if (onLeaves && Math.abs(feet - y) > 0.75) continue
    if (world.isSolid(bx, yy + 1, bz, hard) || world.isSolid(bx, yy + 2, bz, hard)) continue
    const d = Math.abs(feet - y)
    if (best === null || d < best.d - 1e-6) best = { feet, d }
  }
  // A footing far from the path is not where this walker is: mid-fall or mid-jump the path is
  // already right, and snapping it to ground several blocks away is the pop we are avoiding.
  return best && best.d <= 1.6 ? best.feet : y
}

// A point that ended up inside a trunk or a wall (the price of connecting sparse dots):
// step sideways to the nearest free column.
function unstick (world, x, y, z) {
  // trunks and walls block a walker; the leafy edge of a canopy does not
  const blocked = (px, pz) => world.isSolid(px, y + 0.3, pz, { leaves: false }) || world.isSolid(px, y + 1.3, pz, { leaves: false })
  if (!blocked(x, z)) return { x, z }
  for (const r of [0.7, 1.2, 1.8]) {
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4
      const px = x + Math.cos(a) * r; const pz = z + Math.sin(a) * r
      if (!blocked(px, pz)) return { x: px, z: pz }
    }
  }
  return { x, z }
}

const skinModels = new Map(require('../skins').readRoster().players.map(x => [x.name.toLowerCase(), x.model]))
function playerState (rec, p, idx, mt, speed, deathTick, world) {
  let s = R.sampleAt(p.track, mt)
  let dying = 0
  if (!s) {
    if (deathTick === null || p.last === null || mt <= p.last || mt > deathTick + DYING_TICKS) return null
    s = { ...p.track[p.track.length - 1] }
    dying = U.clamp((mt - p.last) / DYING_TICKS, 0.05, 1)
  }
  // A teleport happens on its own tick. Between that tick and the next recorded position the
  // player is already at the destination: without this they would arrive up to a second late
  // (a portal that pulls someone up half a second after it opens).
  for (const tp of (rec._tpBy && rec._tpBy.get(idx)) || []) {
    if (mt < tp.t || mt - tp.t > 60) continue
    const next = p.track.find(q => q.t > tp.t)
    if (!next || mt < next.t) { s = { ...s, x: tp.x, y: tp.y, z: tp.z, sparse: false, speed: 0 }; break }
  }
  const F = R.FLAGS
  let step // blocks moved over 2 ticks
  if (s.sparse) {
    step = (s.speed || 0) * 2
    if (!(s.flags & (F.SWIMMING | F.GLIDING | F.IN_VEHICLE))) {
      const free = unstick(world, s.x, s.y, s.z)
      s.x = free.x; s.z = free.z
      s.y = standY(world, s.x, s.y, s.z)
      // nobody crosses the map at a flat glide: at running speed, players sprint-jump
      if ((s.speed || 0) > 0.27 && !dying) { const hop = (mt % 12) / 12; s.y += 4 * 1.1 * hop * (1 - hop) }
    }
  } else {
    const prev = R.sampleAt(p.track, mt - 2)
    step = prev ? Math.hypot(s.x - prev.x, s.z - prev.z) : 0
  }
  const moving = !dying && step > 0.06
  // a swing or hit inside the span this frame covers
  let swing = (s.flags & F.SWUNG) ? 1 : 0; let hurt = (s.flags & F.HURT) ? 1 : 0
  if (!swing && rec._hitsBy && (rec._hitsBy.get(idx) || []).some(t => t > mt - Math.max(1, speed) && t <= mt)) swing = 1
  if (speed > 1) for (let t = mt - speed; t < mt; t += rec.sampleTicks) { const q = R.sampleAt(p.track, t); if (q) { if (q.flags & F.SWUNG) swing = 1; if (q.flags & F.HURT) hurt = 1 } }
  // sprint by flag, or by speed when the client never reported the flag (> ~5 blocks/s)
  const sprinting = moving && ((s.flags & F.SPRINTING) || step > 0.5)
  const anim = (s.flags & F.SNEAKING) ? 'sneak' : (sprinting ? 'sprint' : (moving ? 'walk' : 'idle'))
  const st = {
    id: idx + 1, username: p.name, name: 'player',
    x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3),
    yaw: +U.mcYawToMf(s.yaw).toFixed(4), pitch: +U.mcPitchToMf(s.pitch).toFixed(4),
    anim, moving: moving ? 1 : 0, swing: dying ? 0 : swing, held: R.heldAt(p, mt) || null, dead: 0, skin: p.anon ? null : p.name, model: p.anon ? 'classic' : (skinModels.get(p.name.toLowerCase()) || 'classic'), hp: s.hp
  }
  const worn = R.armorAt(p, mt)
  if (worn) st.armor = worn
  if (hurt && !dying) st.hurt = 1
  if (dying) st.dying = +dying.toFixed(2)
  if (s.flags & F.INVISIBLE) st.invisible = 1
  return st
}

function build (dir, opts = {}) {
  const doc = U.readJson(path.join(dir, 'doc.json'))
  const recRef = U.exists(path.join(dir, 'recording.txt')) ? require('fs').readFileSync(path.join(dir, 'recording.txt'), 'utf8').trim() : (doc.recording || 'latest')
  const rec = R.load(recRef)
  const strategy = require('../strategy/select').read(dir)
  const digest = U.exists(path.join(dir, 'digest.json')) ? U.readJson(path.join(dir, 'digest.json')) : {}
  const report = check(doc, rec, formats.ofProject(dir, opts.format).id, { strategy, digest })
  const finaleWindow = applyFinale(doc, rec, strategy)
  if (report.errors.length) return { ok: false, ...report }
  const world = new AnvilWorld(rec.regionDir)
  const changes = blockEvents(rec, world.mapper)
  const rawChanges = rawBlockEvents(rec)
  // The winner's cake tower is built by the plugin, not by a player. Recordings from before the
  // plugin logged its own blocks have it in the saved map with no record of when it appeared,
  // so it would hang in the sky all match. Work it out: whatever stands around the spot the
  // winner is lifted to did not exist before that moment.
  if (!rec.events.some(e => e.type === 'block' && e.how === 'plugin')) {
    const lastDeath = rec.events.filter(e => e.type === 'death').pop()
    const lift = lastDeath && rec.events.find(e => e.type === 'teleport' && e.t >= lastDeath.t && e.cause === 'plugin' && e.x !== undefined)
    if (lift) {
      const bx = Math.floor(lift.x); const by = Math.floor(lift.y); const bz = Math.floor(lift.z)
      // only the ceremony's own blocks: the cakes, the invisible rail, and the slab they sit on.
      // A player's tower can stand right beside it and must be left alone.
      const theirs = new Set(rawChanges.map(c => `${c.x},${c.y},${c.z}`))
      const nameAt = (x, y, z) => { const id = world.stateIdAt(x, y, z); return id ? world.blockName(id) : 'air' }
      for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = -4; dy <= 4; dy++) {
        const x = bx + dx; const y = by + dy; const z = bz + dz
        const name = nameAt(x, y, z)
        if (name === 'air' || name === 'cave_air' || theirs.has(`${x},${y},${z}`)) continue
        const above = nameAt(x, y + 1, z)
        if (!(name === 'cake' || name === 'barrier' || above === 'cake' || above === 'barrier')) continue
        const id = world.stateIdAt(x, y, z)
        rawChanges.push({ t: lift.t - 1, x, y, z, from: 'minecraft:air', to: 'minecraft:' + name, how: 'plugin' })
        changes.push({ t: lift.t - 1, x, y, z, from: 0, to: id })
      }
      rawChanges.sort((a, b) => a.t - b.t); changes.sort((a, b) => a.t - b.t)
    }
  }
  // when each player landed a blow (on a player or a creature)
  rec._hitsBy = new Map()
  for (const e of rec.events) if ((e.type === 'hit' || e.type === 'mobhit') && e.a !== undefined) { if (!rec._hitsBy.has(e.a)) rec._hitsBy.set(e.a, []); rec._hitsBy.get(e.a).push(e.t) }
  // where and when each player was teleported, to the tick
  rec._tpBy = new Map()
  for (const e of rec.events) if (e.type === 'teleport' && e.x !== undefined && e.p !== undefined) { if (!rec._tpBy.has(e.p)) rec._tpBy.set(e.p, []); rec._tpBy.get(e.p).push(e) }
  // does this recording say which creature was involved in each blow? (newer plugin builds do)
  const mobMarks = rec.events.some(e => e.type === 'ability' || e.type === 'mobhit' || (e.type === 'hit' && e.me !== undefined))
  // the moments each creature landed a hit on a player, so the film can make that one swing
  const mobHits = new Map()
  for (const e of rec.events) if (e.type === 'hit' && e.me !== undefined) { if (!mobHits.has(e.me)) mobHits.set(e.me, []); mobHits.get(e.me).push(e.t) }
  // ...and the blows players landed on creatures (who struck, and whether it was the last one)
  const mobStruck = new Map()
  for (const e of rec.events) if (e.type === 'mobhit' && e.me !== undefined) { if (!mobStruck.has(e.me)) mobStruck.set(e.me, []); mobStruck.get(e.me).push({ t: e.t, by: rec.players[e.a] ? rec.players[e.a].name : null, dead: !!e.dead }) }
  const abilities = abilityEffects(rec)
  const deathTick = rec.players.map((p, i) => { const d = rec.events.find(e => e.type === 'death' && e.v === i); return d ? d.t : null })
  const notes = [...report.warnings]

  const manifestFile = path.join(U.ROOT, 'music', 'music_manifest.json')
  const manifest = U.exists(manifestFile) ? U.readJson(manifestFile) : null
  // songs a struck film used are never picked again (lib/publish/music_health.js)
  if (manifest && manifest.tracks) { try { const bad = require('../publish/music_health').suspended(); manifest.tracks = manifest.tracks.filter(t => !bad.has(t.id)) } catch { /* no record yet */ } }
  const narratorVoice = (doc.narrator && doc.narrator.voice) || 'stock:narrator'
  const cast = { characters: { narrator: { voice: narratorVoice, voice_desc: (doc.narrator && doc.narrator.voice_desc) || 'narrator, deep smooth baritone, measured, sports documentary', profile_id: narratorVoice.startsWith('stock:') ? narratorVoice.slice(6) : 'narrator', speed: (doc.narrator && doc.narrator.speed) || 1 } } }
  const timeline = {
    version: 1, mode: 'match', generated: new Date().toISOString(), title: doc.title, tick_rate: 20, fps: opts.fps || 30,
    cards: doc.cards || { title: true, end_text: 'hardcorepvp.com' }, match: { id: rec.meta.id, winner: rec.meta.winner || null },
    scenes: [], cast: cast.characters, lines: [], shots: [], cuts: [],
    music: pickMusic({ music: doc.music || { mood_tags: ['battle', 'tense'], tempo: 'fast' } }, manifest)
  }
  const voice = { version: 1, lines: [], characters: { narrator: { name: 'Narrator', voice_desc: cast.characters.narrator.voice_desc, cast: cast.characters.narrator } } }

  let offset = 0
  for (const seg of doc.segments) {
    const speed = seg.speed || 1
    const from = Math.round(seg.from_sec * 20); const to = Math.min(rec.meta.ticks, Math.round(seg.to_sec * 20))
    const D = Math.max(20, Math.round((to - from) / speed))
    const focus = seg.focus.map(n => rec.players.findIndex(p => p.name === n))

    // where the action is
    let sx = 0; let sy = 0; let sz = 0; let n = 0
    const pts = []
    for (const i of focus) for (let t = from; t <= to; t += 10) { const s = R.sampleAt(rec.players[i].track, t); if (s) { sx += s.x; sy += s.y; sz += s.z; n++; pts.push(s) } }
    if (!n) return { ok: false, errors: [`segment ${seg.id}: none of ${seg.focus.join(', ')} are on the record between ${seg.from_sec}s and ${seg.to_sec}s`], warnings: notes }
    const center = [Math.round(sx / n), Math.round(sy / n), Math.round(sz / n)]
    const spread = Math.max(...pts.map(s => Math.hypot(s.x - center[0], s.z - center[2])))
    const radius = U.clamp(Math.ceil((spread + 52) / 16), 5, 9)
    // Everything drawn must stand on loaded terrain: players, animals and camera subjects
    // further out than this belong to some other segment.
    const reach = radius * 16 - 12
    const inReach = (x, z) => Math.abs(x - center[0]) <= reach && Math.abs(z - center[2]) <= reach
    if (spread > 100) notes.push(`segment ${seg.id}: the focus players range ${spread.toFixed(0)} blocks from the centre; split it or narrow the focus`)
    const ccx = Math.floor(center[0] / 16); const ccz = Math.floor(center[2] / 16)
    const inArea = (x, z) => Math.abs(Math.floor(x / 16) - ccx) <= radius && Math.abs(Math.floor(z / 16) - ccz) <= radius

    // the world as it stood when the segment starts: undo every later change
    const later = changes.filter(c => c.t > from && inArea(c.x, c.z))
    for (let i = later.length - 1; i >= 0; i--) world.setStateId(later[i].x, later[i].y, later[i].z, later[i].from)
    const columns = []
    for (let cx = ccx - radius; cx <= ccx + radius; cx++) for (let cz = ccz - radius; cz <= ccz + radius; cz++) { const col = world.column(cx, cz); if (col) columns.push({ x: cx, z: cz, json: col.toJson() }) }

    // for the studio: what every block that changes during the match looks like when this
    // segment starts, and the changes that happen while it plays
    const rawHere = rawChanges.filter(c => inArea(c.x, c.z))
    const atStart = new Map()
    for (const c of rawHere) { const key = `${c.x},${c.y},${c.z}`; if (c.t <= from) atStart.set(key, [c.x, c.y, c.z, c.to]); else if (!atStart.has(key)) atStart.set(key, [c.x, c.y, c.z, c.from]) }
    const live = { changed: [...atStart.values()], forward: rawHere.filter(c => c.t > from && c.t <= to).map(c => [Math.round((c.t - from) / speed), c.x, c.y, c.z, c.to, c.how]) }

    const replay = new ReplayWriter({
      scene_id: seg.id, duration_ticks: D, version: TARGET_VERSION, center, radius, recorded: new Date().toISOString(),
      time_of_day: skyAt(rec, from).time, weather: skyAt(rec, from).weather, source: { match: rec.meta.id, from_tick: from, to_tick: to, speed }, live, mob_marks: mobMarks,
      actors: rec.players.map(p => ({ id: p.name, skin: p.anon ? null : p.name })),
      // each player's kit, so the studio can hand its bots the real thing
      kits: Object.fromEntries(rec.players.map(p => [p.name, p.kit || 'none']))
    })
    replay.setColumns(columns)
    let cursor = 0 // index into `later`
    const effects = rec.events.filter(e => (e.type === 'explosion' || e.type === 'lightning' || e.type === 'firework') && e.t >= from && e.t <= to)
    let fxCursor = 0
    const extras = []
    for (const e of rec.events) {
      if (e.t < from || e.t > to) continue
      if (e.type === 'teleport' && e.x !== undefined) extras.push({ t: e.t, fx: { type: 'teleport', x: e.x, y: e.y, z: e.z } })
      else if (e.type === 'stew' || e.type === 'drop') {
        const s = rec.players[e.p] && R.sampleAt(rec.players[e.p].track, e.t, 20)
        if (s) extras.push({ t: e.t, fx: e.type === 'stew' ? { type: 'stew', x: s.x, y: s.y, z: s.z } : { type: 'drop', x: s.x, y: s.y + 1.3, z: s.z, yaw: s.yaw, item: e.item, n: e.n || 1 } })
      } else if (e.type === 'death' && Array.isArray(e.drops) && e.x !== undefined) extras.push({ t: e.t + 2, fx: { type: 'loot', x: e.x, y: e.y, z: e.z, items: e.drops } })
    }
    for (const a of abilities) if (a.t >= from && a.t <= to) extras.push(a)
    extras.sort((a, b) => a.t - b.t)
    let exCursor = 0
    for (let k = 0; k <= D; k++) {
      const mt = from + k * speed
      const actors = []
      rec.players.forEach((p, i) => {
        const st = playerState(rec, p, i, mt, speed, deathTick[i], world)
        if (st && inReach(st.x, st.z)) actors.push(st)
      })
      const ents = []
      for (const e of rec.entities.values()) {
        const s = R.sampleAt(e.track, mt)
        const blow = (mobStruck.get(e.id) || []).find(h => h.t > mt - Math.max(1, speed) && h.t <= mt)
        if (s && inReach(s.x, s.z)) ents.push({ mc: e.type, hit: blow ? (blow.by || true) : undefined, die: blow && blow.dead ? 1 : undefined, atk: (mobHits.get(e.id) || []).some(t => t > mt - Math.max(1, speed) && t <= mt) ? 1 : undefined, id: 100000 + e.id, type: 'object', name: ENTITY_NAMES[e.type] || e.type, x: s.x, y: s.y, z: s.z, yaw: U.mcYawToMf(s.yaw), pitch: U.mcPitchToMf(s.pitch), w: 0.5, h: 0.5, moving: (s.speed || 0) > 0.02 ? 1 : 0 })
      }
      const fx = []
      while (fxCursor < effects.length && effects[fxCursor].t <= mt) {
        const e = effects[fxCursor++]
        if (e.t > mt - Math.max(1, speed) && inReach(e.x, e.z)) fx.push({ type: e.type, x: e.x, y: e.y, z: e.z, n: (e.blocks || []).length, colors: e.colors, kit: e.kit })
      }
      while (exCursor < extras.length && extras[exCursor].t <= mt) { const x = extras[exCursor++]; if (inReach(x.fx.x, x.fx.z)) fx.push(x.fx) }
      const blocks = []
      while (cursor < later.length && later[cursor].t <= mt) {
        const c = later[cursor++]
        world.setStateId(c.x, c.y, c.z, c.to)
        blocks.push({ x: c.x, y: c.y, z: c.z, s: c.to })
      }
      replay.addFrame(k, actors, ents, blocks)
      if (fx.length) replay.frames[replay.frames.length - 1].x = fx
    }
    // put the world back to its final state for the next segment
    while (cursor < later.length) { const c = later[cursor++]; world.setStateId(c.x, c.y, c.z, c.to) }
    // the cameras are planned against the terrain as it stood when the segment began (a crater
    // that opens half-way through is not there yet); the world goes forward again after
    for (let i = later.length - 1; i >= 0; i--) world.setStateId(later[i].x, later[i].y, later[i].z, later[i].from)

    // cameras
    let sceneExtra = {}
    const replayObj = { frames: replay.frames }
    const actor = actorResolver(replayObj)
    const present = (name, t) => replay.frames[U.clamp(Math.round(t), 0, replay.frames.length - 1)].a.some(a => a.username === name && !a.dying)
    let shots
    if (Array.isArray(seg.shots) && seg.shots.length) {
      shots = seg.shots.map(s => ({ id: s.id, start_tick: Math.round(s.start_sec * 20), end_tick: Math.min(D, Math.round(s.end_sec * 20)), fov: s.fov || 65, path: s.path }))
    } else if (seg.stomp && seg.stomp.killer && present(seg.stomp.killer, 0)) {
      const auto = stompShots({ id: seg.id, duration: D, killer: seg.stomp.killer, victim: seg.stomp.victim && present(seg.stomp.victim, 0) ? seg.stomp.victim : null, from: seg.stomp.from, to: seg.stomp.to, ctx: { actor }, world })
      shots = auto.shots
      notes.push(...auto.notes)
    } else {
      // deaths inside the segment anchor the camera on the victim (and a player killer)
      const deaths = rec.events.filter(e => e.type === 'death' && e.t >= from && e.t <= to && rec.players[e.v] && Math.abs(e.x - center[0]) <= reach - 16 && Math.abs(e.z - center[2]) <= reach - 16).map(e => ({ tick: (e.t - from) / speed, victim: rec.players[e.v].name, killer: e.k !== undefined && rec.players[e.k] ? rec.players[e.k].name : null }))
      // explosions and lightning inside the loaded area get a wide shot of their own
      const worldEvents = effects.filter(e => e.type !== 'firework' && Math.abs(e.x - center[0]) <= reach - 16 && Math.abs(e.z - center[2]) <= reach - 16).map(e => {
        const tick = (e.t - from) / speed
        const nearby = replay.frames[U.clamp(Math.round(tick), 0, replay.frames.length - 1)].a.map(a => ({ name: a.username, d: Math.hypot(a.x - e.x, a.z - e.z) })).sort((p, q) => p.d - q.d)[0]
        return { tick, type: e.type, point: { x: e.x, y: e.y, z: e.z }, near: nearby && nearby.d < 24 ? nearby.name : null }
      })
      // the victory: once the match is decided, a wide shot of the winner on the cake tower
      // with the fireworks going up, held to the end of the segment
      const decided = rec.events.find(e => e.type === 'state' && e.state === 'ENDING' && e.t >= from && e.t < to - 40)
      const winner = rec.meta.winner ? rec.players.find(p => p.name === rec.meta.winner) : null
      // The celebration (the segment that starts where the finale ends) has its own cameras,
      // Tabor's cut: the winner's reaction over the loot, then a swoosh to the cake tower
      // where the lens rushes in on their face, circles them once and settles back as the
      // fireworks go up. The swoosh is an effect at the lift (lib/assemble).
      const celebration = finaleWindow && winner && Math.abs(seg.from_sec - finaleWindow.to_sec) < 0.35 && present(winner.name, 0)
      if (celebration) {
        const lift = rec.events.find(e => e.type === 'teleport' && e.p === winner.p && e.t >= seg.from_sec * 20 - 5 && e.t <= to)
        const tp = Math.round(U.clamp(lift ? (lift.t - from) / speed : 20, 1, Math.max(1, D - 70)))
        const at = actor(winner.name, Math.min(D - 1, tp + 12)) || actor(winner.name, D - 1)
        const a0 = Math.atan2(center[2] - at.z, center[0] - at.x) // the orbit angle that faces back over the match
        const sin = Math.sin(a0); const cos = Math.cos(a0)
        const ring = (r, h) => [+(at.x - sin * r).toFixed(2), +(at.y + h).toFixed(2), +(at.z + cos * r).toFixed(2)]
        const rush = 16; const spin = 48
        shots = []
        if (tp > 6) shots.push({ id: 'c0', auto: 'reaction', start_tick: 0, end_tick: tp, fov: 62, path: { type: 'follow', actor: winner.name, rel: { back: -3.2, up: 1.6, right: 0.6 }, look: winner.name, smoothing: 0.4, look_smoothing: 0.25 } })
        shots.push({ id: 'c1', auto: 'rush', start_tick: tp, end_tick: Math.min(D, tp + rush), fov: 60, path: { type: 'crane', from: ring(26, 14), to: ring(3, 1.6), easing: 'ease_in', look: winner.name, look_smoothing: 0.05 } })
        shots.push({ id: 'c2', auto: 'spin', start_tick: Math.min(D, tp + rush), end_tick: Math.min(D, tp + rush + spin), fov: 60, path: { type: 'orbit', target: winner.name, radius: 3, height: 1.6, start_deg: +(a0 * 180 / Math.PI).toFixed(1), end_deg: +(a0 * 180 / Math.PI + 360).toFixed(1), easing: 'linear', look: winner.name, look_smoothing: 0.05 } })
        if (tp + rush + spin < D - 5) shots.push({ id: 'c3', auto: 'settle', start_tick: Math.min(D, tp + rush + spin), end_tick: D, fov: 60, path: { type: 'crane', from: ring(3, 1.6), to: ring(10, 5.5), easing: 'ease_out', look: winner.name, look_smoothing: 0.2 } })
        sceneExtra = { celebration: true, swoosh_tick: tp }
      }
      if (decided && winner && !celebration) {
        const tick = (decided.t - from) / speed + 50 // after the lift onto the podium
        const at = R.sampleAt(winner.track, decided.t + 60, 80) || R.sampleAt(winner.track, decided.t, 80)
        if (at && inReach(at.x, at.z) && tick < D - 30) worldEvents.push({ tick, type: 'victory', point: { x: at.x, y: at.y + 2.5, z: at.z }, near: winner.name, after: D - tick })
      }
      // a kit that moved another player: its own shot, with the seconds before it
      for (const a of rec.events) {
        if (a.type !== 'ability' || a.t < from || a.t > to) continue
        const tp = rec.events.find(e => e.type === 'teleport' && e.p !== a.p && Math.abs(e.t - a.t) <= 20 && e.x !== undefined && Array.isArray(e.from))
        if (!tp || !inReach(tp.x, tp.z) || !inReach(tp.from[0], tp.from[2])) continue
        const tick = Math.round((a.t - from) / speed)
        worldEvents.push({ tick, type: 'pull', near: rec.players[tp.p].name, second: rec.players[a.p].name, before: Math.min(tick, 120), after: 70,
          point: { x: tp.x, y: tp.y, z: tp.z }, span: { from: { x: tp.from[0], y: tp.from[1] + 1, z: tp.from[2] }, to: { x: tp.x, y: tp.y + 1, z: tp.z } } })
      }
      // a player's own line (their chat, or a line in their voice) is said to camera: the cut goes
      // to them as it starts. "show_speaker": false on the line keeps the picture where it is.
      const speech = (seg.narration || []).filter(l => l.speaker && l.speaker !== 'narrator' && l.show_speaker !== false && rec.players.some(p => p.name === l.speaker))
        .map(l => ({ tick: Math.round(l.at_sec * 20), ticks: Math.round(S.estimateLineSeconds(String(l.text || '')) * 20), who: l.speaker }))
      if (!celebration) {
        const auto = autoShots({ id: seg.id, duration: D, focus: seg.focus, deaths, events: worldEvents, speech, ctx: { actor }, world, present, center })
        shots = auto.shots
        notes.push(...auto.notes)
      }
    }
    for (const sh of shots) for (const e of [['shot_start', sh.start_tick], ['shot_end', sh.end_tick]]) replay.addEvent(e[1], e[0], { id: sh.id })
    replay.write(replayPath(dir, seg.id))

    timeline.scenes.push({ id: seg.id, title: seg.title || seg.id, summary: seg.title || '', location: 'match', offset_tick: offset, duration_ticks: D, actors: seg.focus, origin: center, match_from_sec: seg.from_sec, match_to_sec: seg.to_sec, speed, teaser: !!seg.teaser, stings: resolveStings(seg, rec, from, to, speed), transition: seg.transition || undefined, ...sceneExtra, slowmo: seg.finale ? speed : undefined, fireworks: effects.some(e => e.type === 'firework') || undefined })
    for (const l of (seg.narration || []).slice().sort((a, b) => a.at_sec - b.at_sec)) {
      const id = `${seg.id}.${l.id}`
      const tick = offset + Math.round(l.at_sec * 20)
      // a line belongs to the narrator unless a player speaks it (real chat or an invented line)
      const who = l.speaker && l.speaker !== 'narrator' ? l.speaker : 'narrator'
      if (who !== 'narrator' && !cast.characters[who]) {
        const speaker = rec.players.find(p => p.name === who)
        cast.characters[who] = playerVoices.voiceFor(who, speaker ? speaker.voice : null)
        voice.characters[who] = { name: who, voice_desc: cast.characters[who].voice_desc, cast: cast.characters[who] }
      }
      const emotion = l.emotion || (who === 'narrator' ? 'measured' : 'in the moment')
      timeline.lines.push({ id, local_id: l.id, scene_id: seg.id, local_tick: Math.round(l.at_sec * 20), tick, actual_tick: tick, character: who, character_name: who === 'narrator' ? 'Narrator' : who.replace(/^\./, ''), chat: !!l.chat, text: l.text, emotion, delivery: l.delivery, est_sec: S.estimateLineSeconds(l.text) })
      voice.lines.push({ id, scene_id: seg.id, character: who, text: l.text, chat: !!l.chat, emotion, delivery: l.delivery, group: false, voice: cast.characters[who] })
    }
    for (const s of shots) timeline.shots.push({ ...s, id: `${seg.id}.${s.id}`, local_id: s.id, scene_id: seg.id, local_start: s.start_tick, local_end: s.end_tick, start_tick: s.start_tick + offset, end_tick: s.end_tick + offset, actual_start_tick: s.start_tick + offset })
    for (const c of editScene(shots, D)) timeline.cuts.push({ shot_id: `${seg.id}.${c.shot_id}`, scene_id: seg.id, local_start: c.start_tick, local_end: c.end_tick, local_hold_from: c.hold_from_tick, start_tick: c.start_tick + offset, end_tick: c.end_tick + offset })
    for (const c of later) world.setStateId(c.x, c.y, c.z, c.to)
    offset += D
  }
  world.close()
  timeline.total_ticks = offset
  const defaultMusic = doc.music || { mood_tags: ['battle', 'tense'], tempo: 'fast' }
  timeline.music_cues = musicCues(doc.segments.map((seg, i) => ({ start_tick: timeline.scenes[i].offset_tick, end_tick: timeline.scenes[i].offset_tick + timeline.scenes[i].duration_ticks, mood: seg.music })), defaultMusic, manifest, doc.title || '')
  // the finale song starts on the cut, not eased in, so its drop lands where the scene was cut for it
  timeline.music_cues.forEach((c, i) => {
    if (c.track_id !== require('./finale').TRACK_ID) return
    c.hard = true
    if (finaleWindow && finaleWindow.soft_duck) c.soft_duck = true // a feel song: barely turned down under a voice
    // the song always plays out: when the fight ends before it does, it runs on over the
    // start of the celebration
    const songEnd = Math.min(timeline.total_ticks, c.start_tick + Math.round((c.duration_sec || 0) * 20))
    if (songEnd > c.end_tick) { c.end_tick = songEnd; const n = timeline.music_cues[i + 1]; if (n) n.start_tick = Math.min(n.end_tick, songEnd) }
    // ...and the celebration music picks the ending up at full height: it comes in under the
    // song's last seconds, from the biggest part of its own track
    const next = timeline.music_cues[i + 1]
    if (next && next.path) { next.carry = true; next.in_sec = require('./finale').energeticStart(next.path) }
  })
  timeline.music_cues = timeline.music_cues.filter(c => c.end_tick - c.start_tick > 10) // a song that runs to the end leaves no room for another cue
  if (world.mapper.unknown.size) notes.push(`blocks newer than the renderer drawn as air: ${[...world.mapper.unknown.keys()].join(', ')}`)

  // keep earlier voice lines whose text, speaker, voice and delivery are unchanged (never a mock take)
  if (!opts.fresh) require('../voice/client').restoreCached(dir, timeline, voice.lines)
  U.writeJson(path.join(dir, 'timeline.json'), timeline)
  U.writeJson(path.join(dir, 'voice.json'), voice)
  U.writeJson(path.join(dir, 'cast.json'), cast)
  return { ok: true, errors: [], warnings: notes, video_sec: offset / 20, scenes: timeline.scenes.length, shots: timeline.shots.length, lines: timeline.lines.length, players: rec.players.filter(p => !p.anon).map(p => ({ name: p.name, uuid: p.uuid })) }
}

module.exports = { build, check, standY, unstick, rawDataLines, finaleErrors, abilityEffects }
