'use strict'
// Who is in which film. Written the moment a film is published, from the film's own
// data, so the list is exactly the players who appear in it: for a match, everyone who
// is on screen in any segment; for a staged story, the real players cast in it.
// Players who used /movie block never get here: the recording already calls them
// TributeN, and blocked players are never cast in stories.
//
// automation/films.json is the record (it stays when the project is deleted). The
// website reads it for /api/films and lists a player's films on their profile.
const path = require('path')
const U = require('../util')
const prefs = require('../prefs')

const FILE = path.join(U.ROOT, 'automation', 'films.json')

function read () { try { return U.exists(FILE) ? U.readJson(FILE) : { films: [] } } catch { return { films: [] } } }

// Who the camera actually caught. For every cut, the camera's view is worked out a few times
// a second and every player standing inside it (within 64 blocks, the distance a player and
// their name tag are drawn at) counts as appearing. A player who was in the area but never in
// the picture is not credited; one who walks through the back of a shot is.
function inFrame (dir) {
  const tlFile = path.join(dir, 'timeline.json')
  if (!U.exists(tlFile)) return null
  const tl = U.readJson(tlFile)
  const { readReplay, replayPath, actorResolver } = require('../mc/replay')
  const { CameraPath } = require('../camera')
  const sz = require('../formats').sizeFor(dir, {})
  const portrait = sz.height > sz.width
  const vfov = U.deg2rad(portrait ? 92 : 70) / 2 + 0.06
  const hfov = Math.atan(Math.tan(vfov) * sz.width / sz.height) + 0.06
  const seen = new Set()
  const replays = new Map()
  let looked = 0
  for (const c of tl.cuts || []) {
    const shot = (tl.shots || []).find(x => x.id === c.shot_id)
    const file = replayPath(dir, c.scene_id)
    if (!shot || !U.exists(file)) continue
    if (!replays.has(c.scene_id)) { const r = readReplay(file); replays.set(c.scene_id, { r, actor: actorResolver(r) }) }
    const { r, actor } = replays.get(c.scene_id)
    const cam = new CameraPath({ ...shot, start_tick: shot.local_start, end_tick: shot.local_end })
    for (let t = c.local_start; t <= Math.min(c.local_end, r.frames.length - 1); t += 4) {
      let pose
      try { pose = cam.evaluate(t, { actor }) } catch { continue }
      looked++
      if (pose.hide) seen.add(pose.hide) // a shot through a player's own eyes is that player's shot
      const f = U.viewVector(pose.yaw, pose.pitch)
      const right = { x: -f.z, z: f.x }; const rl = Math.hypot(right.x, right.z) || 1
      for (const a of r.frames[t].a || []) {
        if (a.invisible || a.dead) continue
        const v = { x: a.x - pose.x, y: a.y + 1 - pose.y, z: a.z - pose.z }
        const d = Math.hypot(v.x, v.y, v.z)
        if (d > 64) continue
        const fwd = v.x * f.x + v.y * f.y + v.z * f.z
        if (fwd < 0.2) continue
        const side = (v.x * right.x + v.z * right.z) / rl
        const up = Math.sqrt(Math.max(0, d * d - fwd * fwd - side * side)) // distance off the view axis, vertically
        if (Math.abs(Math.atan2(side, fwd)) <= hfov && Math.atan2(up, fwd) <= vfov) seen.add(a.username)
      }
    }
  }
  return looked ? seen : null
}

function playersIn (dir) {
  let names = inFrame(dir)
  const isMatch = U.exists(path.join(dir, 'doc.json'))
  if (!names) {
    // no replays left to look through: fall back to who was in each scene
    names = new Set()
    const tl = U.exists(path.join(dir, 'timeline.json')) ? U.readJson(path.join(dir, 'timeline.json')) : { scenes: [] }
    for (const sc of tl.scenes || []) for (const a of sc.actors || []) names.add(typeof a === 'string' ? a : a.id)
  }
  if (!isMatch && U.exists(path.join(dir, 'story.json'))) {
    // a staged film: a character is credited when a real player plays it. Invented stand-ins
    // (a test dummy, a decoy) have nobody behind them.
    const real = new Map((U.readJson(path.join(dir, 'story.json')).characters || []).filter(c => c.player).map(c => [c.id, c.player]))
    names = new Set([...names].filter(n => real.has(n)).map(n => real.get(n)))
  }
  const p = prefs.read()
  return [...names].filter(n => !prefs.isAlias(n) && !prefs.isBlocked(n, null, p)).sort((a, b) => a.localeCompare(b))
}

// One record per video, newest first.
function record (dir, meta, result, privacy) {
  const db = read()
  const entry = {
    id: result.youtube_id, url: result.url, title: meta.title, kind: meta.kind, short: !!meta.short,
    published: result.at, played: meta.played || '', privacy: privacy || 'public', players: playersIn(dir),
    // what the film did (lib/publish/features.js): the record a strategy is judged on later
    features: require('./features').extract(dir, meta, result)
  }
  db.films = [entry, ...db.films.filter(f => f.id !== entry.id)]
  db.updated = new Date().toISOString()
  U.writeJson(FILE, db)
  return entry
}

// Where else a film can be watched (Instagram, TikTok), added as those uploads land.
function link (id, links) {
  const db = read()
  const f = db.films.find(x => x.id === id)
  if (!f) return false
  f.links = { youtube: f.url, ...(f.links || {}), ...links }
  db.updated = new Date().toISOString()
  U.writeJson(FILE, db)
  return true
}

module.exports = { FILE, read, playersIn, record, link }
