'use strict'
// Stage 4: merge planned scenes into one global tick timeline and emit the
// work orders. No AI here. timeline.json is the single source of truth for
// shooting, voicing, rendering and assembly.
const path = require('path')
const U = require('./util')
const S = require('./speeds')
const { sceneDuration } = require('./validate')
const skins = require('./skins')

const TIME_WORDS = { sunrise: 23000, day: 1000, noon: 6000, sunset: 12000, night: 14000, midnight: 18000 }

function resolveTime (t) {
  if (typeof t === 'number') return t
  return TIME_WORDS[t] !== undefined ? TIME_WORDS[t] : 6000
}

function gid (sceneId, localId) { return `${sceneId}.${localId}` }

// Resolve overlapping shots into a cut list for one scene (local ticks).
// Rule: at a shot's start_tick we cut to it if its priority >= the current
// shot's. When the current shot ends, cut to the highest-priority shot still
// running (ties: latest start). Gaps hold the previous shot's camera.
function editScene (shots, duration) {
  const sorted = shots.slice().sort((a, b) => a.start_tick - b.start_tick || (b.priority || 0) - (a.priority || 0))
  const cuts = []
  let current = null
  const active = (t) => sorted.filter(s => s.start_tick <= t && t < s.end_tick)
  const starts = [...new Set(sorted.map(s => s.start_tick))]
  const ends = [...new Set(sorted.map(s => s.end_tick))]
  const ticks = [...new Set([...starts, ...ends])].sort((a, b) => a - b)
  for (const t of ticks) {
    if (t >= duration) break
    const starting = sorted.filter(s => s.start_tick === t)
    let next = null
    if (starting.length) {
      const best = starting.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
      if (!current || t >= current.end_tick || (best.priority || 0) >= (current.priority || 0)) next = best
    }
    if (!next && current && t >= current.end_tick) {
      const act = active(t).sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.start_tick - a.start_tick)
      next = act[0] || null // null -> hold current
    }
    if (next && next !== current) {
      if (cuts.length) cuts[cuts.length - 1].end_tick = t
      cuts.push({ shot_id: next.id, start_tick: t, end_tick: duration, hold_from_tick: next.end_tick })
      current = next
    }
  }
  if (cuts.length) cuts[cuts.length - 1].end_tick = duration
  return cuts
}

// Choose a track for a mood request: { mood_tags, tempo, track_id, in_sec, out_sec, gain_db }.
// When several tracks fit a mood equally well the `seed` (the film's title)
// breaks the tie, so one film is consistent and different films differ.
function pickTrack (want, manifest, seed = '') {
  want = want || {}
  const tracks = (manifest && manifest.tracks) || []
  if (!tracks.length) return null
  let track = null
  if (want.track_id) track = tracks.find(t => t.id === want.track_id) || null
  if (!track) {
    const tags = (want.mood_tags || []).map(s => String(s).toLowerCase())
    const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
    let best = null; let bestScore = -1; let bestTie = -1
    for (const t of tracks) {
      const have = (t.mood_tags || []).map(m => String(m).toLowerCase())
      // the first mood asked for matters most
      let score = 0
      tags.forEach((tag, i) => { if (have.includes(tag)) score += i === 0 ? 4 : 2 })
      if (tags.length && have[0] === tags[0]) score += 1 // the track's own main mood
      if (t.tempo && want.tempo && t.tempo === want.tempo) score += 1
      const tie = hash(seed + '|' + tags.join(',') + '|' + t.id)
      if (score > bestScore || (score === bestScore && tie > bestTie)) { best = t; bestScore = score; bestTie = tie }
    }
    track = best
  }
  if (!track) return null
  return {
    track_id: track.id, title: track.title || track.id, credit: track.credit || null,
    path: path.isAbsolute(track.path) ? track.path : path.join(U.ROOT, 'music', track.path),
    in_sec: want.in_sec !== undefined ? want.in_sec : (track.in_sec || 0),
    out_sec: want.out_sec !== undefined ? want.out_sec : (track.out_sec || track.duration_sec || null),
    duration_sec: track.duration_sec || null,
    gain_db: want.gain_db !== undefined ? want.gain_db : (track.gain_db !== undefined ? track.gain_db : -6),
    duck_db: -12,
    loopable: !!track.loopable
  }
}

function pickMusic (story, manifest) { return pickTrack(story.music || {}, manifest, story.title || '') }

// A mood can be written as "sad", ["sad","slow"], or a full request object.
function moodRequest (mood, fallback) {
  if (!mood) return fallback || {}
  if (typeof mood === 'string') return { ...(fallback || {}), mood_tags: [mood], track_id: undefined }
  if (Array.isArray(mood)) return { ...(fallback || {}), mood_tags: mood, track_id: undefined }
  return { ...(fallback || {}), ...mood }
}

// sections: [{ start_tick, end_tick, mood }] in order. Neighbours that resolve
// to the same track are merged so the music plays through the cut.
function musicCues (sections, fallback, manifest, seed = '') {
  const cues = []
  for (const sec of sections) {
    const t = pickTrack(moodRequest(sec.mood, fallback), manifest, seed)
    if (!t) continue
    const last = cues[cues.length - 1]
    if (last && last.track_id === t.track_id && last.end_tick === sec.start_tick) last.end_tick = sec.end_tick
    else cues.push({ ...t, start_tick: sec.start_tick, end_tick: sec.end_tick })
  }
  return cues
}

function build (dir, opts = {}) {
  const story = U.readJson(path.join(dir, 'story.json'))
  const world = U.readJson(path.join(dir, 'world.json'))
  const castFile = path.join(dir, 'cast.json')
  const cast = U.exists(castFile) ? U.readJson(castFile) : { characters: {} }
  const manifestFile = path.join(U.ROOT, 'music', 'music_manifest.json')
  const manifest = U.exists(manifestFile) ? U.readJson(manifestFile) : null
  // songs a struck film used are never picked again (lib/publish/music_health.js)
  if (manifest && manifest.tracks) { try { const bad = require('./publish/music_health').suspended(); manifest.tracks = manifest.tracks.filter(t => !bad.has(t.id)) } catch { /* no record yet */ } }
  const roster = skins.readRoster()
  const charById = Object.fromEntries(story.characters.map(c => [c.id, c]))
  const setById = Object.fromEntries(world.sets.map(s => [s.id, s]))
  const gap = opts.sceneGapTicks !== undefined ? opts.sceneGapTicks : 0

  const timeline = {
    version: 1,
    generated: new Date().toISOString(),
    title: story.title,
    tick_rate: S.TICK_RATE,
    fps: opts.fps || 30,
    cards: story.cards || { title: true },
    setting: story.setting,
    scenes: [], cast: cast.characters || {}, lines: [], shots: [], cuts: [],
    music: pickMusic(story, manifest)
  }
  const shoot = { version: 1, tick_rate: S.TICK_RATE, world, scenes: [] }
  const voice = { version: 1, lines: [], characters: {} }

  let offset = 0
  for (const sc of story.scenes) {
    const scene = U.readJson(path.join(dir, `scene_${sc.id}.json`))
    const duration = sceneDuration(scene)
    const set = setById[sc.location]
    const actorIds = [...new Set(scene.keyframes.map(k => k.actor))]
    const actors = actorIds.map(id => {
      const c = charById[id] || {}
      const skinName = c.skin || c.player || id
      const rosterEntry = roster.players.find(p => p.name.toLowerCase() === String(skinName).toLowerCase())
      return { id, name: c.name || id, skin: skins.skinPathFor(skinName) ? skinName : null, model: rosterEntry ? rosterEntry.model : 'classic' }
    })
    timeline.scenes.push({
      id: sc.id, title: scene.title || sc.title || sc.id, summary: sc.summary, location: sc.location,
      offset_tick: offset, duration_ticks: duration, actors: actorIds,
      origin: set ? set.origin : (sc.origin || [0, 65, 0]),
      beats: scene.beats
    })
    for (const l of scene.lines.slice().sort((a, b) => a.tick - b.tick)) {
      const c = charById[l.character] || {}
      const entry = { ...l, id: gid(sc.id, l.id), local_id: l.id, scene_id: sc.id, local_tick: l.tick, tick: l.tick + offset, est_sec: S.estimateLineSeconds(l.text), character_name: c.name || l.character }
      timeline.lines.push(entry)
      voice.lines.push({ id: entry.id, scene_id: sc.id, character: l.character, text: l.text, emotion: l.emotion, delivery: l.delivery, group: !!c.group, voice: (cast.characters || {})[l.character] || { voice: c.group ? 'crowd' : (c.voice || 'auto'), voice_desc: c.voice_desc } })
    }
    for (const s of scene.shots) {
      timeline.shots.push({ ...s, id: gid(sc.id, s.id), local_id: s.id, scene_id: sc.id, local_start: s.start_tick, local_end: s.end_tick, start_tick: s.start_tick + offset, end_tick: s.end_tick + offset })
    }
    for (const c of editScene(scene.shots, duration)) {
      timeline.cuts.push({ shot_id: gid(sc.id, c.shot_id), scene_id: sc.id, local_start: c.start_tick, local_end: c.end_tick, local_hold_from: c.hold_from_tick, start_tick: c.start_tick + offset, end_tick: c.end_tick + offset })
    }
    shoot.scenes.push({
      id: sc.id, offset_tick: offset, duration_ticks: duration, set_id: sc.location,
      set: set || null, actors, keyframes: scene.keyframes, world_events: scene.world_events || [],
      shots: scene.shots.map(s => ({ id: s.id, start_tick: s.start_tick, end_tick: s.end_tick })),
      lines: scene.lines.map(l => ({ id: l.id, tick: l.tick, character: l.character }))
    })
    offset += duration + gap
  }
  timeline.total_ticks = offset
  // music can change with the story: each scene may name a mood ("music_mood")
  timeline.music_cues = musicCues(story.scenes.map((sc, i) => ({ start_tick: timeline.scenes[i].offset_tick, end_tick: timeline.scenes[i].offset_tick + timeline.scenes[i].duration_ticks, mood: sc.music_mood })), story.music || {}, manifest, story.title || '')
  timeline.world = { ground_y: world.ground_y, time_of_day: resolveTime(world.time_of_day !== undefined ? world.time_of_day : story.setting.time_of_day), weather: world.weather || story.setting.weather || 'clear' }
  const terrainFile = path.join(dir, 'terrain.json')
  if (U.exists(terrainFile)) { const t = U.readJson(terrainFile); shoot.world.natural = true; shoot.world.stage = t.stage }
  shoot.world.time_of_day = timeline.world.time_of_day
  shoot.world.weather = timeline.world.weather
  for (const c of story.characters) voice.characters[c.id] = { name: c.name, voice_desc: c.voice_desc, group: !!c.group, cast: (cast.characters || {})[c.id] || null }

  // carry over results of earlier stages when the plan item is unchanged
  const prevFile = path.join(dir, 'timeline.json')
  if (U.exists(prevFile) && !opts.fresh) {
    let prev = null
    try { prev = U.readJson(prevFile) } catch {}
    if (prev) {
      const prevLines = new Map((prev.lines || []).map(l => [l.id, l]))
      for (const l of timeline.lines) {
        const o = prevLines.get(l.id)
        if (o && o.text === l.text) for (const k of ['wav', 'duration_sec', 'profile']) if (o[k] !== undefined) l[k] = o[k]
        if (o && o.actual_tick !== undefined && o.local_tick === l.local_tick && o.tick === l.tick) l.actual_tick = o.actual_tick
      }
      const prevShots = new Map((prev.shots || []).map(s => [s.id, s]))
      for (const s of timeline.shots) {
        const o = prevShots.get(s.id)
        if (o && o.start_tick === s.start_tick && o.end_tick === s.end_tick && JSON.stringify(o.path) === JSON.stringify(s.path)) for (const k of ['clip', 'actual_start_tick', 'actual_end_tick', 'replay']) if (o[k] !== undefined) s[k] = o[k]
      }
      const prevCuts = (prev.cuts || [])
      for (const c of timeline.cuts) {
        const o = prevCuts.find(x => x.shot_id === c.shot_id && x.start_tick === c.start_tick && x.end_tick === c.end_tick)
        if (o && o.clip && U.exists(path.join(dir, o.clip))) { c.clip = o.clip; c.frames = o.frames; c.fps = o.fps; if (o.source) c.source = o.source }
      }
    }
  }
  U.writeJson(path.join(dir, 'timeline.json'), timeline)
  U.writeJson(path.join(dir, 'shoot.json'), shoot)
  U.writeJson(path.join(dir, 'voice.json'), voice)
  return timeline
}

module.exports = { build, editScene, pickMusic, pickTrack, musicCues, moodRequest, resolveTime, gid }
