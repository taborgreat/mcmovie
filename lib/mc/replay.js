'use strict'
// Replay files: everything the renderer needs to re-create a scene offline at
// any frame rate. One file per scene: projects/<p>/replay/scene_<id>.json.gz
//   meta:    { scene_id, duration_ticks, version, ground_y, center, recorded }
//   columns: [{ x, z, json }]   chunk columns at tick 0 (prismarine-chunk toJson)
//   frames:  [{ t, a: [actor states], e: [other entities], b: [block updates] }]
//   events:  [{ t, type, ... }]  shot_start/shot_end/line/world_event with actual ticks
const path = require('path')
const U = require('../util')

function replayPath (dir, sceneId) { return path.join(dir, 'replay', `scene_${sceneId}.json.gz`) }

class ReplayWriter {
  constructor (meta) {
    this.meta = meta
    this.columns = []
    this.frames = []
    this.events = []
  }

  setColumns (columns) { this.columns = columns }
  addFrame (t, actors, entities, blocks) {
    const f = { t, a: actors, e: entities }
    if (blocks && blocks.length) f.b = blocks
    this.frames.push(f)
  }

  addEvent (t, type, data) { this.events.push({ t, type, ...data }) }

  write (file) {
    U.writeJsonGz(file, { meta: this.meta, columns: this.columns, frames: this.frames, events: this.events })
  }
}

function readReplay (file) {
  return U.readJsonGz(file)
}

// Interpolated entity states at fractional tick t from a replay.
// Returns Map(entityKey -> state). Actors are keyed by username, others by id.
function statesAt (replay, t) {
  const frames = replay.frames
  if (!frames.length) return new Map()
  const t0 = frames[0].t
  const i = U.clamp(Math.floor(t - t0), 0, frames.length - 1)
  const j = U.clamp(i + 1, 0, frames.length - 1)
  const fa = frames[i]; const fb = frames[j]
  const u = fb.t > fa.t ? U.clamp((t - fa.t) / (fb.t - fa.t), 0, 1) : 0
  const out = new Map()
  const mix = (a, b) => a.motionEpoch !== b.motionEpoch ? { ...a } : ({
    ...a,
    x: U.lerp(a.x, b.x, u), y: U.lerp(a.y, b.y, u), z: U.lerp(a.z, b.z, u),
    yaw: U.lerpAngle(a.yaw || 0, b.yaw || 0, u), pitch: U.lerp(a.pitch || 0, b.pitch || 0, u)
  })
  const bA = new Map(fb.a.map(a => [a.username, a]))
  for (const a of fa.a) out.set('actor:' + a.username, mix(a, bA.get(a.username) || a))
  const bE = new Map((fb.e || []).map(e => [e.id, e]))
  for (const e of fa.e || []) {
    const b = bE.get(e.id)
    // ignore huge jumps (teleports / respawns)
    out.set('ent:' + e.id, b && U.dist(e, b) < 8 ? mix(e, b) : { ...e })
  }
  return out
}

// Camera targets must resolve even when an actor is not on screen at tick t
// (not spawned yet, or dead): fall back to where they were last, or first, seen.
function actorResolver (replay) {
  const first = new Map(); const last = new Map()
  for (const f of replay.frames) {
    for (const a of f.a) {
      if (!first.has(a.username)) first.set(a.username, { t: f.t, s: a })
      last.set(a.username, { t: f.t, s: a })
    }
  }
  const known = new Map() // username -> [{t, s}] sparse index of appearances, built lazily
  return function actor (id, t) {
    const s = statesAt(replay, t).get('actor:' + id)
    if (s) return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, motionEpoch: s.motionEpoch }
    if (!first.has(id)) return null
    if (!known.has(id)) {
      const arr = []
      for (const f of replay.frames) { const a = f.a.find(x => x.username === id); if (a) arr.push({ t: f.t, s: a }) }
      known.set(id, arr)
    }
    const arr = known.get(id)
    let best = arr[0]
    for (const k of arr) { if (k.t <= t) best = k; else break }
    const b = best.s
    return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch, motionEpoch: b.motionEpoch, absent: true }
  }
}

module.exports = { ReplayWriter, readReplay, replayPath, statesAt, actorResolver }
