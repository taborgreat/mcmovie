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
    const p = players[+c[1]]
    if (!p) continue
    p.track.push({ t: +c[0], x: +c[2], y: +c[3], z: +c[4], yaw: +c[5], pitch: +c[6], flags: +c[7], hp: +c[8] })
  }
  const entities = new Map()
  for (const line of gunzipText(path.join(dir, 'entities.csv.gz')).split('\n')) {
    if (!line) continue
    const c = line.split(',')
    const id = +c[1]
    if (!entities.has(id)) entities.set(id, { id, type: c[2], track: [] })
    entities.get(id).track.push({ t: +c[0], x: +c[3], y: +c[4], z: +c[5], yaw: +c[6], pitch: +c[7] })
  }
  let events = []
  for (const line of gunzipText(path.join(dir, 'events.jsonl.gz')).split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* torn last line of a crashed run */ }
  }
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
    p.first = p.track.length ? p.track[0].t : null
    p.last = p.track.length ? p.track[p.track.length - 1].t : null
  }
  return { dir, meta, players, entities, events, regionDir: path.join(dir, 'region'), sampleTicks: meta.sample_ticks || 2, idleSampleTicks: meta.idle_sample_ticks || meta.sample_ticks || 2 }
}

// Sample a track at fractional tick t. Returns null outside the track.
// Tracks are dense around fights and sparse (a point every couple of
// seconds) while a player only travels; any gap is interpolated. Over a
// sparse gap the player faces the way they are going and `sparse` is set so
// the caller can put them back on the ground. A jump no player could run
// (a teleport) is a cut, not a glide.
const TELEPORT_BLOCKS_PER_TICK = 1.5
const SPARSE_GAP_TICKS = 6
function sampleAt (track, t, tolerance = 3) {
  if (!track.length || t < track[0].t - tolerance || t > track[track.length - 1].t + tolerance) return null
  let lo = 0; let hi = track.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (track[mid].t <= t) lo = mid; else hi = mid - 1 }
  const a = track[lo]
  const b = track[Math.min(lo + 1, track.length - 1)]
  if (b === a || t <= a.t) return { ...a }
  const gap = b.t - a.t
  const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z
  const jump = Math.hypot(dx, dy, dz)
  if (jump / gap > TELEPORT_BLOCKS_PER_TICK) return (t - a.t) * 2 <= gap ? { ...a } : { ...b }
  const u = (t - a.t) / gap
  const sparse = gap > SPARSE_GAP_TICKS
  let x = a.x + dx * u; let z = a.z + dz * u
  let hx = dx; let hz = dz // heading
  if (sparse) {
    // A straight line between points two seconds apart cuts every corner. Bend the path
    // through its neighbours instead (Hermite spline with finite-difference tangents).
    const p0 = track[lo - 1]; const p3 = track[lo + 2]
    const ok = (p, q) => p && q && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) / Math.max(1, Math.abs(q.t - p.t)) <= TELEPORT_BLOCKS_PER_TICK && Math.abs(q.t - p.t) < 200
    const m1x = ok(p0, a) ? (b.x - p0.x) / (b.t - p0.t) * gap : dx; const m1z = ok(p0, a) ? (b.z - p0.z) / (b.t - p0.t) * gap : dz
    const m2x = ok(b, p3) ? (p3.x - a.x) / (p3.t - a.t) * gap : dx; const m2z = ok(b, p3) ? (p3.z - a.z) / (p3.t - a.t) * gap : dz
    const u2 = u * u; const u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1; const h10 = u3 - 2 * u2 + u; const h01 = -2 * u3 + 3 * u2; const h11 = u3 - u2
    x = h00 * a.x + h10 * m1x + h01 * b.x + h11 * m2x
    z = h00 * a.z + h10 * m1z + h01 * b.z + h11 * m2z
    const d00 = 6 * u2 - 6 * u; const d10 = 3 * u2 - 4 * u + 1; const d01 = -6 * u2 + 6 * u; const d11 = 3 * u2 - 2 * u
    hx = d00 * a.x + d10 * m1x + d01 * b.x + d11 * m2x
    hz = d00 * a.z + d10 * m1z + d01 * b.z + d11 * m2z
  }
  let yaw; let pitch
  if (sparse && Math.hypot(dx, dz) > 0.8) { yaw = Math.atan2(-hx, hz) * 180 / Math.PI; pitch = 0 } else {
    const dyaw = ((b.yaw - a.yaw) % 360 + 540) % 360 - 180
    yaw = a.yaw + dyaw * u; pitch = U.lerp(a.pitch, b.pitch, u)
  }
  // a swing or a hit lands on the sample after it happened; only carry it when that sample is close
  const carried = sparse ? 0 : (b.flags & (FLAGS.SWUNG | FLAGS.HURT))
  return { t, x, y: a.y + dy * u, z, yaw, pitch, flags: (a.flags & ~(FLAGS.SWUNG | FLAGS.HURT)) | (u < 0.5 ? (a.flags & (FLAGS.SWUNG | FLAGS.HURT)) : 0) | carried, hp: a.hp, sparse, speed: Math.hypot(dx, dz) / gap }
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

module.exports = { FLAGS, root, list, resolve, load, sampleAt, heldAt, armorAt, remove, readMeta }
