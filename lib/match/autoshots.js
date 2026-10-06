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
      // Clear terrain is not enough: a player only a few pixels tall is an
      // unreadable subject in a portrait film. Penalize tiny projected size.
      if (typeof id === 'string') {
        const heightFraction = 1.8 / (2 * Math.max(d, 0.1) * Math.tan(U.deg2rad(shot.fov || 65) / 2))
        total += Math.max(0, 0.28 - heightFraction) * 2 / subjects.length
      }
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
  const duel = b && U.dist(a, b) < 10 && Math.abs(a.y - b.y) < 4
  if (duel) {
    const d = U.distXZ(a, b)
    // angle of the line A->B in MC yaw terms; the camera sits perpendicular to it
    const line = U.mfYawToMc(U.lookAt(a, b).yaw)
    const side = rand() < 0.5 ? 90 : -90
    const radius = U.clamp(d / 2 + 3, 3.5, 7)
    const sweep = (25 + rand() * 35) * (rand() < 0.5 ? 1 : -1)
    for (const h of [1.6, 3.2, 5.5]) {
      out.push({ kind: 'duel_orbit', pref: 0 + (h > 2 ? 0.05 : 0) + (h > 4 ? 0.1 : 0), fov: 62, ...base, path: { type: 'orbit', target: { between: [A, B] }, radius, height: h, start_deg: line + side - sweep / 2, end_deg: line + side + sweep / 2, easing: 'linear' } })
    }
    const perp = U.deg2rad(line + side)
    const mx = (a.x + b.x) / 2; const mz = (a.z + b.z) / 2; const my = (a.y + b.y) / 2
    for (const h of [2.0, 4.5]) {
      out.push({ kind: 'duel_static', pref: 0.05 + (h > 3 ? 0.08 : 0), fov: 58, ...base, path: { type: 'static', pos: [mx - Math.sin(perp) * (radius + 1), my + h, mz + Math.cos(perp) * (radius + 1)], look: { between: [A, B] } } })
    }
    out.push({ kind: 'over_shoulder', pref: 0.06, fov: 68, ...base, path: { type: 'follow', actor: A, rel: { back: 5.2, up: 3.0, right: 1.8 }, look: { between: [A, B] }, smoothing: 0.4 } })
  }
  const right = rand() < 0.5 ? 1.3 : -1.3
  out.push({ kind: 'follow_back', pref: duel ? 0.15 : 0.04, fov: 70, ...base, path: { type: 'follow', actor: A, rel: { back: 6.5, up: 3.2, right }, look: A, smoothing: 0.4 } })
  out.push({ kind: 'follow_back_high', pref: duel ? 0.12 : 0.03, fov: 70, ...base, path: { type: 'follow', actor: A, rel: { back: 8.5, up: 6.5, right: 0 }, look: A, smoothing: 0.5 } })
  out.push({ kind: 'follow_front', pref: duel ? 0.2 : 0.08, fov: 56, ...base, path: { type: 'follow', actor: A, rel: { back: -6.2, up: 2.2, right: right * 0.8 }, look: A, smoothing: 0.4 } })
  // tight framings for fights under a forest canopy, where anything further back is in the leaves
  out.push({ kind: 'close_follow', pref: duel ? 0.06 : 0.02, fov: 60, ...base, path: { type: 'follow', actor: A, rel: { back: 3.5, up: 1.8, right: right * 0.7 }, look: A, smoothing: 0.3 } })
  out.push({ kind: 'close_front', pref: duel ? 0.07 : 0.01, fov: 56, ...base, path: { type: 'follow', actor: A, rel: { back: -3.2, up: 1.7, right: right * 0.6 }, look: A, smoothing: 0.3 } })
  const ang = rand() * Math.PI * 2
  out.push({ kind: 'side_track', pref: duel ? 0.2 : 0.07, fov: 62, ...base, path: { type: 'follow', actor: A, offset: [Math.cos(ang) * 8.5, 3, Math.sin(ang) * 8.5], look: A, smoothing: 0.55 } })
  out.push({ kind: 'high', pref: 0.1, fov: 60, ...base, path: { type: 'follow', actor: A, offset: [Math.cos(ang) * 8, 11, Math.sin(ang) * 8], look: duel ? { between: [A, B] } : A, smoothing: 0.5 } })
  out.push({ kind: 'crane', pref: 0.12, fov: 60, ...base, path: { type: 'static', pos: [a.x + Math.cos(ang) * 11, a.y + 10, a.z + Math.sin(ang) * 11], look: duel ? { between: [A, B] } : A } })
  out.push({ kind: 'top', pref: 0.3, fov: 65, ...base, path: { type: 'follow', actor: A, offset: [0.5, 18, 0.5], look: A, smoothing: 0.6 } })
  // from the air: far enough that terrain barely matters and nothing needs dodging
  out.push({ kind: 'aerial', pref: 0.08, fov: 60, ...base, path: { type: 'follow', actor: A, offset: [Math.cos(ang) * 13, 15, Math.sin(ang) * 13], look: duel ? { between: [A, B] } : A, smoothing: 0.7 } })
  // through the player's own eyes: can never be buried, so it is the floor every other
  // candidate has to beat. In caves and tunnels it is often the only view there is.
  out.push({ kind: 'pov', pref: 0.42, fov: 80, ...base, path: { type: 'pov', actor: A } })
  return out
}

// A kit moving someone (an Endermage pulling a player up a tower): when where they were and
// where they end up are close enough to hold in one frame, a fixed wide shot that shows both,
// side-on to the line between them, so the viewer sees the whole move. These are only
// candidates: if the ground is in the way (a pull into a cave, through a hill) they score badly
// and an ordinary shot is used instead. Too far apart and none are offered at all.
function pullCandidates (win, rand) {
  const { from, to } = win.span
  const H = Math.abs(to.y - from.y); const W = Math.hypot(to.x - from.x, to.z - from.z)
  if (Math.hypot(W, H) > 45) return []
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 1, z: (from.z + to.z) / 2 }
  const d = Math.max(0.7 * H, 1.1 * W) + 7
  const base = { start_tick: win.start, end_tick: win.end }
  const a0 = W > 3 ? Math.atan2(to.z - from.z, to.x - from.x) + Math.PI / 2 : rand() * Math.PI * 2
  const out = []
  for (const k of [0, 1, 2, 3, 4, 5]) {
    const t = a0 + k * Math.PI / 3
    for (const up of [0, H * 0.25 + 2]) out.push({ kind: 'pull_wide', pref: -0.25 + (k % 3 ? 0.06 : 0), fov: 60, ...base, path: { type: 'static', pos: [mid.x + Math.cos(t) * d, mid.y + up, mid.z + Math.sin(t) * d], look: [mid.x, mid.y, mid.z] } })
  }
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
function planWindows (duration, deaths, rand, events = [], speech = []) {
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
    wanted.push({ tick: e.tick, lead: e.near || null, second: null, before: e.before !== undefined ? e.before : (e.type === 'victory' ? 10 : 30), after: e.after || 55, kind: 'event', point: e.point, what: e.type, span: e.span, second: e.second || null })
  }
  // a player speaking: the camera is on them from the frame their line starts until it is said,
  // so the voice has a face. A death nearby keeps the camera (the kill is the story).
  for (const sp of speech.slice().sort((x, y) => x.tick - y.tick)) {
    if (sp.tick < 0 || sp.tick > duration - 20) continue
    if (wanted.some(w => w.kind === 'death' && sp.tick > w.tick - w.before && sp.tick < w.tick + w.after)) continue
    wanted.push({ tick: sp.tick, lead: sp.who, second: null, before: 2, after: Math.max(30, (sp.ticks || 40) + 14), kind: 'speech' })
  }
  wanted.sort((x, y) => x.tick - y.tick)
  const anchors = []
  for (const d of wanted) {
    const w = { start: Math.max(0, Math.round(d.tick - d.before)), end: Math.min(duration, Math.round(d.tick + d.after)), lead: d.lead, second: d.second, anchor: d.kind, tick: d.tick, point: d.point, what: d.what, span: d.span }
    const prev = anchors[anchors.length - 1]
    if (prev && w.start < prev.end) {
      // a line starts on its speaker: whatever came before gives way at that frame, and a line
      // keeps its speaker until the next thing actually begins
      const cut = d.kind === 'speech' || prev.anchor === 'speech' ? Math.max(prev.start + 20, Math.min(w.end - 20, w.start)) : Math.max(prev.start + 20, Math.min(w.end - 20, Math.round((prev.tick + d.tick) / 2)))
      prev.end = cut; w.start = cut
    }
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

// A Stomper's kill, seen from above: the camera rides a few blocks over him and a little to
// one side, looking down past him at the player he is falling on, so the height he leaves, the
// drop and the hit are one shot. It starts on him at the top and comes down with him (trailing
// a little as he gathers speed), and ends over the two of them. The side is the one with a
// clear view the whole way down: a tower or a cliff he jumped from is kept out of the lens.
// opts: { duration, killer, victim, from: [x,y,z], to: [x,y,z], ctx, world }
function stompShots (opts) {
  const { killer, victim, ctx, world } = opts
  const D = opts.duration
  let nx = opts.to[0] - opts.from[0]; let nz = opts.to[2] - opts.from[2]
  const h = Math.hypot(nx, nz)
  if (h < 0.3) { nx = 1; nz = 0 } else { nx /= h; nz /= h }
  const SIDE = 3.6; const UP = 7.5
  // beside the line of the fall first (the look never passes straight under the lens), then behind it
  const sides = [[-nz, nx], [nz, -nx], [-nx, -nz], [-nz * 0.7 - nx * 0.7, nx * 0.7 - nz * 0.7], [nz * 0.7 - nx * 0.7, -nx * 0.7 - nz * 0.7]]
  let best = null
  for (const [dx, dz] of sides) {
    let bad = 0; let n = 0
    for (let t = 0; t <= D; t += 2) {
      const a = ctx.actor(killer, t); if (!a) continue
      const cam = { x: a.x + dx * SIDE, y: a.y + UP, z: a.z + dz * SIDE }
      n++
      if (world.isSolid(cam.x, cam.y, cam.z)) { bad += 2; continue }
      if (blocked(world, cam, { x: a.x, y: a.y + 1.5, z: a.z })) bad += 1
      const v = victim ? ctx.actor(victim, t) : null
      if (v && blocked(world, cam, { x: v.x, y: v.y + 1.2, z: v.z })) bad += 0.5
    }
    const cost = n ? bad / n : 9
    if (!best || cost < best.cost - 1e-6) best = { dx, dz, cost }
    if (cost === 0) break
  }
  const look = victim ? { between: [killer, victim] } : killer
  const shot = { id: 'a1', auto: 'stomp_above:death', start_tick: 0, end_tick: D, fov: 65, path: { type: 'follow', actor: killer, offset: [+(best.dx * SIDE).toFixed(2), UP, +(best.dz * SIDE).toFixed(2)], look, smoothing: 0.2, look_smoothing: 0.22 } }
  const notes = best.cost > 0.35 ? [`${opts.id || 'stomp'}: the camera above the stomp is ${(best.cost * 100).toFixed(0)}% obstructed`] : []
  return { shots: [shot], notes }
}

// How much each kind of shot suits a player who is speaking (lower is better): their face, close;
// never through their own eyes, and not from so far or so high that it could be anyone.
const SPEECH_BIAS = { close_front: -0.45, follow_front: -0.4, side_track: -0.1, close_follow: 0, over_shoulder: 0.15, follow_back: 0.2, follow_back_high: 0.35, high: 0.5, crane: 0.5, aerial: 0.6, top: 0.7, pov: 2 }

// opts: { id, duration, focus: [names], deaths: [{tick, victim, killer}], speech: [{tick, ticks, who}], ctx, world, present(name, t), center }
function autoShots (opts) {
  const rand = rng('shots:' + opts.id)
  const shots = []
  const notes = []
  let prevKind = null; let n = 1; let turn = 0
  for (const win of planWindows(opts.duration, opts.deaths || [], rand, opts.events || [], (opts.speech || []).filter(sp => opts.present(sp.who, sp.tick)))) {
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
    const pull = win.what === 'pull' && win.span
    const pool = pull ? [...pullCandidates(win, rand), ...candidates(win, A, B, opts.ctx, rand)] : (win.anchor === 'event' ? eventCandidates(win, win.lead, win.point, opts.ctx, rand) : candidates(win, A, B, opts.ctx, rand))
    for (const c of pool) {
      const subjects = c.kind === 'pull_wide' ? [win.span.from, win.span.to] : pull ? (c.kind.startsWith('duel') || c.kind === 'over_shoulder' ? [A, B] : [A]) : win.anchor === 'event' ? [win.point] : (c.kind.startsWith('duel') || c.kind === 'over_shoulder' ? [A, B] : [A])
      const s = score(c, subjects, opts.ctx, opts.world)
      // a death should be watched from outside, not through the victim's eyes
      // whoever is talking is shown from the front and near enough to tell who it is
      const talk = win.anchor === 'speech' ? (SPEECH_BIAS[c.kind] !== undefined ? SPEECH_BIAS[c.kind] : 0.1) : 0
      const cost = s + c.pref + talk + (c.kind === prevKind && win.anchor !== 'speech' ? 0.25 : 0) + (win.anchor && c.kind === 'pov' ? 0.3 : 0) + rand() * 0.06
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

module.exports = { autoShots, stompShots, planWindows, score, blocked }
