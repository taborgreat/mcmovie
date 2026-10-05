'use strict'
// Actor motion: keyframes -> state at any (fractional) tick. Shared by the
// validator (collision / speed checks), the shoot controller (what to send to
// the server each tick) and anything that wants to predict where an actor is.
const U = require('./util')
const { MOVEMENT_ANIMS, knockbackPath } = require('./speeds')

const JUMP_HEIGHT = 1.25
const JUMP_TICKS = 12

function baseAnim (anim) { return String(anim || '').split(':')[0] }
function isMovementAnim (anim) { return MOVEMENT_ANIMS.includes(baseAnim(anim)) }

class ActorTrack {
  constructor (actorId, keyframes) {
    this.id = actorId
    this.kf = keyframes.filter(k => k.actor === actorId).slice().sort((a, b) => a.tick - b.tick)
    if (!this.kf.length) throw new Error(`actor ${actorId} has no keyframes`)
    // movement mode carried across keyframes that only carry a one-shot
    let mode = 'idle'
    for (const k of this.kf) {
      const b = baseAnim(k.anim)
      if (isMovementAnim(b)) mode = b
      k._mode = isMovementAnim(b) ? b : mode
      k._oneshot = (k.anim && !isMovementAnim(b)) ? k.anim : null
    }
  }

  // a knocked-back player keeps facing whoever hit them (they fly backwards)
  _kbYaw (a, b) { return a.yaw !== undefined ? U.mcYawToMf(a.yaw) : U.lookAt(b, a).yaw }

  get firstTick () { return this.kf[0].tick }
  get lastTick () { return this.kf[this.kf.length - 1].tick }
  get first () { return this.kf[0] }

  // One-shot actions whose keyframe tick is exactly t.
  oneshotsAt (t) {
    const shots = this.kf.filter(k => k.tick === t && k._oneshot).map(k => k._oneshot)
    // being knocked back is being hit: the red flash comes with it
    if (this.kf.some(k => k.tick === t && baseAnim(k.anim) === 'knockback')) shots.push('hurt')
    return shots
  }

  // ctx (optional): { actor(id, t) } to resolve look_at targets that are actors.
  stateAt (t, ctx) {
    const kf = this.kf
    let a, b
    if (t <= kf[0].tick) { a = kf[0]; b = kf[0] } else if (t >= kf[kf.length - 1].tick) { a = kf[kf.length - 1]; b = a } else {
      let i = 0
      while (i < kf.length - 1 && kf[i + 1].tick <= t) i++
      a = kf[i]; b = kf[i + 1]
    }
    const span = b.tick - a.tick
    const u = span > 0 ? U.clamp((t - a.tick) / span, 0, 1) : 0
    const pos = { x: U.lerp(a.x, b.x, u), y: U.lerp(a.y, b.y, u), z: U.lerp(a.z, b.z, u) }
    const moving = span > 0 && U.dist(a, b) > 0.01
    let anim = a._mode
    if (!moving && (anim === 'walk' || anim === 'sprint' || anim === 'swing' || anim === 'jump')) anim = a._mode === 'swing' ? 'swing' : 'idle'
    if (a === b || t >= kf[kf.length - 1].tick) anim = (a._mode === 'sneak' || a._mode === 'crouch') ? 'sneak' : (a._mode === 'swing' ? 'swing' : 'idle')
    // knocked back: the real arc (fast out, lifted, falling, a short slide), ending on the
    // next keyframe's spot. The flight takes as long as the game makes it take.
    if (a._mode === 'knockback' && baseAnim(a.anim) === 'knockback' && moving) {
      if (!a._kb) {
        const level = parseFloat(String(a.anim).split(':')[1]) || 0
        a._kb = knockbackPath(level, b.y - a.y)
      }
      const path = a._kb
      const i = Math.max(0, t - a.tick)
      if (i >= path.ticks) return { x: b.x, y: b.y, z: b.z, yaw: this._kbYaw(a, b), pitch: 0, anim: 'idle', moving: false, present: true }
      const lo = path.pts[Math.floor(i)]; const hi = path.pts[Math.min(path.ticks, Math.floor(i) + 1)]
      const f = i - Math.floor(i)
      const frac = U.lerp(lo.d, hi.d, f) / path.distance
      const inAir = i < path.air_ticks
      return {
        x: U.lerp(a.x, b.x, frac), y: inAir ? a.y + U.lerp(lo.y, hi.y, f) : b.y, z: U.lerp(a.z, b.z, frac),
        yaw: this._kbYaw(a, b), pitch: 0, anim: inAir ? 'jump' : 'idle', moving: true, present: true
      }
    }
    // jump arc
    const jumpOnce = a._oneshot === 'jump_once'
    if ((a._mode === 'jump' && moving) || jumpOnce) {
      const jt = jumpOnce ? Math.min(1, (t - a.tick) / JUMP_TICKS) : u
      if (jt >= 0 && jt <= 1) pos.y += 4 * JUMP_HEIGHT * jt * (1 - jt)
      if (!jumpOnce) anim = 'jump'
    }
    // orientation
    let yaw, pitch
    const eye = { x: pos.x, y: pos.y + 1.62, z: pos.z }
    const lookTarget = a.look_at !== undefined ? a.look_at : null
    if (lookTarget !== null && lookTarget !== undefined) {
      let target = null
      if (Array.isArray(lookTarget)) target = U.v3(lookTarget)
      else if (typeof lookTarget === 'string' && ctx && ctx.actor) {
        const o = ctx.actor(lookTarget, t)
        if (o) target = { x: o.x, y: o.y + 1.62, z: o.z }
      }
      if (target) ({ yaw, pitch } = U.lookAt(eye, target))
    }
    if (yaw === undefined) {
      if (a.yaw !== undefined && b.yaw !== undefined && b !== a) yaw = U.lerpAngle(U.mcYawToMf(a.yaw), U.mcYawToMf(b.yaw), u)
      else if (a.yaw !== undefined) yaw = U.mcYawToMf(a.yaw)
      else if (moving) yaw = U.lookAt(a, b).yaw
      else {
        // face where we were going, or toward next keyframe, or south
        const prev = kf.indexOf(a) > 0 ? kf[kf.indexOf(a) - 1] : null
        const next = kf.indexOf(a) < kf.length - 1 ? kf[kf.indexOf(a) + 1] : null
        if (prev && U.dist(prev, a) > 0.01) yaw = U.lookAt(prev, a).yaw
        else if (next && U.dist(a, next) > 0.01) yaw = U.lookAt(a, next).yaw
        else yaw = Math.PI
      }
      pitch = a.pitch !== undefined ? U.mcPitchToMf(a.pitch) : 0
      if (a.pitch !== undefined && b.pitch !== undefined && b !== a) pitch = U.lerp(U.mcPitchToMf(a.pitch), U.mcPitchToMf(b.pitch), u)
    }
    return { x: pos.x, y: pos.y, z: pos.z, yaw, pitch, anim, moving, present: t >= kf[0].tick }
  }
}

// Build tracks for all actors in a scene and a ctx that resolves actors.
function buildTracks (scene) {
  const ids = [...new Set((scene.keyframes || []).map(k => k.actor))]
  const tracks = {}
  for (const id of ids) tracks[id] = new ActorTrack(id, scene.keyframes)
  const ctx = {
    tracks,
    actor (id, t) {
      const tr = tracks[id]
      if (!tr) return null
      // resolve without recursion: a target's own look_at is irrelevant for position
      return tr.stateAt(t, null)
    }
  }
  return { tracks, ctx }
}

module.exports = { ActorTrack, buildTracks, baseAnim, isMovementAnim, JUMP_TICKS }
