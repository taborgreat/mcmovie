'use strict'
// Camera path evaluation. Pure math: given a shot and a function that returns
// actor state at a (fractional) tick, returns the camera pose at that tick in
// mineflayer radians. Used by the renderer (per frame) and by validation.
//
// Shot.path types:
//   static  { pos, look }
//   dolly   { from, to, look, easing }           crane is an alias
//   orbit   { target, radius, height, start_deg, end_deg, easing, look, radius_end, height_end, hold }
//   follow  { actor, rel:{back,right,up} | offset:[x,y,z], look, smoothing }
//   crane   same as dolly
//   pov     { actor }   through the actor's eyes; the renderer hides that actor
//
// A "point" (pos/look/target) is one of:
//   [x, y, z]                      world coordinates
//   "actorId"                      that actor's eye position
//   { actor: "id", offset: [x,y,z] } actor feet + offset
//   { between: ["A", "B"] }        midpoint of two actors' eyes (duels)
//   { yaw: deg, pitch: deg }       (for look only) fixed direction, MC degrees
//   "forward"                      (for look only, dolly) direction of travel
// Easing: linear | ease_in | ease_out | ease_in_out (default ease_in_out)

const U = require('./util')

const EYE = 1.62

function ease (name, u) {
  u = U.clamp(u, 0, 1)
  switch (name || 'ease_in_out') {
    case 'linear': return u
    case 'ease_in': return u * u
    case 'ease_out': return 1 - (1 - u) * (1 - u)
    case 'ease_in_out':
    default: return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
  }
}

function resolvePoint (p, ctx, t, defaultEye = true) {
  if (p == null) return null
  if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] }
  if (typeof p === 'string') {
    const a = ctx.actor(p, t)
    if (!a) throw new Error(`camera references unknown actor "${p}"`)
    return { x: a.x, y: a.y + (defaultEye ? EYE : 0), z: a.z }
  }
  if (typeof p === 'object' && Array.isArray(p.between)) {
    const a = ctx.actor(p.between[0], t); const b = ctx.actor(p.between[1], t)
    if (!a && !b) throw new Error(`camera references unknown actors "${p.between.join(', ')}"`)
    const A = a || b; const B = b || a
    const o = p.offset || [0, defaultEye ? EYE : 0, 0]
    return { x: (A.x + B.x) / 2 + o[0], y: (A.y + B.y) / 2 + o[1], z: (A.z + B.z) / 2 + o[2] }
  }
  if (typeof p === 'object' && p.actor) {
    const a = ctx.actor(p.actor, t)
    if (!a) throw new Error(`camera references unknown actor "${p.actor}"`)
    const o = p.offset || [0, defaultEye ? EYE : 0, 0]
    return { x: a.x + o[0], y: a.y + o[1], z: a.z + o[2] }
  }
  if (typeof p === 'object' && 'x' in p) return { x: p.x, y: p.y, z: p.z }
  throw new Error('bad camera point: ' + JSON.stringify(p))
}

function orientFor (look, pos, ctx, t, fallbackDir) {
  if (look && typeof look === 'object' && !Array.isArray(look) && 'yaw' in look) {
    return { yaw: U.mcYawToMf(look.yaw), pitch: U.mcPitchToMf(look.pitch || 0) }
  }
  if (look === 'forward') {
    if (fallbackDir) return U.lookAt({ x: 0, y: 0, z: 0 }, fallbackDir)
    return { yaw: Math.PI, pitch: 0 }
  }
  const target = resolvePoint(look, ctx, t, true)
  if (!target) return { yaw: Math.PI, pitch: 0 }
  return U.lookAt(pos, target)
}

class CameraPath {
  constructor (shot) {
    this.shot = shot
    this.path = shot.path || { type: 'static', pos: [0, 70, 0], look: { yaw: 0, pitch: 0 } }
    this.type = this.path.type || 'static'
    this.fov = shot.fov || 70
    this._follow = null // smoothing state
    this._aim = null // smoothed look target
  }

  // Where the camera points. A camera aimed at a player (or between two) eases toward them
  // instead of copying every twitch: recorded fight movement comes in small jerks, and an
  // unsmoothed aim turns each one into a shake of the whole picture.
  aim (look, pos, ctx, t, fallbackDir) {
    const tracks = look && (typeof look === 'string' || (typeof look === 'object' && !Array.isArray(look) && (look.actor || look.between)))
    if (!tracks) { this.target = null; return orientFor(look, pos, ctx, t, fallbackDir) }
    const want = resolvePoint(look, ctx, t, true)
    const tau = this.path.look_smoothing !== undefined ? this.path.look_smoothing : 0.18 // seconds
    let target = want
    if (this._aim && tau > 0 && t >= this._aim.t) {
      const k = 1 - Math.exp(-Math.max(0, (t - this._aim.t) / 20) / tau)
      const a = this._aim.p
      // a teleport is a cut, not something to pan across
      if (Math.hypot(want.x - a.x, want.y - a.y, want.z - a.z) < 8) target = { x: U.lerp(a.x, want.x, k), y: U.lerp(a.y, want.y, k), z: U.lerp(a.z, want.z, k) }
    }
    this._aim = { t, p: target }
    this.target = target // what the lens is on, for whoever places the camera in a real world
    return U.lookAt(pos, target)
  }

  // t: local scene tick (float). ctx.actor(id, t) -> {x,y,z,yaw,pitch} feet pos or null.
  evaluate (t, ctx) {
    const s = this.shot
    const span = Math.max(1, s.end_tick - s.start_tick)
    let u = ease(this.path.easing, (t - s.start_tick) / span)
    const p = this.path
    switch (this.type) {
      case 'static': {
        const pos = resolvePoint(p.pos, ctx, t, true)
        return { ...pos, ...this.aim(p.look, pos, ctx, t), fov: this.fov }
      }
      case 'dolly':
      case 'crane': {
        const a = resolvePoint(p.from, ctx, t, true)
        const b = resolvePoint(p.to, ctx, t, true)
        const pos = { x: U.lerp(a.x, b.x, u), y: U.lerp(a.y, b.y, u), z: U.lerp(a.z, b.z, u) }
        const dir = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
        return { ...pos, ...this.aim(p.look, pos, ctx, t, dir), fov: this.fov }
      }
      case 'orbit': {
        const target = resolvePoint(p.target, ctx, t, true)
        // hold: ticks at the start where nothing moves (a moment on the face before the spin)
        if (p.hold) { const held = Math.max(1, span - p.hold); u = ease(p.easing, U.clamp((t - s.start_tick - p.hold) / held, 0, 1)) }
        // radius_end / height_end: the orbit widens or climbs as it turns (the celebration's 360 that zooms out)
        const r = U.lerp(p.radius || 6, p.radius_end !== undefined ? p.radius_end : (p.radius || 6), u)
        const h = U.lerp(p.height !== undefined ? p.height : 1, p.height_end !== undefined ? p.height_end : (p.height !== undefined ? p.height : 1), u)
        const aDeg = U.lerp(p.start_deg || 0, p.end_deg !== undefined ? p.end_deg : (p.start_deg || 0) + 90, u)
        const a = U.deg2rad(aDeg)
        const pos = { x: target.x - Math.sin(a) * r, y: target.y + h, z: target.z + Math.cos(a) * r }
        return { ...pos, ...this.aim(p.look || p.target, pos, ctx, t), fov: this.fov }
      }
      case 'follow': {
        const actor = ctx.actor(p.actor, t)
        if (!actor) throw new Error(`follow shot ${s.id}: unknown actor ${p.actor}`)
        let want
        if (p.rel) {
          const yaw = actor.yaw !== undefined ? actor.yaw : Math.PI
          const fwd = U.viewVector(yaw, 0)
          const right = { x: -fwd.z, z: fwd.x }
          const back = p.rel.back || 0; const rt = p.rel.right || 0; const up = p.rel.up !== undefined ? p.rel.up : EYE
          want = { x: actor.x - fwd.x * back + right.x * rt, y: actor.y + up, z: actor.z - fwd.z * back + right.z * rt }
        } else {
          const o = p.offset || [0, 3, 5]
          want = { x: actor.x + o[0], y: actor.y + o[1], z: actor.z + o[2] }
        }
        const tau = p.smoothing !== undefined ? p.smoothing : 0.25 // seconds
        let pos
        if (!this._follow || tau <= 0 || t < this._follow.t) {
          pos = want
        } else {
          const dt = Math.max(0, (t - this._follow.t) / 20)
          const k = 1 - Math.exp(-dt / tau)
          const prev = this._follow.pos
          pos = { x: U.lerp(prev.x, want.x, k), y: U.lerp(prev.y, want.y, k), z: U.lerp(prev.z, want.z, k) }
        }
        // A camera in front of someone walking toward it lags behind its mark and they walk
        // into it. Never closer than most of the planned distance (and never under 2.4 blocks).
        {
          const ex = actor.x; const ey = actor.y + EYE; const ez = actor.z
          const planned = Math.hypot(want.x - ex, want.y - ey, want.z - ez)
          const min = Math.max(2.4, planned * 0.85)
          const d = Math.hypot(pos.x - ex, pos.y - ey, pos.z - ez)
          if (d < min && d > 1e-3) { const k = min / d; pos = { x: ex + (pos.x - ex) * k, y: ey + (pos.y - ey) * k, z: ez + (pos.z - ez) * k } }
        }
        this._follow = { t, pos }
        const look = p.look || p.actor
        return { ...pos, ...this.aim(look, pos, ctx, t), fov: this.fov }
      }
      case 'pov': {
        const actor = ctx.actor(p.actor, t)
        if (!actor) throw new Error(`pov shot ${s.id}: unknown actor ${p.actor}`)
        const yaw = actor.yaw !== undefined ? actor.yaw : Math.PI
        const pitch = actor.pitch || 0
        const fwd = U.viewVector(yaw, 0)
        return { x: actor.x + fwd.x * 0.15, y: actor.y + EYE, z: actor.z + fwd.z * 0.15, yaw, pitch, fov: this.fov, hide: p.actor }
      }
      default:
        throw new Error(`unknown camera path type "${this.type}" in shot ${s.id}`)
    }
  }

  reset () { this._follow = null; this._aim = null; this.target = null }
}

// Collect actor ids a shot references, for validation.
function referencedActors (shot) {
  const ids = new Set()
  const visit = (p) => {
    if (!p) return
    if (typeof p === 'string' && p !== 'forward') ids.add(p)
    else if (typeof p === 'object' && !Array.isArray(p) && p.actor) ids.add(p.actor)
    else if (typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.between)) p.between.forEach(x => ids.add(x))
  }
  const p = shot.path || {}
  for (const k of ['pos', 'look', 'from', 'to', 'target']) visit(p[k])
  if ((p.type === 'follow' || p.type === 'pov') && p.actor) ids.add(p.actor)
  return [...ids]
}

module.exports = { CameraPath, ease, resolvePoint, referencedActors, EYE }
