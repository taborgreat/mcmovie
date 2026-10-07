'use strict'
// Regressions for the visible ladder drop and portal snap, plus adjacent
// failures that must never be hidden by camera smoothing or silent export.
const assert = require('assert')
const path = require('path')
const R = require('../lib/match/recording')
const B = require('../lib/match/build')
const { CameraPath } = require('../lib/camera')
const { Film } = require('../lib/capture/film')
const { ActorBot } = require('../lib/mc/actor')
const { statesAt } = require('../lib/mc/replay')
const { missingMedia } = require('../lib/assemble/ffmpeg')
const point = (t, x, y = 73, z = 0) => ({ t, x, y, z, yaw: 0, pitch: 0, flags: 16, hp: 20 })
const near = (a, b) => assert(Math.abs(a - b) < 0.001, `${a} != ${b}`)

// Neighbouring travel must not pull a stationary player into a portal frame.
const rest = [point(0, 0), point(40, 5), point(80, 5), point(120, 0)]
for (let t = 40; t <= 80; t += 0.25) near(R.sampleAt(rest, t).x, 5)
const corners = [point(0, 0), point(40, 8), point(80, 8, 74, 5), point(120, -1, 75, 5)]
for (let i = 0; i < corners.length - 1; i++) for (let t = corners[i].t; t <= corners[i + 1].t; t += 0.25) {
  const s = R.sampleAt(corners, t)
  for (const k of ['x', 'y', 'z']) assert(s[k] >= Math.min(corners[i][k], corners[i + 1][k]) - 1e-8 && s[k] <= Math.max(corners[i][k], corners[i + 1][k]) + 1e-8, `spline overshot ${k}`)
}
near(R.sampleAt([point(0, 0, 100), point(2, 0, 94)], 1).y, 97)
console.log('PASS: stationary anchors, bounded corners, continuous fast falls')

const teleports = R.withTeleports([point(0, 0), point(40, 3)], [
  { t: 10, x: 12, y: 73, z: 0, from: [1, 73, 0] },
  { t: 20, x: 2, y: 73, z: 0, from: [13, 73, 0] }
])
near(R.sampleAt(teleports, 9.999).x, 1)
near(R.sampleAt(teleports, 10).x, 12)
near(R.sampleAt(teleports, 19.999).x, 13)
near(R.sampleAt(teleports, 20).x, 2)
assert.strictEqual(R.sampleAt(teleports, 21).motionEpoch, 2)
const a = { ...point(0, 0), username: 'A', motionEpoch: 0 }
const b = { ...point(1, 12), username: 'A', motionEpoch: 1 }
const fractional = statesAt({ frames: [{ t: 0, a: [a] }, { t: 1, a: [b] }] }, 0.99).get('actor:A')
near(fractional.x, 0)
const resolve = require('../lib/mc/replay').actorResolver({ frames: [{ t: 0, a: [a] }, { t: 1, a: [b] }] })
assert.strictEqual(resolve('A', 0.99).motionEpoch, 0)
assert.strictEqual(resolve('A', 1).motionEpoch, 1, 'shot planning must receive the same teleport boundary as live filming')
assert.throws(() => R.orderedTrack([{ ...point(1, 0), x: NaN }], 'A'), /invalid x/)
assert.deepStrictEqual(R.orderedTrack([point(2, 2), point(0, 0), point(2, 3)], 'A').map(s => [s.t, s.x]), [[0, 0], [2, 3]])
console.log('PASS: exact repeated teleports, fractional replay cuts, corrupt/duplicate track handling')

const rec = R.load(path.join(__dirname, '..', 'sample', 'last-match', 'recording'))
// Real failing windows: no terrain helper may replace evidence at either a
// sparse frame or its exact saved anchor, including ladder/portal transitions.
let checked = 0
for (const [from, to] of [[263, 274.3], [301.8, 305.8]]) for (const [idx, p] of rec.players.entries()) {
  for (let t = Math.round(from * 20); t <= Math.round(to * 20); t++) {
    const src = R.sampleAt(p.track, t)
    const st = B.playerState(rec, p, idx, t, 1, null, new Proxy({}, { get: () => { throw new Error('terrain cannot rewrite recorded players') } }))
    if (!src) continue
    for (const k of ['x', 'y', 'z']) near(st[k], src[k])
    checked++
  }
}
console.log(`PASS: ${checked} real ladder/portal player frames retain their recorded positions`)

const camera = new CameraPath({ id: 'test', start_tick: 0, end_tick: 100, path: { type: 'follow', actor: 'A', offset: [0, 3, 5], smoothing: 1 } })
let actor = { x: 0, y: 0, z: 0, yaw: 0, motionEpoch: 0 }
const ctx = { actor: () => actor }
camera.evaluate(0, ctx)
actor = { ...actor, x: 2, motionEpoch: 1 }
const jumped = camera.evaluate(1, ctx)
assert(camera.cut, 'even a short recorded teleport resets the follow camera')
near(jumped.x, 2)
near(camera.target.x, 2)
camera.evaluate(2, ctx)
assert(!camera.cut, 'teleport cut occurs once, not on every subsequent frame')
const forward = new CameraPath({ start_tick: 0, end_tick: 20, path: { type: 'dolly', from: [0, 3, 0], to: [0, 3, 4], look: 'forward' } })
assert(Number.isFinite(forward.evaluate(10, {}).yaw))
console.log('PASS: follow camera and aim reset together at teleports; forward-looking dolly works')

const commands = []
const stone = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const air = { name: 'air', boundingBox: 'empty', shapes: [] }
let block = { name: 'ladder', boundingBox: 'block', shapes: [[0, 0, 0.875, 1, 1, 1]] }
const film = new Film({ director: { cmd: c => commands.push(c), bot: { blockAt: v => v.x === 0 && v.y === 0 && v.z === 0 ? block : air } }, dir: '.', fps: 30, width: 1080, height: 1920 })
assert(!film.solid(0.5, 0.5, 0.35), 'empty part of ladder cell stays clear')
assert(film.solid(0.5, 0.5, 0.8), 'actual ladder surface retains lens clearance')
block = { name: 'slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] }
assert(!film.solid(0.5, 0.9, 0.5))
assert(film.solid(0.5, 0.6, 0.5))
const pose = { x: 0, y: 3, z: 4, yaw: 0, pitch: 0 }
film.move(0, pose); film.move(1, pose); film.move(0, pose); film.move(1, pose)
assert(commands[0].includes('OnGround:1b') && commands[2].includes('OnGround:0b'))
assert(commands[1].includes('OnGround:1b') && commands[3].includes('OnGround:0b'))
film.move(0, pose, true)
assert(commands.at(-1).includes('teleport_duration:0'))
film.director.bot.blockAt = () => stone
assert.throws(() => film.pose({ local_start: 0, local_end: 1, shot: { id: 'sealed', path: {} }, cam: { target: null, evaluate: () => pose } }, 0, {}), /no clear lens position/)
console.log('PASS: partial-block clearance, independent camera updates, hard cuts, sealed-lens rejection')

const bot = new ActorBot({}, { id: 'A' })
assert.throws(() => bot.sendPose({ x: NaN, y: 0, z: 0 }, 0, 0), /invalid replay pose/)
bot.disconnected = true
assert.throws(() => bot.sendPose({ x: 0, y: 0, z: 0 }, 0, 0), /disconnected/)
bot.disconnected = false
bot.beginReplay(); bot.replayPose = { x: 3, y: 73, z: 4 }
for (let i = 0; i < 5; i++) bot.observeServerPosition({ x: 3, y: 73, z: 4 })
assert.strictEqual(bot.poseCorrections, 0, 'real teleport confirmations at the requested pose are allowed')
for (let i = 0; i < 3; i++) bot.observeServerPosition({ x: 2, y: 73, z: 4 })
assert.throws(() => bot.sendPose({ x: 0, y: 0, z: 0 }, 0, 0), /desynced take/)
bot.endReplay()
const missing = missingMedia({ video: [{ shot_id: 'ladder' }], audio: [{ line_id: 'speech', wav: 'missing-voice.wav' }], warnings: ['line omitted has no wav; skipped'] })
assert(missing.some(s => s.includes('ladder')) && missing.some(s => s.includes('speech')) && missing.some(s => s.includes('omitted')))
assert.deepStrictEqual(missingMedia({ video: [{ card: 'end', seconds: 2 }], audio: [] }), [])
assert.throws(() => Film.assertCoverage([{ t: 0 }, { t: 2 }], 1, 3, 30), /missing footage/)
Film.assertCoverage([{ t: 0 }, { t: 4 - 1 / 30 }], 1, 3, 30)
console.log('PASS: disconnected/invalid actors and missing media stop incomplete final exports')

const fs = require('fs'); const zlib = require('zlib'); const os = require('os')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmovie-recording-'))
try {
  fs.writeFileSync(path.join(fixture, 'meta.json'), JSON.stringify({ complete: true, ticks: 500, players: [{ name: 'A' }] }))
  const write = (name, text) => fs.writeFileSync(path.join(fixture, name), zlib.gzipSync(text))
  write('tracks.csv.gz', '0,0,0,73,0,0,0,16,20\n400,0,6,73,0,0,0,16,20\n')
  write('events.jsonl.gz', '{"t":0,"type":"state","state":"PLAYING"}\n{broken\n')
  assert.throws(() => R.load(fixture), /invalid event JSON/)
  write('events.jsonl.gz', '')
  const missingTrack = R.load(fixture)
  const plan = { title: 'Gap check', logline: 'A missing piece.', segments: [{ id: 'gap', from_sec: 0, to_sec: 21, focus: ['A'], narration: [] }] }
  assert(B.check(plan, missingTrack).errors.some(e => e.includes('no movement samples')))
  missingTrack.players[0].track[1].x = 0
  assert(!B.check(plan, missingTrack).errors.some(e => e.includes('no movement samples')), 'a long recorded rest does not invent movement')
  write('tracks.csv.gz', '0,0,0,73,0,0,0,16,20\n400,0,6,73,0,0,0\n')
  assert.throws(() => R.load(fixture), /incomplete player pose/)
  const speech = require('../lib/voice/client')
  const line = { id: 'test', character: 'narrator', text: 'He went AFK.', group: false, voice: { voice: 'stock:deadpan' } }
  const names = require('../lib/voice/pronounce').knownNames(fixture)
  const saved = { wav: 'test.wav', duration_sec: 1.5, norm_db: 3.2, profile: 'deadpan', voice_key: speech.cacheKey(line, names) }
  fs.writeFileSync(path.join(fixture, 'test.wav'), '')
  fs.writeFileSync(path.join(fixture, 'voice_result.json'), JSON.stringify({ mock: false, lines: { test: saved } }))
  const timeline = { lines: [{ id: 'test' }] }
  speech.restoreCached(fixture, timeline, [line])
  assert.strictEqual(timeline.lines[0].norm_db, 3.2)
  assert.strictEqual(timeline.lines[0].wav, 'test.wav')
  for (const changed of [{ ...line, voice: { voice: 'stock:gruff' } }, { ...line, delivery: 'shouting' }, { ...line, text: 'He stayed.' }]) {
    const fresh = { lines: [{ id: 'test' }] }
    speech.restoreCached(fixture, fresh, [changed])
    assert(!fresh.lines[0].wav, 'changed speech must not reuse a stale WAV')
  }
  fs.writeFileSync(path.join(fixture, 'voice_result.json'), JSON.stringify({ mock: true, lines: { test: saved } }))
  const fresh = { lines: [{ id: 'test' }] }
  speech.restoreCached(fixture, fresh, [line])
  assert(!fresh.lines[0].wav, 'mock speech cannot become a real cache after rebuild')
} finally { fs.rmSync(fixture, { recursive: true, force: true }) }
console.log('PASS: corrupt files, long moving gaps, stale/mock speech and lost voice levelling are covered')
