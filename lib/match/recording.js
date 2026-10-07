'use strict'
// Reads match recordings written by the hardcorekits plugin
// (com.hardcorekits.record.MatchRecorder). A recording is a folder:
//   meta.json, tracks.csv.gz, entities.csv.gz, events.jsonl.gz, region/
// Recordings are disposable: `remove` deletes one once its movie is made.
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const U = require('../util')
const prefsLib = require('../prefs')

const FLAGS = { SNEAKING: 1, SPRINTING: 2, SWIMMING: 4, GLIDING: 8, ON_GROUND: 16, HAND_RAISED: 32, INVISIBLE: 64, IN_VEHICLE: 128, SWUNG: 256, HURT: 512 }

function root () {
  return process.env.MCMOVIE_RECORDINGS || path.join(os.homedir(), 'hgserver', 'plugins', 'HardcoreGames', 'recordings')
}

function readMeta (dir) {
  const f = path.join(dir, 'meta.json')
  if (!U.exists(f)) return null
  try { return U.readJson(f) } catch { return null }
}

// Finished recordings, oldest first. `ready` means the map's region files are in place.
function list (dir = root()) {
  if (!U.exists(dir)) return []
  return fs.readdirSync(dir).sort().map(name => {
    const d = path.join(dir, name)
    const meta = readMeta(d)
    if (!meta) return null
    return { id: meta.id || name, dir: d, complete: !!meta.complete, ready: !!meta.complete && U.exists(path.join(d, 'region')), players: (meta.players || []).length, winner: meta.winner || null, seconds: Math.round((meta.ticks || 0) / 20), started: meta.started_ms ? new Date(meta.started_ms).toISOString() : null }
  }).filter(Boolean)
}

function resolve (idOrDir) {
  if (!idOrDir || idOrDir === 'latest') {
    const ready = list().filter(r => r.ready)
    if (!ready.length) throw new Error(`no finished recordings in ${root()}`)
    return ready[ready.length - 1].dir
  }
  if (U.exists(path.join(idOrDir, 'meta.json'))) return path.resolve(idOrDir)
  const d = path.join(root(), idOrDir)
  if (U.exists(path.join(d, 'meta.json'))) return d
  throw new Error(`recording not found: ${idOrDir}`)
}

function gunzipText (file) {
  if (!U.exists(file)) return ''
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
}

function load (idOrDir) {
  const dir = resolve(idOrDir)
  const meta = readMeta(dir)
  const players = (meta.players || []).map(p => ({ ...p, track: [] }))
  // tracks: t,p,x,y,z,yaw,pitch,flags,hp
  for (const line of gunzipText(path.join(dir, 'tracks.csv.gz')).split('\n')) {
    if (!line) continue
    const c = line.split(',')
    if (c.length < 9 || c.slice(0, 9).some(v => !v.trim())) throw new Error('incomplete player pose in tracks.csv.gz')
    const p = players[+c[1]]
    if (!p) continue
    p.track.push({ t: +c[0], x: +c[2], y: +c[3], z: +c[4], yaw: +c[5], pitch: +c[6], flags: +c[7], hp: +c[8] })
  }
  const entities = new Map()
  for (const line of gunzipText(path.join(dir, 'entities.csv.gz')).split('\n')) {
    if (!line) continue
    const c = line.split(',')
    if (c.length < 8 || c.slice(0, 8).some(v => !v.trim())) throw new Error('incomplete entity pose in entities.csv.gz')
    const id = +c[1]
    if (!entities.has(id)) entities.set(id, { id, type: c[2], track: [] })
    entities.get(id).track.push({ t: +c[0], x: +c[3], y: +c[4], z: +c[5], yaw: +c[6], pitch: +c[7] })
  }
  let events = []
  const eventLines = gunzipText(path.join(dir, 'events.jsonl.gz')).split('\n').filter(l => l.trim())
  for (let i = 0; i < eventLines.length; i++) {
    let event
    try { event = JSON.parse(eventLines[i]) } catch {
      if (i === eventLines.length - 1 && !meta.complete) continue // torn final line of an interrupted recording
      throw new Error(`invalid event JSON at line ${i + 1}; cannot reconstruct a reliable match`)
    }
    if (!event || !Number.isFinite(event.t)) throw new Error(`invalid event tick at line ${i + 1}`)
    events.push(event)
  }
  events.sort((a, b) => a.t - b.t)
  // /movie choices. The plugin already anonymises players who were blocked when the match
  // was played; this catches anyone who blocked afterwards, before the film was made.
  const prefs = prefsLib.read()
  players.forEach((p, i) => {
    if (!p.anon && prefsLib.isBlocked(p.name, p.uuid, prefs)) {
      const real = p.name
      p.name = prefsLib.alias(i); p.uuid = ''; p.anon = true
      events = events.filter(e => !(e.type === 'chat' && e.name === real))
      for (const e of events) if (e.type === 'player' && e.p === i) { e.name = p.name; delete e.uuid }
      if (meta.winner === real) meta.winner = p.name
    }
    if (!p.voice) p.voice = prefsLib.voiceOf(p.anon ? null : p.name, p.uuid, prefs) || null
  })
  // held item timeline per player
  for (const p of players) { p.held = []; p.armor = [] }
  for (const e of events) {
    if (e.type === 'held' && players[e.p]) players[e.p].held.push({ t: e.t, item: e.item })
    if (e.type === 'armor' && players[e.p]) players[e.p].armor.push({ t: e.t, worn: e.worn })
  }
  for (const p of players) {
    p.track = orderedTrack(p.track, p.name)
    p.track = withTeleports(p.track, events.filter(e => e.type === 'teleport' && players[e.p] === p))
    p.first = p.track.length ? p.track[0].t : null
    p.last = p.track.length ? p.track[p.track.length - 1].t : null
  }
  for (const e of entities.values()) e.track = orderedTrack(e.track, `entity ${e.id}`)
  return { dir, meta, players, entities, events, regionDir: path.join(dir, 'region'), sampleTicks: meta.sample_ticks || 2, idleSampleTicks: meta.idle_sample_ticks || meta.sample_ticks || 2 }
}

// Sample a track at fractional tick t. Returns null outside the track.
// Sparse poses are evidence too: never snap them to terrain or push them
// sideways. Bound the interpolated path to its anchors, including at rest.
const TELEPORT_BLOCKS_PER_TICK = 1.5
const SPARSE_GAP_TICKS = 6
function orderedTrack (track, who) {
  for (const s of track) for (const k of ['t', 'x', 'y', 'z', 'yaw', 'pitch', ...('hp' in s ? ['hp', 'flags'] : [])]) {
    if (!Number.isFinite(s[k])) throw new Error(`invalid ${k} in recording for ${who} at tick ${s.t}`)
  }
  // Last row wins at a repeated tick; binary search requires increasing time.
  return [...new Map(track.map(s => [s.t, s])).values()].sort((a, b) => a.t - b.t)
}

function discontinuity (a, b) {
  const dt = b.t - a.t
  // A real fall can exceed walking speed. Do not freeze it until landing.
  return b.cut || (dt > 0 && (Math.hypot(b.x - a.x, b.z - a.z) / dt > TELEPORT_BLOCKS_PER_TICK || Math.abs(b.y - a.y) / dt > 5))
}

function withTeleports (track, events) {
  if (!track.length) return track
  const poses = new Map(track.map(s => [s.t, { ...s }]))
  for (const e of events.slice().sort((a, b) => a.t - b.t)) {
    if (![e.t, e.x, e.y, e.z].every(Number.isFinite)) throw new Error('invalid recorded teleport at tick ' + e.t)
    if (e.t < track[0].t || e.t > track[track.length - 1].t) continue
    const before = [...poses.values()].filter(s => s.t <= e.t).sort((a, b) => b.t - a.t)[0]
    const base = { ...before, flags: before.flags & ~(FLAGS.HURT | FLAGS.SWUNG), cut: false }
    // The recorder knows both sides of the teleport. Approach its departure
    // point, then cut on the event tick, even for two teleports in one sample gap.
    if (Array.isArray(e.from) && e.from.length === 3 && e.from.every(Number.isFinite)) {
      poses.set(e.t - 0.001, { ...base, t: e.t - 0.001, x: e.from[0], y: e.from[1], z: e.from[2] })
    }
    poses.set(e.t, { ...base, ...poses.get(e.t), t: e.t, x: e.x, y: e.y, z: e.z, cut: true })
  }
  const out = [...poses.values()].sort((a, b) => a.t - b.t)
  let epoch = 0
  for (let i = 0; i < out.length; i++) {
    if (i && discontinuity(out[i - 1], out[i])) { epoch++; out[i].cut = true }
    out[i].motionEpoch = epoch
  }
  return out
}

function boundedCoordinate (a, b, before, after, key, u) {
  const dt = b.t - a.t; const delta = b[key] - a[key]
  if (delta === 0) return a[key] // neighbours cannot make a stationary actor wander
  const slope = delta / dt
  const tangent = (p, q) => {
    if (!p || !q || discontinuity(p, q) || q.t - p.t > 200) return slope
    const other = (q[key] - p[key]) / (q.t - p.t)
    // Monotone Hermite: stop at reversals; limit acceleration without overshoot.
    return slope * other <= 0 ? 0 : 2 * slope * other / (slope + other)
  }
  const m1 = tangent(before, a) * dt; const m2 = tangent(b, after) * dt
  const u2 = u * u; const u3 = u2 * u
  const value = (2 * u3 - 3 * u2 + 1) * a[key] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * b[key] + (u3 - u2) * m2
  return U.clamp(value, Math.min(a[key], b[key]), Math.max(a[key], b[key]))
}

function sampleAt (track, t, tolerance = 3) {
  if (!track.length || t < track[0].t - tolerance || t > track[track.length - 1].t + tolerance) return null
  let lo = 0; let hi = track.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (track[mid].t <= t) lo = mid; else hi = mid - 1 }
  const a = track[lo]
  const b = track[Math.min(lo + 1, track.length - 1)]
  if (b === a || t <= a.t) return { ...a }
  const gap = b.t - a.t
  const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z
  if (discontinuity(a, b)) return { ...a }
  const u = (t - a.t) / gap
  const sparse = gap > SPARSE_GAP_TICKS
  let x = a.x + dx * u; let z = a.z + dz * u
  if (sparse) {
    x = boundedCoordinate(a, b, track[lo - 1], track[lo + 2], 'x', u)
    z = boundedCoordinate(a, b, track[lo - 1], track[lo + 2], 'z', u)
  }
  // Looking sideways/backwards is real gameplay. Never replace a recorded look
  // direction with travel heading; doing so flips heads at sparse/dense boundaries.
  const dyaw = ((b.yaw - a.yaw) % 360 + 540) % 360 - 180
  const yaw = a.yaw + dyaw * u; const pitch = U.lerp(a.pitch, b.pitch, u)
  // Transient flags are handled as timed impulses, not interpolated state.
  return { t, x, y: a.y + dy * u, z, yaw, pitch, flags: a.flags & ~(FLAGS.SWUNG | FLAGS.HURT), hp: a.hp, sparse, speed: Math.hypot(dx, dz) / gap, motionEpoch: a.motionEpoch || 0 }
}

function heldAt (player, t) {
  let item = ''
  for (const h of player.held) { if (h.t <= t) item = h.item; else break }
  return item
}

// "helmet,chestplate,leggings,boots" material names the player wore at tick t ("" = none).
function armorAt (player, t) {
  let worn = ''
  for (const a of player.armor || []) { if (a.t <= t) worn = a.worn; else break }
  return worn === ',,,' ? '' : worn
}

// Delete a recording folder. Refuses anything that does not look like one.
function remove (idOrDir) {
  const dir = resolve(idOrDir)
  if (!U.exists(path.join(dir, 'meta.json')) || !U.exists(path.join(dir, 'tracks.csv.gz'))) throw new Error(`${dir} is not a recording; not deleting`)
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}

module.exports = { FLAGS, root, list, resolve, load, sampleAt, heldAt, armorAt, remove, readMeta, orderedTrack, withTeleports }
