'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..')

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
}

function readJsonGz (file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
}

function writeJsonGz (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 }))
}

function exists (file) {
  try { fs.accessSync(file); return true } catch { return false }
}

function projectDir (slug) {
  if (!slug) throw new Error('project slug required')
  if (path.isAbsolute(slug)) return slug
  return path.join(ROOT, 'projects', slug)
}

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function log (stage, msg, ...rest) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] [${stage}] ${msg}`, ...rest)
}

function slugify (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'untitled'
}

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function lerp (a, b, u) { return a + (b - a) * u }

// Shortest-arc interpolation for angles in radians.
function lerpAngle (a, b, u) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * u
}

function deg2rad (d) { return d * Math.PI / 180 }
function rad2deg (r) { return r * 180 / Math.PI }

// Minecraft-convention degrees (0 = south, 90 = west, pitch + = down)
// to mineflayer-convention radians (what every prismarine lib uses).
function mcYawToMf (yawDeg) { return Math.PI - deg2rad(yawDeg) }
function mcPitchToMf (pitchDeg) { return -deg2rad(pitchDeg) }
function mfYawToMc (yaw) { let d = rad2deg(Math.PI - yaw) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d }
function mfPitchToMc (pitch) { return rad2deg(-pitch) }

// Yaw/pitch (mineflayer radians) that looks from `from` toward `to`.
function lookAt (from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const ground = Math.sqrt(dx * dx + dz * dz)
  return { yaw: Math.atan2(-dx + 0, -dz + 0), pitch: Math.atan2(dy, ground) }
}

// Unit view vector for mineflayer yaw/pitch.
function viewVector (yaw, pitch) {
  const c = Math.cos(pitch)
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c }
}

function dist (a, b) {
  const dx = a.x - b.x; const dy = a.y - b.y; const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function distXZ (a, b) {
  const dx = a.x - b.x; const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

function v3 (arr) {
  if (Array.isArray(arr)) return { x: arr[0], y: arr[1], z: arr[2] }
  return { x: arr.x, y: arr.y, z: arr.z }
}

// Offline-mode UUID for a username, as the vanilla server computes it.
function offlineUUID (name) {
  const crypto = require('crypto')
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const h = hash.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// SkinsRestorer looks a skin up on the internet when a player logs in, and forgets it after 15
// minutes by default. When the lookup services are slow or rate-limit us, that lookup holds a
// bot's login until the server drops it ("Took too long to log in") and a take is lost. Our
// servers keep what they have looked up for a month instead. Call before the server starts.
function calmSkinLookups (serverDir) {
  const fs = require('fs'); const path = require('path')
  const f = path.join(serverDir, 'plugins', 'SkinsRestorer', 'config.yml')
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch { return false }
  const out = text.replace(/^(\s*)skinExpiresAfter: \d+/m, '$1skinExpiresAfter: 43200').replace(/^(\s*)uuidExpiresAfter: \d+/m, '$1uuidExpiresAfter: 43200').replace(/^(\s*)disallowAutoUpdateSkin: false/m, '$1disallowAutoUpdateSkin: true')
  if (out !== text) fs.writeFileSync(f, out)
  return out !== text
}

module.exports = { calmSkinLookups,
  ROOT, readJson, writeJson, readJsonGz, writeJsonGz, exists, projectDir, sleep, log, slugify,
  clamp, lerp, lerpAngle, deg2rad, rad2deg, mcYawToMf, mcPitchToMf, mfYawToMc, mfPitchToMc,
  lookAt, viewVector, dist, distXZ, v3, offlineUUID
}
