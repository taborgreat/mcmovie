'use strict'
// Automatic cinematography for recorded matches. Nobody planned where the
// players would run, so cameras cannot be placed by hand ahead of time: for
// each few-second window this generates candidate shots (duel orbit, duel
// static, follow behind, follow in front, side track, high angle, crane),
// scores each one against the real terrain (camera inside a block, sight line
// to the subject blocked) and keeps the best. Deterministic per segment id.
const U = require('../util')
const { CameraPath, EYE } = require('../camera')

function rng (seedStr) {
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function blocked (world, from, to) {
  const d = U.dist(from, to)
  if (d < 1.2) return false
  const steps = Math.ceil(d / 0.5)
  for (let i = 1; i < steps; i++) {
    const u = i / steps
    if (d * (1 - u) < 0.9) break // ignore the block the subject stands against
    if (world.isSolid(U.lerp(from.x, to.x, u), U.lerp(from.y, to.y, u), U.lerp(from.z, to.z, u))) return true
  }
  return false
}

// Mean penalty of a shot over its window: 1 for a camera inside terrain,
// 0.6 per subject it cannot see, small terms for being too far or too low.
function score (shot, subjects, ctx, world) {
  const cam = new CameraPath(shot)
  let total = 0; let n = 0
  for (let t = shot.start_tick; t <= shot.end_tick; t += 4) {
    let pose
    try { pose = cam.evaluate(t, ctx) } catch { return Infinity }
    n++
    if (pose.hide) continue // first person: nothing between the eye and the view
    if (world.isSolid(pose.x, pose.y, pose.z)) { total += 1; continue }
    // a block right in front of the lens fills the frame even if the sight line is clear
    const v = U.viewVector(pose.yaw, pose.pitch)
    let crowded = false
    for (const d of [0.7, 1.4, 2.1]) {
      for (const [ox, oy] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.5], [0, -0.5]]) {
        // offsets across the view: sideways (perpendicular in the horizontal plane) and vertical
        const px = pose.x + v.x * d + (-v.z) * ox; const py = pose.y + v.y * d + oy; const pz = pose.z + v.z * d + v.x * ox
        if (world.isSolid(px, py, pz)) { crowded = true; break }
      }
      if (crowded) break
    }
    if (crowded) total += 0.45
    for (const id of subjects) {
      const a = typeof id === 'string' ? ctx.actor(id, t) : id
      if (!a) continue
      const eye = typeof id === 'string' ? { x: a.x, y: a.y + EYE, z: a.z } : { x: a.x, y: a.y + 1, z: a.z }
      if (blocked(world, pose, eye)) total += 0.6 / subjects.length
      const d = U.dist(pose, eye)
      if (d > 28) total += 0.3 / subjects.length
      if (d < 1.5) total += 0.4 / subjects.length
    }
  }
  return n ? total / n : Infinity
}

function candidates (win, A, B, ctx, rand) {
  const mid = (win.start + win.end) / 2
  const a = ctx.actor(A, mid)
  const out = []
  const base = { start_tick: win.start, end_tick: win.end }
  if (!a) return out
  const b = B ? ctx.actor(B, mid) : null
  const duel = b && U.dist(a, b) < 22
  if (duel) {
    const d = U.distXZ(a, b)
    // angle of the line A->B in MC yaw terms; the camera sits perpendicular to it
    const line = U.mfYawToMc(U.lookAt(a, b).yaw)
    const side = rand() < 0.5 ? 90 : -90
    const radius = U.clamp(d / 2 + 4.5, 5, 10)
    const sweep = (25 + rand() * 35) * (rand() < 0.5 ? 1 : -1)
    for (const h of [1.6, 3.2, 5.5]) {
      out.push({ kind: 'duel_orbit', pref: 0 + (h > 2 ? 0.05 : 0) + (h > 4 ? 0.1 : 0), fov: 62, ...base, path: { type: 'orbit', target: { between: [A, B] }, radius, height: h, start_deg: line + side - sweep / 2, end_deg: line + side + sweep / 2, easing: 'linear' } })
    }
    const perp = U.deg2rad(line + side)
    const mx = (a.x + b.x) / 2; const mz = (a.z + b.z) / 2; const my = (a.y + b.y) / 2
    for (const h of [2.0, 4.5]) {
      out.push({ kind: 'duel_static', pref: 0.05 + (h > 3 ? 0.08 : 0), fov: 58, ...base, path: { type: 'static', pos: [mx - Math.sin(perp) * (radius + 1), my + h, mz + Math.cos(perp) * (radius + 1)], look: { between: [A, B] } } })
    }
    out.push({ kind: 'over_shoulder', pref: 0.06, fov: 68, ...base, path: { type: 'follow', actor: A, rel: { back: 3.6, up: 2.3, right: 1.4 }, look: { between: [A, B] }, smoothing: 0.35 } })
  }
  const right = rand() < 0.5 ? 1.3 : -1.3
  out.push({ kind: 'follow_back', pref: duel ? 0.15 : 0.02, fov: 70, ...base, path: { type: 'follow', actor: A, rel: { back: 4.6, up: 2.4, right }, look: A, smoothing: 0.35 } })
  out.push({ kind: 'follow_back_high', pref: duel ? 0.22 : 0.1, fov: 70, ...base, path: { type: 'follow', actor: A, rel: { back: 5.5, up: 4.6, right: 0 }, look: A, smoothing: 0.4 } })
  out.push({ kind: 'follow_front', pref: duel ? 0.2 : 0.08, fov: 56, ...base, path: { type: 'follow', actor: A, rel: { back: -4.8, up: 1.9, right: right * 0.8 }, look: A, smoothing: 0.35 } })
  // tight framings for fights under a forest canopy, where anything further back is in the leaves
  out.push({ kind: 'close_follow', pref: duel ? 0.18 : 0.12, fov: 75, ...base, path: { type: 'follow', actor: A, rel: { back: 2.7, up: 1.5, right: right * 0.7 }, look: duel ? { between: [A, B] } : A, smoothing: 0.3 } })
  out.push({ kind: 'close_front', pref: duel ? 0.24 : 0.14, fov: 65, ...base, path: { type: 'follow', actor: A, rel: { back: -2.8, up: 1.5, right: right * 0.6 }, look: A, smoothing: 0.3 } })
  const ang = rand() * Math.PI * 2
  out.push({ kind: 'side_track', pref: duel ? 0.2 : 0.07, fov: 62, ...base, path: { type: 'follow', actor: A, offset: [Math.cos(ang) * 6, 2.2, Math.sin(ang) * 6], look: A, smoothing: 0.5 } })
  out.push({ kind: 'high', pref: 0.25, fov: 60, ...base, path: { type: 'follow', actor: A, offset: [Math.cos(ang) * 5, 9, Math.sin(ang) * 5], look: duel ? { between: [A, B] } : A, smoothing: 0.5 } })
  out.push({ kind: 'crane', pref: 0.3, fov: 60, ...base, path: { type: 'static', pos: [a.x + Math.cos(ang) * 7, a.y + 8, a.z + Math.sin(ang) * 7], look: duel ? { between: [A, B] } : A } })
  out.push({ kind: 'top', pref: 0.5, fov: 65, ...base, path: { type: 'follow', actor: A, offset: [0.5, 14, 0.5], look: A, smoothing: 0.5 } })
  // through the player's own eyes: can never be buried, so it is the floor every other
  // candidate has to beat. In caves and tunnels it is often the only view there is.
  out.push({ kind: 'pov', pref: 0.42, fov: 80, ...base, path: { type: 'pov', actor: A } })
  return out
}

// Shots for a world event (an explosion, a lightning strike): wide enough to see it land,
// with the nearest player in the foreground when there is one.
function eventCandidates (win, A, point, ctx, rand) {
  const base = { start_tick: win.start, end_tick: win.end }
  const look = [point.x, point.y + 1.5, point.z]
  const out = []
  const a = A ? ctx.actor(A, win.tick) : null
  if (a) {
    const dx = a.x - point.x; const dz = a.z - point.z
    const d = Math.hypot(dx, dz) || 1
    for (const [back, up] of [[5, 2.6], [8, 4.5]]) {
      out.push({ kind: 'event_over_player', pref: 0, fov: 72, ...base, path: { type: 'static', pos: [a.x + dx / d * back, a.y + up, a.z + dz / d * back], look } })
    }
  }
  const ang = rand() * Math.PI * 2
  for (const [r, up, pref] of [[11, 4, 0.05], [9, 9, 0.12], [15, 14, 0.2]]) {
    for (const k of [0, 1, 2, 3]) {
      const t = ang + k * Math.PI / 2
      out.push({ kind: 'event_wide', pref, fov: 70, ...base, path: { type: 'static', pos: [point.x + Math.cos(t) * r, point.y + up, point.z + Math.sin(t) * r], look } })
    }
  }
  return out
}

// Split the segment into shot windows. Deaths are the story, so each one gets
// an anchored window that starts well before it and holds a beat after, led by
// the victim (and framed with the killer when that is a player). The rest of
// the time is filled with ordinary windows of a few seconds.
function planWindows (duration, deaths, rand, events = []) {
  // deaths first: an event that coincides with a death is covered by the death's window
  const wanted = []
  for (const d of deaths.slice().sort((x, y) => x.tick - y.tick)) {
    if (d.tick < 0 || d.tick > duration) continue
    if (wanted.some(w => Math.abs(w.tick - d.tick) < 40)) continue // two deaths at once: one window
    wanted.push({ tick: d.tick, lead: d.victim, second: d.killer || null, before: 70, after: 45, kind: 'death' })
  }
  for (const e of events.slice().sort((x, y) => x.tick - y.tick)) {
    if (e.tick < 0 || e.tick > duration) continue
    if (e.type !== 'victory' && wanted.some(w => Math.abs(w.tick - e.tick) < 50)) continue
    wanted.push({ tick: e.tick, lead: e.near || null, second: null, before: e.before !== undefined ? e.before : (e.type === 'victory' ? 10 : 30), after: e.after || 55, kind: 'event', point: e.point, what: e.type })
  }
  wanted.sort((x, y) => x.tick - y.tick)
  const anchors = []
  for (const d of wanted) {
    const w = { start: Math.max(0, Math.round(d.tick - d.before)), end: Math.min(duration, Math.round(d.tick + d.after)), lead: d.lead, second: d.second, anchor: d.kind, tick: d.tick, point: d.point, what: d.what }
    const prev = anchors[anchors.length - 1]
    if (prev && w.start < prev.end) { const cut = Math.max(prev.start + 20, Math.min(w.end - 20, Math.round((prev.tick + d.tick) / 2))); prev.end = cut; w.start = cut }
    if (w.end - w.start >= 20) anchors.push(w)
  }
  const out = []
  let t = 0
  const fill = (to) => {
    while (to - t >= 50) {
      let len = Math.round(70 + rand() * 50)
      if (to - (t + len) < 50) len = to - t
      out.push({ start: t, end: t + len })
      t += len
    }
  }
  for (const a of anchors) {
    fill(a.start)
    if (a.start > t) { if (out.length && !out[out.length - 1].anchor) out[out.length - 1].end = a.start; else a.start = t } // a sliver joins a neighbour
    out.push(a)
    t = a.end
  }
  fill(duration)
  if (duration > t) { if (out.length) out[out.length - 1].end = duration; else out.push({ start: 0, end: duration }) }
  return out.filter(w => w.end > w.start)
}

// opts: { id, duration, focus: [names], deaths: [{tick, victim, killer}], ctx, world, present(name, t), center }
function autoShots (opts) {
  const rand = rng('shots:' + opts.id)
  const shots = []
  const notes = []
  let prevKind = null; let n = 1; let turn = 0
  for (const win of planWindows(opts.duration, opts.deaths || [], rand, opts.events || [])) {
    const mid = (win.start + win.end) / 2
    let A, B
    if (win.anchor) {
      A = win.lead || opts.focus[0]; B = win.second
    } else {
      const here = opts.focus.filter(f => opts.present(f, mid))
      const pool = here.length ? here : opts.focus
      // alternate who leads so both sides get screen time
      A = pool[turn++ % pool.length]
      B = pool.find(x => x !== A) || null
    }
    let best = null
    const pool = win.anchor === 'event' ? eventCandidates(win, win.lead, win.point, opts.ctx, rand) : candidates(win, A, B, opts.ctx, rand)
    for (const c of pool) {
      const subjects = win.anchor === 'event' ? [win.point] : (c.kind.startsWith('duel') || c.kind === 'over_shoulder' ? [A, B] : [A])
      const s = score(c, subjects, opts.ctx, opts.world)
      // a death should be watched from outside, not through the victim's eyes
      const cost = s + c.pref + (c.kind === prevKind ? 0.25 : 0) + (win.anchor && c.kind === 'pov' ? 0.3 : 0) + rand() * 0.06
      if (!best || cost < best.cost) best = { c, cost, occlusion: s }
    }
    if (!best || !Number.isFinite(best.cost)) {
      const a = opts.ctx.actor(A, mid) || { x: opts.center[0], y: opts.center[1], z: opts.center[2] }
      best = { c: { kind: 'fallback', fov: 65, start_tick: win.start, end_tick: win.end, path: { type: 'static', pos: [a.x + 6, a.y + 10, a.z + 6], look: [a.x, a.y + 1, a.z] } }, cost: 1, occlusion: 1 }
    }
    if (best.occlusion > 0.35) notes.push(`${opts.id} shot ${n}: best camera (${best.c.kind}) is still ${(best.occlusion * 100).toFixed(0)}% obstructed`)
    const { kind, pref, ...shot } = best.c
    shots.push({ id: `a${n}`, auto: kind + (win.anchor ? ':' + win.anchor : ''), ...shot })
    prevKind = kind
    n++
  }
  return { shots, notes }
}

module.exports = { autoShots, planWindows, score, blocked }
