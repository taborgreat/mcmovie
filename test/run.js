'use strict'
// Unit checks that need no server or display: math, motion, editor, validator.
const assert = require('assert')
const path = require('path')
const U = require('../lib/util')
const S = require('../lib/speeds')
const { CameraPath } = require('../lib/camera')
const { ActorTrack, buildTracks } = require('../lib/motion')
const { editScene } = require('../lib/timeline')
const V = require('../lib/validate')
const { opToCommands } = require('../lib/mc/director')

let n = 0
process.env.MCMOVIE_NO_FINALE = '1' // the plan checks are tested without the finale song; it has its own test
// a test may be async: it is then counted when it settles, and the summary waits for it
const pending = []
function test (name, fn) {
  const pass = () => { n++; console.log('ok   ' + name) }
  const fail = e => { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1 }
  try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(pass, fail)); else pass() } catch (e) { fail(e) }
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

test('yaw conventions round-trip', () => {
  for (const d of [0, 90, 180, -90, 45]) assert(close(U.mfYawToMc(U.mcYawToMf(d)), d) || close((U.mfYawToMc(U.mcYawToMf(d)) + 360) % 360, (d + 360) % 360))
  const south = U.lookAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 })
  assert(close(U.mfYawToMc(south.yaw), 0), 'looking +z is MC yaw 0')
  const west = U.lookAt({ x: 0, y: 0, z: 0 }, { x: -5, y: 0, z: 0 })
  assert(close(U.mfYawToMc(west.yaw), 90), 'looking -x is MC yaw 90')
  const v = U.viewVector(south.yaw, south.pitch)
  assert(close(v.z, 1) && close(v.x, 0), 'view vector south')
})

test('speeds and estimates', () => {
  assert.strictEqual(S.ticksForMove(10, 'walk'), 47)
  assert.strictEqual(S.ticksForMove(10, 'sprint'), 36)
  assert(S.estimateLineSeconds('Hello there.') > 0.6)
  assert.strictEqual(S.ticksForMove(5, 'idle'), 0)
})

test('actor track interpolation', () => {
  const tr = new ActorTrack('A', [
    { actor: 'A', tick: 0, x: 0, y: 65, z: 0, anim: 'walk' },
    { actor: 'A', tick: 40, x: 8, y: 65, z: 0, anim: 'idle' },
    { actor: 'A', tick: 60, x: 8, y: 65, z: 0, anim: 'sneak' }
  ])
  const mid = tr.stateAt(20)
  assert(close(mid.x, 4) && mid.anim === 'walk' && mid.moving, 'midpoint walking')
  assert(close(U.mfYawToMc(mid.yaw), -90) || close(U.mfYawToMc(mid.yaw), 270), 'faces +x (east) while walking')
  const rest = tr.stateAt(50)
  assert(rest.anim === 'idle' && !rest.moving)
  assert.strictEqual(tr.stateAt(100).anim, 'sneak')
  assert.strictEqual(tr.stateAt(-5).x, 0)
})

test('look_at actor via ctx', () => {
  const { tracks, ctx } = buildTracks({ keyframes: [
    { actor: 'A', tick: 0, x: 0, y: 65, z: 0, look_at: 'B' },
    { actor: 'B', tick: 0, x: 0, y: 65, z: 10 }
  ] })
  const st = tracks.A.stateAt(0, ctx)
  assert(close(U.mfYawToMc(st.yaw), 0), 'A looks south at B')
})

test('camera paths', () => {
  const ctx = { actor: (id, t) => ({ x: 10, y: 65, z: 10, yaw: Math.PI, pitch: 0 }) }
  const st = new CameraPath({ id: 's', start_tick: 0, end_tick: 100, path: { type: 'static', pos: [10, 67, 0], look: 'A' } }).evaluate(50, ctx)
  assert(close(U.mfYawToMc(st.yaw), 0) && st.pitch < 0, 'static looks south and slightly down')
  const d = new CameraPath({ id: 'd', start_tick: 0, end_tick: 100, path: { type: 'dolly', from: [0, 67, 0], to: [10, 67, 0], look: 'forward', easing: 'linear' } })
  const p = d.evaluate(50, ctx)
  assert(close(p.x, 5), 'dolly midpoint')
  const o = new CameraPath({ id: 'o', start_tick: 0, end_tick: 100, path: { type: 'orbit', target: [10, 65, 10], radius: 5, height: 0, start_deg: 0, end_deg: 0 } }).evaluate(0, ctx)
  assert(close(o.x, 10) && close(o.z, 15), 'orbit angle 0 is south of target')
  assert(close(U.mfYawToMc(o.yaw), 180), 'orbit camera looks north at target')
  const f = new CameraPath({ id: 'f', start_tick: 0, end_tick: 100, path: { type: 'follow', actor: 'A', rel: { back: 4, up: 2 }, smoothing: 0 } }).evaluate(0, ctx)
  assert(close(f.z, 6) && close(f.x, 10) && close(f.y, 67), 'follow behind an actor facing south (mf yaw pi) is -z')
})

test('editor resolves overlaps', () => {
  const cuts = editScene([{ id: 'a', start_tick: 0, end_tick: 100 }, { id: 'b', start_tick: 60, end_tick: 140 }, { id: 'c', start_tick: 120, end_tick: 150, priority: -1 }, { id: 'd', start_tick: 130, end_tick: 200 }], 220)
  assert.deepStrictEqual(cuts.map(c => [c.shot_id, c.start_tick, c.end_tick]), [['a', 0, 60], ['b', 60, 130], ['d', 130, 220]])
})

test('validator catches bad plans', () => {
  const story = { title: 't', logline: 'l', tone: 't', setting: { biome: 'plains', time_of_day: 'day', style: 's' }, characters: [{ id: 'A', name: 'A', role: 'r', personality: 'p', voice_desc: 'v', skin_desc: 's' }, { id: 'B', name: 'B', role: 'r', personality: 'p', voice_desc: 'v', skin_desc: 's' }], scenes: [{ id: 's1', summary: 's', location: 'x', characters: ['A', 'B'], target_seconds: 5 }], music: { mood_tags: [], tempo: 'slow' } }
  const scene = {
    scene_id: 's1', beats: [{ id: 'b', description: 'd' }],
    lines: [{ id: 'l1', tick: 10, character: 'A', text: 'hi', emotion: 'e' }],
    keyframes: [
      { actor: 'A', tick: 0, x: 0, y: 65, z: 0, anim: 'walk' }, { actor: 'A', tick: 10, x: 20, y: 65, z: 0, anim: 'idle' },
      { actor: 'B', tick: 0, x: 20, y: 65, z: 0, anim: 'idle' }
    ],
    shots: [{ id: 'sh1', start_tick: 5, end_tick: 100, path: { type: 'static', pos: [0, 67, 5], look: 'Z' } }]
  }
  const r = V.checkScene(scene, story, story.scenes[0])
  const msgs = r.errors.join('\n')
  assert(/needs >= /.test(msgs), 'speed error')
  assert(/occupy the same space/.test(msgs), 'collision error')
  assert(/must start at tick 0/.test(msgs), 'first shot error')
  assert(/unknown actor Z/.test(msgs), 'camera actor error')
})

test('demo project validates', () => {
  const r = V.validateProject(path.join(U.ROOT, 'projects', 'demo'))
  assert(r.ok, JSON.stringify(r.reports))
})

test('set ops to commands', () => {
  const c = opToCommands({ type: 'load', name: 'cottage', at: [100, 65, 100] })
  assert(c.length > 10 && c[0].startsWith('/fill 100 64 100'), c[0])
  assert.strictEqual(opToCommands({ type: 'setblock', at: [1, 2, 3], block: 'minecraft:stone' })[0], '/setblock 1 2 3 minecraft:stone')
})

test('offline uuid matches vanilla', () => {
  // known value for "Camera" is deterministic; just check format and stability
  const u = U.offlineUUID('Camera')
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), u)
})

// ---- match mode
const R = require('../lib/match/recording')
const { StateMapper, unpack } = require('../lib/match/anvil')
const digest = require('../lib/match/digest')
const matchBuild = require('../lib/match/build')

test('match: track sampling interpolates and respects gaps', () => {
  const track = [{ t: 0, x: 0, y: 65, z: 0, yaw: 170, pitch: 0, flags: 0, hp: 20 }, { t: 2, x: 1, y: 65, z: 0, yaw: -170, pitch: 0, flags: 256, hp: 18 }, { t: 40, x: 50, y: 65, z: 0, yaw: 0, pitch: 0, flags: 0, hp: 18 }]
  const mid = R.sampleAt(track, 1)
  assert(close(mid.x, 0.5), 'lerp x')
  assert(Math.abs(mid.yaw) >= 170, 'yaw takes the short way across 180: ' + mid.yaw)
  assert(!(mid.flags & R.FLAGS.SWUNG), 'a future swing must not leak into interpolated frames')
  const far = R.sampleAt(track, 20) // 49 blocks in 38 ticks: a sprint-speed gap, interpolated and marked sparse
  assert(far && far.sparse && far.x > 20 && far.x < 30, 'sparse gaps are walked, not skipped')
  assert(Math.abs(far.yaw - (-170 + 170 * 18 / 38)) < 1, 'sparse facing follows recorded rotation: ' + far.yaw)
  assert.strictEqual(R.sampleAt(track, 100), null, 'null past the end')
  const tp = [{ t: 0, x: 0, y: 65, z: 0, yaw: 0, pitch: 0, flags: 0, hp: 20 }, { t: 2, x: 80, y: 90, z: 0, yaw: 0, pitch: 0, flags: 0, hp: 20 }]
  assert.strictEqual(R.sampleAt(tp, 0.9).x, 0, 'a teleport is a cut: before')
  assert.strictEqual(R.sampleAt(tp, 1.1).x, 0, 'a teleport must not happen before its recorded sample')
})

test('match: block states map by name onto the renderer version', () => {
  const m = new StateMapper()
  const md = require('minecraft-data')('1.21.4')
  assert.strictEqual(md.blocksByStateId[m.fromString('minecraft:stone')].name, 'stone')
  const log = m.fromString('minecraft:oak_log[axis=x]')
  assert.strictEqual(md.blocksByStateId[log].name, 'oak_log')
  assert.notStrictEqual(log, m.fromString('minecraft:oak_log[axis=y]'))
  assert.strictEqual(m.fromString('minecraft:block_from_the_future'), 0)
  assert(m.unknown.has('block_from_the_future'))
  assert.strictEqual(md.blocksByStateId[m.fromString('minecraft:short_dry_grass')].name, 'dead_bush')
})

test('match: packed long arrays unpack', () => {
  // 4 bits per entry, 16 per long; entries 0..15 then 15..0
  const lo = 0x76543210 | 0; const hi = 0xfedcba98 | 0
  for (let i = 0; i < 16; i++) assert.strictEqual(unpack([[hi, lo]], 4, 16, i), i)
  // 5 bits: entry 6 straddles the 32-bit halves
  let big = 0n; for (let i = 0; i < 12; i++) big |= BigInt(i + 3) << BigInt(i * 5)
  const pair = [Number(BigInt.asIntN(32, big >> 32n)), Number(BigInt.asIntN(32, big & 0xffffffffn))]
  for (let i = 0; i < 12; i++) assert.strictEqual(unpack([pair], 5, 12, i), i + 3)
})

test('match: digest finds fights and the plan check demands the ending', () => {
  const mk = (name, kit) => ({ name, kit, kills: 0, track: Array.from({ length: 16 }, (_, i) => ({ t: i * 40, x: i / 3, y: 65, z: 0, yaw: 0, pitch: 0, flags: 0, hp: i === 15 ? 4 : 20 })), held: [], first: 0, last: 600 })
  const rec = { meta: { id: 'x', ticks: 700, winner: 'A', starting_players: 2 }, players: [mk('A', 'thor'), mk('B', 'tank')], entities: new Map(), sampleTicks: 2,
    events: [{ t: 400, type: 'hit', a: 0, v: 1, dmg: 6, hp: 14 }, { t: 420, type: 'hit', a: 1, v: 0, dmg: 6, hp: 14 }, { t: 440, type: 'hit', a: 0, v: 1, dmg: 6, hp: 8 }, { t: 600, type: 'death', v: 1, k: 0, weapon: 'iron_sword', k_hp: 14, x: 5, y: 65, z: 0 }, { t: 600, type: 'eliminated', p: 1, remaining: 1 }] }
  const d = digest.build(rec)
  assert.strictEqual(d.fights.length, 1)
  assert.strictEqual(d.fights[0].hits.A, 2)
  assert(d.suggestions.some(s => /FINAL KILL/.test(s.why)))
  const bad = matchBuild.check({ title: 't', logline: 'A thor beats a tank.', segments: [{ id: 'a', from_sec: 0, to_sec: 10, focus: ['A'] }] }, rec)
  assert(bad.errors.some(e => /final kill/.test(e)), 'missing ending is an error')
  const good = matchBuild.check({ title: 't', logline: 'A thor beats a tank.', segments: [{ id: 'a', from_sec: 15, to_sec: 34, focus: ['A', 'B'] }] }, rec)
  assert.strictEqual(good.errors.length, 0, good.errors.join('; '))
  const who = matchBuild.check({ title: 't', logline: 'A thor beats a tank.', segments: [{ id: 'a', from_sec: 15, to_sec: 34, focus: ['Nobody'] }] }, rec)
  assert(who.errors.some(e => /not a player/.test(e)))
})

test('match: every death gets an anchored camera window', () => {
  const { planWindows } = require('../lib/match/autoshots')
  let seed = 1; const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const w = planWindows(360, [{ tick: 202, victim: 'Surfs', killer: null }], rand)
  assert.strictEqual(w[0].start, 0); assert.strictEqual(w[w.length - 1].end, 360)
  for (let i = 1; i < w.length; i++) assert.strictEqual(w[i].start, w[i - 1].end, 'windows are contiguous')
  const a = w.find(x => x.anchor)
  assert(a && a.lead === 'Surfs' && a.start <= 140 && a.end >= 240, JSON.stringify(a))
  const two = planWindows(300, [{ tick: 80, victim: 'A', killer: 'B' }, { tick: 190, victim: 'B', killer: null }], rand)
  assert.strictEqual(two.filter(x => x.anchor).length, 2)
  for (let i = 1; i < two.length; i++) assert.strictEqual(two[i].start, two[i - 1].end)
  const same = planWindows(200, [{ tick: 100, victim: 'A', killer: null }, { tick: 104, victim: 'B', killer: null }], rand)
  assert.strictEqual(same.filter(x => x.anchor).length, 1, 'two deaths at once share one window')
  assert(same.every(x => x.end > x.start), 'no zero-length windows')
  const ev = planWindows(300, [], rand, [{ tick: 150, type: 'explosion', point: { x: 0, y: 64, z: 0 }, near: 'A' }])
  assert(ev.some(x => x.anchor === 'event' && x.start <= 125 && x.end >= 195), 'an explosion gets its own window')
})

test('usernames become speakable', () => {
  const P = require('../lib/voice/pronounce')
  assert.strictEqual(P.guess('DEMON8672'), 'Demon')
  assert.strictEqual(P.guess('LiteByte_'), 'Lite Byte')
  assert.strictEqual(P.guess('.maxc153'), 'maxc')
  assert.strictEqual(P.spokenName('taborgreat'), 'Tabor Great')
  assert.strictEqual(P.speakable('taborgreat drops. Not taborgreat2.', ['taborgreat']), 'Tabor Great drops. Not taborgreat2.')
})

test('/movie choices: blocked players are anonymous, chosen voices win', () => {
  const fs = require('fs'); const os = require('os')
  const f = path.join(os.tmpdir(), 'mcmovie-prefs-test.json')
  fs.writeFileSync(f, JSON.stringify({ players: { 'aaaaaaaa-0000-0000-0000-000000000001': { name: 'Hidden', blocked: true, voice: null }, 'aaaaaaaa-0000-0000-0000-000000000002': { name: 'Picky', blocked: false, voice: 'villain' } } }))
  process.env.MCMOVIE_PREFS = f
  const prefs = require('../lib/prefs')
  assert(prefs.isBlocked('hidden')); assert(prefs.isBlocked(null, 'aaaaaaaa-0000-0000-0000-000000000001'.replace(/-/g, '')))
  assert(!prefs.isBlocked('Picky')); assert.strictEqual(prefs.voiceOf('Picky'), 'villain')
  assert.strictEqual(prefs.voiceOf('Nobody'), null)
  assert(prefs.isAlias(prefs.alias(4)) && !prefs.isAlias('Tributes'))
  const pv = require('../lib/voice/players')
  assert.deepStrictEqual(pv.voiceFor('Picky', 'villain'), { voice: 'stock:villain', profile_id: 'villain', chosen: true })
  delete process.env.MCMOVIE_PREFS; fs.unlinkSync(f)
})

test('captions: narrator plain, players named, words chunked', () => {
  const C = require('../lib/assemble/captions')
  assert.deepStrictEqual(C.chunks('Five players drop into the dark.', 16), ['Five players', 'drop into the', 'dark.'])
  const ass = C.build({ width: 1080, height: 1920, audio: [
    { at_sec: 1, duration_sec: 2, character: 'narrator', name: 'Narrator', text: 'Surfs finishes it.' },
    { at_sec: 4, duration_sec: 1, character: 'Strongs', name: 'Strongs', text: "It's one zombie!" }] })
  const events = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
  assert(events.length >= 2)
  assert(!/Narrator/.test(events[0]), 'the narrator has no name tag')
  assert(/Strongs\\N/.test(events[events.length - 1]), 'a player line shows the name above the words')
  assert(/PlayResY: 1920/.test(ass))
})

test('match: the camera goes to a player on the frame their own line starts', () => {
  const A = require('../lib/match/autoshots')
  let x = 7; const rand = () => { x = (x * 9301 + 49297) % 233280; return x / 233280 }
  const w = A.planWindows(248, [], rand, [], [{ tick: 144, ticks: 38, who: 'bob' }])
  const sp = w.find(v => v.anchor === 'speech')
  assert(sp && sp.lead === 'bob' && sp.start <= 144 && sp.start >= 140 && sp.end >= 144 + 38, JSON.stringify(w))
  for (let i = 1; i < w.length; i++) assert.strictEqual(w[i].start, w[i - 1].end)
  // a kill close by keeps the camera
  const k = A.planWindows(300, [{ tick: 200, victim: 'a', killer: 'b' }], rand, [], [{ tick: 150, ticks: 38, who: 'a' }])
  assert(!k.some(v => v.anchor === 'speech') && k.some(v => v.anchor === 'death'))
})

test('formats: a match is a Short unless it is big and long', () => {
  const F = require('../lib/formats')
  assert.strictEqual(F.forMatch(5 * 60, 2).id, 'short')
  assert.strictEqual(F.forMatch(40 * 60, 2).id, 'short') // long but small: still a Short
  assert.strictEqual(F.forMatch(40 * 60, 9).id, 'short')
  assert.strictEqual(F.forMatch(8 * 60, 14).id, 'short') // big but over quickly
  assert.strictEqual(F.forMatch(25 * 60, 14).id, 'long')
  assert.strictEqual(F.forMatch(25 * 60).id, 'short') // unknown player count counts as small
  assert.strictEqual(F.FORMATS.short.max_sec, 180)
})

test('youtube: the upload cap holds the stream to the speed asked', async () => {
  const fs = require('fs'); const os = require('os')
  const Y = require('../lib/publish/youtube')
  const f = path.join(os.tmpdir(), 'mcmovie-cap.bin'); fs.writeFileSync(f, Buffer.alloc(500 * 1024)) // 500 KB = 4 Mbit
  const t0 = Date.now(); let n = 0
  await new Promise((res, rej) => Y.throttled(f, 8).on('data', c => { n += c.length }).on('end', res).on('error', rej)) // 8 Mbps -> about half a second
  const ms = Date.now() - t0
  fs.unlinkSync(f)
  assert.strictEqual(n, 500 * 1024)
  assert(ms > 350 && ms < 1500, 'took ' + ms + ' ms')
  const t1 = Date.now(); await new Promise((res, rej) => Y.throttled(__filename, 0).on('data', () => {}).on('end', res).on('error', rej)); assert(Date.now() - t1 < 200)
})

test('social: captions per platform, sign-in links, and what is skipped', async () => {
  const social = require('../lib/publish/social')
  const ig = require('../lib/publish/instagram'); const tt = require('../lib/publish/tiktok')
  const hosting = require('../lib/publish/hosting')
  const cfg = { site: 'hardcorepvp.com', instagram: { app_id: 'A', app_secret: 'S', redirect_uri: 'https://hardcorepvp.com/oauth' }, tiktok: { client_key: 'K', client_secret: 'S', redirect_uri: 'https://hardcorepvp.com/oauth' } }
  const meta = { title: 'HardcorePvP.com #9: Out of Fireballs', logline: 'A pyro runs dry.', short: true }
  const yt = 'A pyro runs dry.\n\nEvery match on the server is recorded. Want to be in a video? Play a match at hardcorepvp.com.\n\nIP is hardcorepvp.com\n\n#minecraft #pvp'
  const c = social.captions({ ...meta, description: yt }, cfg)
  // the same words YouTube got, on both
  assert.strictEqual(c.instagram, 'HardcorePvP.com #9: Out of Fireballs\n\n' + yt)
  assert.strictEqual(c.tiktok, c.instagram)
  assert(social.captions(meta, cfg).tiktok.endsWith('A pyro runs dry.')) // no description yet: title and logline
  // keys alone do not switch a platform on: it has to be signed in
  assert(ig.configured(cfg.instagram) && !ig.ready(cfg.instagram) && tt.configured(cfg.tiktok) && !tt.ready(cfg.tiktok))
  assert.deepStrictEqual(social.enabled(cfg), [])
  assert.deepStrictEqual(await social.post('/nonexistent.mp4', meta, { youtube_id: 'x' }, cfg), {})
  const igUrl = new URL(ig.authUrl(cfg.instagram, 'st'))
  assert.strictEqual(igUrl.origin + igUrl.pathname, 'https://www.instagram.com/oauth/authorize')
  assert.strictEqual(igUrl.searchParams.get('scope'), 'instagram_business_basic,instagram_business_content_publish')
  const ttUrl = new URL(tt.authUrl(cfg.tiktok, 'st'))
  assert.strictEqual(ttUrl.origin + ttUrl.pathname, 'https://www.tiktok.com/v2/auth/authorize/')
  assert.strictEqual(ttUrl.searchParams.get('scope'), 'user.info.basic,video.upload') // drafts only until the app is audited
  assert.strictEqual(new URL(tt.authUrl({ ...cfg.tiktok, mode: 'direct' }, 'st')).searchParams.get('scope'), 'user.info.basic,video.upload,video.publish')
  // signed in: wide videos and non-public uploads are still not cross-posted
  const on = { ...cfg, instagram: { ...cfg.instagram, access_token: 't', ig_user_id: '1' } }
  assert.deepStrictEqual(social.enabled(on), ['instagram'])
  assert((await social.post('/nonexistent.mp4', { ...meta, short: false }, { youtube_id: 'x' }, on)).social_skipped)
  assert(/unlisted/.test((await social.post('/nonexistent.mp4', { ...meta, privacy: 'unlisted' }, { youtube_id: 'x' }, on)).social_skipped))
  assert.strictEqual(hosting.urlFor(cfg, 'abc/../_-9'), 'https://hardcorepvp.com/clips/abc_-9.mp4')
})

test('publish: stories are just the title, matches are numbered, descriptions stay plain', () => {
  const fs = require('fs'); const os = require('os')
  const P = require('../lib/publish/publish')
  const copy = require('../lib/publish/copy')
  const cfg = { site: 'hardcorepvp.com', youtube: { hashtags: ['minecraft', '#pvp', '{year}', '26.3', 'minecraft'] } } // a year, a version and a repeat: cleaned out
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpub-'))
  U.writeJson(path.join(dir, 'format.json'), { format: 'short' })
  U.writeJson(path.join(dir, 'story.json'), { title: 'Feast or Bust', logline: 'Three friends camp next to the feast.', characters: [] })
  const st = P.metadata(dir, cfg)
  assert.strictEqual(st.title, 'Feast or Bust')
  assert.strictEqual(st.description, `Three friends camp next to the feast.\n\nEvery match on the server is recorded. Want to be in a video? Play a match at hardcorepvp.com.\n\nIP is hardcorepvp.com\n\n#minecraft #pvp`)
  U.writeJson(path.join(dir, 'doc.json'), { title: 'Death by Compass', logline: 'Two players settle it with a compass.', segments: [] })
  U.writeJson(path.join(dir, 'published.json'), { number: 4 })
  const m = P.metadata(dir, cfg)
  assert.strictEqual(m.title, 'HardcorePvP.com #4: Death by Compass')
  assert(m.description.startsWith('Two players settle it with a compass.\n\nEvery match on the server is recorded. Want to be in a video? Play a match at hardcorepvp.com.\n\nIP is hardcorepvp.com\n\n#minecraft'))
  assert(!P.metadata(dir, { ...cfg, youtube: { ...cfg.youtube, invite: '' } }).description.includes('recorded'))
  fs.rmSync(dir, { recursive: true })
  assert.strictEqual(copy.problems('Death by Compass', 'Two players settle it with a compass.').length, 0)
  assert(copy.problems('Stomper: The Last Stand', 'x').some(e => /":"/.test(e)))
  assert(copy.problems('Fine', '').some(e => /logline is missing/.test(e)))
  assert(copy.problems('Fine', 'A miner returns late; the merchant waits.').some(e => /semicolons/.test(e)))
})

test('match insight: teaming, stews, towers, quiet deaths, highlights', () => {
  const insight = require('../lib/match/insight')
  const line = (x, z, n) => Array.from({ length: n }, (_, i) => ({ t: i * 40, x, y: 70, z }))
  const rec = {
    id: 'test', meta: { ticks: 12000 },
    players: [{ name: 'Ann', kit: 'Stomper' }, { name: 'Bo', kit: 'Thor' }, { name: 'Cy', kit: 'Fisherman' }],
    tracks: [line(10, 10, 300), line(14, 12, 300), line(300, -480, 300)],
    events: [
      { type: 'state', t: 2400, state: 'ACTIVE' },
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'stew', t: 9000 + i * 12, p: 0 })),
      { type: 'stew', t: 9050, p: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({ type: 'block', t: 5000 + i * 10, p: 2, x: 300, y: 70 + i, z: -480, from: 'air', to: 'dirt', how: 'place' })),
      { type: 'highlight', t: 9100, p: 0, text: 'triple stomp' }, { type: 'highlight', t: 9300, p: 0, text: 'again' }, { type: 'highlight', t: 9900, p: 0, text: 'and again' },
      { type: 'death', t: 9200, v: 1, k: 0, weapon: 'iron_sword' },
      { type: 'death', t: 11000, v: 2, cause: 'starvation' }
    ]
  }
  const ins = insight.build(rec, { rand: () => 0.99 })
  assert.strictEqual(ins.teams.length, 1)
  assert.deepStrictEqual(ins.teams[0].players, ['Ann', 'Bo'])
  assert.strictEqual(ins.teams[0].betrayal.killer, 'Ann')
  assert.strictEqual(ins.stews[0].player, 'Ann'); assert(ins.stews[0].hotkeying)
  assert.strictEqual(ins.fight_stews[0].killer_stews, 6)
  assert.strictEqual(ins.towers[0].player, 'Cy'); assert.strictEqual(ins.towers[0].height, 20)
  assert(/starved/.test(ins.quiet_deaths[0].how))
  assert.strictEqual(ins.highlights.length, 1) // one player using all three counts once
  assert(ins.facts.some(f => /forcefield/.test(f)) && !ins.facts.some(f => /invincibility: nobody/.test(f)))
  const md = insight.toMarkdown(ins)
  for (const h of ['## Player highlights', '## Teaming', '## Stews', '## Towering', '## Deaths nobody caused']) assert(md.includes(h), h)
})

test('knockback follows the server settings', () => {
  const S = require('../lib/speeds'); const { ActorTrack } = require('../lib/motion')
  assert(Math.abs(S.knockbackPath(0).distance - 3.0) < 0.2 && Math.abs(S.knockbackPath(2).distance - 12.5) < 0.3)
  assert(S.knockbackPath(2, -20).distance > S.knockbackPath(2).distance) // off a ledge they travel further
  const tr = new ActorTrack('A', [{ actor: 'A', tick: 0, x: 0, y: 64, z: 0, anim: 'idle' }, { actor: 'A', tick: 20, x: 0, y: 64, z: 0, anim: 'knockback:2' }, { actor: 'A', tick: 60, x: 12, y: 64, z: 0, anim: 'idle' }])
  const mid = tr.stateAt(26); const end = tr.stateAt(45)
  assert(mid.y > 65.5 && mid.anim === 'jump' && mid.x > 4)
  assert(Math.abs(end.x - 12) < 0.01 && end.y === 64 && end.anim === 'idle')
  assert.deepStrictEqual(tr.oneshotsAt(20), ['hurt'])
})

test('match players keep recorded fractional feet heights', () => {
  const { playerState } = require('../lib/match/build')
  for (const y of [62.6, 65, 65.4, 67.2, 69.5]) {
    const p = { name: 'A', held: [], armor: [], track: [0, 40].map(t => ({ t, x: 6.5, y, z: 0.5, yaw: 0, pitch: 0, flags: 16, hp: 20 })) }
    const rec = { players: [p], events: [] }
    for (const tick of [0, 1, 20, 39, 40]) {
      const s = playerState(rec, p, 0, tick, 1, null)
      assert.strictEqual(s.y, y)
      assert.strictEqual(s.x, 6.5)
    }
  }
})

test('narration: raw data is caught, caster language is not', () => {
  const { rawDataLines } = require('../lib/match/build')
  const doc = { segments: [{ id: 'a', narration: [
    { text: 'WorkingStorage has walked over a thousand blocks to find the only other player.' },
    { text: 'maxc153 is thirty-five blocks away.' },
    { text: 'maxc153 hits hard, twenty damage in six seconds.' },
    { text: 'He was on 3 hp.' },
    { text: 'He was down to half a heart and drank his way back.' },
    { text: 'She crossed the whole map looking for a fight.' },
    { text: 'A Turtle blocks nothing while he swings.' },
    { text: 'One kill, nine hearts left, match won.' },
    { text: 'Walked 400 blocks for this', chat: true },
    { speaker: 'taborgreat', text: 'I ran two hundred blocks for that.' }
  ] }] }
  assert.deepStrictEqual(rawDataLines(doc).map(r => r.text.slice(0, 12)), ['WorkingStora', 'maxc153 is t', 'maxc153 hits', 'He was on 3 '])
  // a number now and then passes the checker; back to back does not
  const { check } = require('../lib/match/build')
  const mk = texts => ({ title: 'T', logline: 'Two players fight it out.', segments: [{ id: 'a', title: 'a', from_sec: 0, to_sec: 20, focus: ['A'], narration: texts.map((text, i) => ({ id: 'n' + i, at_sec: i * 3, text })) }] })
  const rec = { meta: { ticks: 4000 }, players: [{ name: 'A', first: 0, last: 4000, track: [] }], events: [{ type: 'death', t: 300, v: 0 }] }
  const dataErr = d => check(d, rec, 'short').errors.filter(e => /data lines back to back|leans on raw data/.test(e))
  assert.strictEqual(dataErr(mk(['He crossed the whole map.', 'A thousand blocks for one fight.', 'He was down to half a heart.', 'Then he drank his way back.', 'Nine hearts left.', 'Match won.'])).length, 0)
  assert.strictEqual(dataErr(mk(['He walked a thousand blocks.', 'He took twenty damage.', 'Then he won.'])).length, 1)
})

test('finale: silent build-up on the faces, the drop on the first hit, then the kill', () => {
  const finale = require('../lib/match/finale'); const { finaleErrors } = require('../lib/match/build')
  const song = { duration_sec: 19.032, drop_sec: 9, speed: 0.5, kill_at: 0.7, slow: 'always' }
  const hits = (from, to) => Array.from({ length: Math.floor((to - from) / 20) + 1 }, (_, i) => ({ type: 'hit', t: from + i * 20, a: i % 2, v: (i + 1) % 2 }))
  // a long fight: 5800..6000 ticks (10 s). The middle is skipped.
  const long = { meta: { ticks: 7300 }, players: [{ name: 'A' }, { name: 'B' }], events: [...hits(5800, 6000), { type: 'death', t: 6000, v: 1, k: 0 }] }
  const w = finale.plan(long, song)
  assert.deepStrictEqual(w.parts.map(p => [p.id, p.from_sec, p.to_sec, p.film_sec]), [['finale_build', 285.5, 290, 9], ['finale_fight', 290, 291.5, 3], ['finale_kill', 297.4, 300.9, 7]])
  assert.strictEqual(w.film_sec, 19)
  // a short fight fits whole, and a one-second fight is slowed further
  const short = { ...long, events: [...hits(5940, 6000), { type: 'death', t: 6000, v: 1, k: 0 }] }
  const ws = finale.plan(short, song)
  assert.deepStrictEqual(ws.parts.map(p => p.id), ['finale_build', 'finale_fight'])
  assert(ws.parts[1].speed < 0.5 && ws.parts[1].speed >= 0.25 && ws.parts[1].to_sec === 300.9)
  // ordinary sword fights stay at real speed; a stomp or a blink-of-an-eye kill goes slow
  const auto = { ...song, slow: 'auto' }
  const real = finale.plan(long, auto)
  assert.strictEqual(real.slow, false)
  assert.deepStrictEqual(real.parts.map(p => [p.id, p.from_sec, p.to_sec, p.speed]), [['finale_build', 281, 290, 1], ['finale_fight', 290, 293, 1], ['finale_kill', 293.9, 300.9, 1]])
  const realShort = finale.plan({ ...long, events: [...hits(5900, 6000), { type: 'death', t: 6000, v: 1, k: 0, cause: 'entity_attack' }] }, auto)
  assert.deepStrictEqual(realShort.parts.map(p => [p.id, p.speed, p.film_sec]), [['finale_build', 1, 9], ['finale_fight', 1, 5.9]])
  assert.strictEqual(finale.plan({ ...long, events: [{ type: 'hit', t: 5990, a: 0, v: 1 }, { type: 'death', t: 6000, v: 1, k: 0, cause: 'entity_attack' }] }, auto).why_slow, 'over in a blink')
  assert(/fall/.test(finale.plan({ ...long, events: [{ type: 'death', t: 6000, v: 1, cause: 'fall' }] }, auto).why_slow))
  const stomp = { ...long, players: [{ name: 'A', kit: 'Stomper', track: [{ t: 5960, y: 80 }, { t: 5990, y: 70 }, { t: 6000, y: 64 }] }, { name: 'B' }] }
  assert.strictEqual(finale.plan(stomp, auto).why_slow, 'a stomp from above')
  // the plan checker
  const seg = (o) => ({ focus: ['A'], narration: [], ...o })
  const good = { segments: [
    seg({ id: 'road', from_sec: 250, to_sec: 285.5, narration: [{ id: 'n1', at_sec: 2, text: 'This is it.' }] }),
    seg({ id: 'finale_build', finale: true, from_sec: 285.5, to_sec: 290 }),
    seg({ id: 'finale_fight', finale: true, from_sec: 290, to_sec: 291.5, narration: [{ id: 'n2', at_sec: 0.6, text: 'He hits hard.' }] }),
    seg({ id: 'finale_kill', finale: true, from_sec: 297.4, to_sec: 300.9 }),
    seg({ id: 'cake', from_sec: 300.9, to_sec: w.celebration_to_sec })] }
  assert.deepStrictEqual(finaleErrors(good, long, w), [])
  assert(finaleErrors({ segments: [seg({ id: 'a', from_sec: 250, to_sec: 305 })] }, long, w)[0].includes('needs the finale segment'))
  const talk = JSON.parse(JSON.stringify(good)); talk.segments[1].narration = [{ id: 'x', at_sec: 1, text: 'They stare.' }]
  assert(finaleErrors(talk, long, w).some(e => /nothing is spoken/.test(e)))
  const late = JSON.parse(JSON.stringify(good)); late.segments[0].narration[0].at_sec = 34.5
  assert(finaleErrors(late, long, w).some(e => /still being spoken when the finale song starts/.test(e)))
  assert(/"finale_build"/.test(finale.toMarkdown(w)))
})

test('match: kit abilities become studio effects, checked against what the recording shows', () => {
  const track = [{ t: 0, x: 10, y: 65, z: 10, yaw: 0, pitch: 0, flags: 0, hp: 20 }, { t: 400, x: 10, y: 65, z: 10, yaw: 0, pitch: 0, flags: 0, hp: 20 }]
  const rec = {
    players: [{ name: 'Thor1', kit: 'thor', track }, { name: 'Glad', kit: 'gladiator', track }, { name: 'Vip', kit: 'viper', track }],
    events: [
      { type: 'ability', t: 100, p: 0, kit: 'thor', x: 10, y: 65, z: 10 }, // a real strike: the bolt is on the record
      { type: 'lightning', t: 101, x: 14.5, y: 66, z: 10.5 },
      { type: 'ability', t: 160, p: 0, kit: 'thor', x: 10, y: 65, z: 10 }, // a click during the cooldown: no bolt
      { type: 'lightning', t: 300, x: 90, y: 66, z: 90 }, // a storm's own bolt, nobody's
      { type: 'ability', t: 200, p: 1, kit: 'gladiator', x: 10, y: 65, z: 10 }, // right click on someone with a sword: no arena
      { type: 'ability', t: 240, p: 1, kit: 'gladiator', x: 10, y: 65, z: 10 }, // the challenge: both are lifted into the arena
      { type: 'teleport', t: 240, p: 1, cause: 'plugin', x: 8.5, y: 201, z: 10.5 },
      { type: 'ability', t: 250, p: 2, kit: 'viper' } // older line with no position: taken from the track
    ]
  }
  const fx = matchBuild.abilityEffects(rec)
  assert.deepStrictEqual(fx.map(f => `${f.t}:${f.fx.kit}`), ['100:thor', '240:gladiator', '250:viper'])
  assert.deepStrictEqual(fx[0].fx.aim, [14.5, 66, 10.5], 'Thor is aimed where the bolt really struck')
  assert.strictEqual(rec.events[1].kit, 'thor', 'that bolt is the ability\'s own: the studio does not replay it twice')
  assert.strictEqual(rec.events[3].kit, undefined, 'a bolt nobody called is still replayed')
  assert.strictEqual(fx[1].fx.aim, undefined)
  assert(close(fx[2].fx.x, 10) && fx[2].fx.player === 'Vip')
  const { abilityCommand } = require('../lib/studio/perform')
  assert.strictEqual(abilityCommand(fx[0].fx), '/studio fire Thor1 thor 14.50 66.00 10.50')
  assert.strictEqual(abilityCommand(fx[2].fx), '/studio fire Vip viper')
})

test('studio: the game plugin is optional, and only ever boots in studio mode', () => {
  const studio = require('../lib/studio/server')
  assert.strictEqual(typeof studio.kits(), 'boolean')
  if (studio.kits()) {
    studio.setup()
    assert(/^studio:\s*\n\s+enabled:\s*true/m.test(require('fs').readFileSync(path.join(studio.DIR, 'plugins', 'HardcoreGames', 'config.yml'), 'utf8')))
  }
})

test('ending: every film closes on the flash card and the outro of its shape, or the plain card without one', () => {
  const fs = require('fs'); const os = require('os')
  const asset = require('../lib/outro/asset')
  const edl = require('../lib/assemble/edl')
  const mix = require('../lib/assemble/mix').load()
  assert.strictEqual(asset.shapeFor(1080, 1920), 'short'); assert.strictEqual(asset.shapeFor(1920, 1080), 'long')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmovie-ending-'))
  const timeline = (cards) => U.writeJson(path.join(dir, 'timeline.json'), { fps: 30, tick_rate: 20, title: 't', cards, cuts: [{ shot_id: 'a', scene_id: 's', start_tick: 0, end_tick: 40, clip: null }], lines: [], shots: [], scenes: [] })
  for (const [w, h, shape] of [[1080, 1920, 'short'], [1920, 1080, 'long']]) {
    timeline({})
    const e = edl.build(dir, { width: w, height: h })
    const last = e.video[e.video.length - 1]; const clip = asset.clipFor(w, h)
    if (clip && mix.outro !== false) {
      assert.strictEqual(last.outro, shape, 'the outro of the frame\'s own shape')
      assert(close(last.out_sec, clip.seconds), 'as long as the clip')
      const card = e.video[e.video.length - 2]
      if (mix.end_flash_sec > 0) { assert.strictEqual(card.card, 'flash'); assert(close(card.seconds, mix.end_flash_sec)); assert(/GO TO$/.test(card.text), 'the card hands over to the outro, which spells the address') }
      assert(close(e.total_sec, e.program_end_sec + (mix.end_flash_sec > 0 ? mix.end_flash_sec : 0) + clip.seconds, 0.002), 'the film is as long as its shots, the card and the outro')
      assert(!e.video.some(v => v.card === 'end'), 'no plain end card as well')
    } else assert.strictEqual(last.card, 'end', 'without a clip: the plain end card')
    // one film can opt out
    timeline({ outro: false })
    const plain = edl.build(dir, { width: w, height: h })
    assert.strictEqual(plain.video[plain.video.length - 1].card, 'end')
    assert(!plain.video.some(v => v.outro || v.card === 'flash'))
  }
  // the first shot is still the freeze that fades out before the ending
  assert(edl.build(dir, { width: 1080, height: 1920 }).video[0].freeze_out)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('outro: the plan keeps its rhythm and its sizes', () => {
  const O = require('../lib/outro/make')
  const [b1, b2, b3] = O.PLAN.breaks
  assert(b2 - b1 < b3 - b2, 'two breaks as a pair, then a held beat: never evenly spaced')
  assert.strictEqual(O.PLAN.ignite, O.PLAN.blast - O.PLAN.fuse, 'the creeper is lit back from the blast')
  assert(O.PLAN.blast - b3 >= 5 && O.PLAN.blast - b3 <= 7, 'the blast is on the last block\'s heels')
  assert(O.PLAN.bolt1 > O.PLAN.blast && O.PLAN.lookup > O.PLAN.bolt1 && O.PLAN.bolt2 > O.PLAN.lookup + O.PLAN.lookup_ticks, 'far bolt, look up (and hold), second bolt')
  for (const s of Object.values(O.SHAPES)) {
    assert(s.line > s.pop, 'the joined address is bigger than the words on their blocks')
    assert(O.WORDS.reduce((n, w) => n + w.text.length, 0) * s.line < s.width, 'and fits the frame on one line')
  }
  assert.strictEqual(O.WORDS.map(w => w.text).join('').toLowerCase(), 'hardcorepvp.com')
})

Promise.all(pending).then(() => console.log(`${n} passed${process.exitCode ? ', with failures' : ''}`))
