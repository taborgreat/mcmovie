'use strict'
const assert = require('assert')
const { pulses, identities } = require('../lib/match/evidence')
const { Film } = require('../lib/capture/film')
const { CameraPath } = require('../lib/camera')
const { Creatures } = require('../lib/studio/perform')
const rec = { players: [{ name: 'A', track: [] }], events: [{ type: 'dmg', v: 0, t: 10, dmg: 2 }] }
assert.strictEqual(pulses(rec, 0, 9.5, 10).hurt, true)
assert.strictEqual(pulses(rec, 0, 10, 10.5).hurt, false, 'slow motion cannot replay a hit twice')
assert.strictEqual(pulses(rec, 0, 8, 9).hurt, false, 'no hit before the event')
const ids = identities([{ name: '.Alex', uuid: 'bedrock' }, { name: 'Alex', uuid: 'java' }])
assert.notStrictEqual(ids[0].bot, ids[1].bot)
assert.strictEqual(ids[0].display, 'Alex', 'transport platform must not leak into film labels')
assert.notStrictEqual(ids[0].id, ids[1].id, 'same display names must retain distinct recorded identities')
assert.strictEqual(ids[0].skin, null, 'a Bedrock player must not borrow a same-named Java skin')
let wall = false
const film = new Film({ director: { bot: { blockAt: v => ({ name: wall && v.x === 3 ? 'stone' : 'air', boundingBox: wall && v.x === 3 ? 'block' : 'empty' }) } }, dir: '.', fps: 30, width: 1080, height: 1920 })
const cut = { local_start: 0, local_end: 100, cam: { target: { x: 0, y: 2, z: 0 }, evaluate: () => ({ x: 6, y: 2, z: 0, yaw: 0, pitch: 0 }) }, shot: { path: {} } }
assert(film.pose(cut, 0, {}).x > 5)
wall = true
assert(film.pose(cut, 1, {}).x < 3, 'a new wall must be avoided immediately, not after twelve ticks')
wall = false
const p = film.pose(cut, 2, {})
assert(p.x < 4, 'ease back out after obstruction clears')
const commands = []
const creatures = new Creatures({ cmd: c => commands.push(c) })
const e = { id: 1, mc: 'wolf', x: 0, y: 65, z: 0 }
creatures.tick(0, { e: [e] }, { A: e })
assert(commands[0].includes('Invulnerable:1b'))
creatures.tick(1, { e: [{ ...e, atk: true }] }, { A: e })
assert(!commands.some(c => c.includes('NoAI:0b')), 'confirmed attack cannot enable autonomous combat')
creatures.tick(4, { e: [] }, { A: e })
assert(commands.some(c => c.startsWith('/filmactor remove')), 'missing mob disappears without a death animation')
assert(!commands.some(c => c.startsWith('/kill') || c.startsWith('/filmactor die')), 'leaving recorder range is not death evidence')
commands.length = 0
creatures.struck({ tag: 'wolf' }, null)
assert.deepStrictEqual(commands, ['/filmactor hurt @e[tag=wolf,limit=1]'], 'a recorded hit only plays the effect; it cannot restart combat or remove protection')
const camera = new CameraPath({ id: 'follow', start_tick: 0, end_tick: 100, path: { type: 'follow', actor: 'A', rel: { back: 5, up: 3 } } })
let yaw = Math.PI - 0.01
const ctx = { actor: () => ({ x: 0, y: 0, z: 0, yaw }) }
const before = camera.evaluate(0, ctx); yaw = -Math.PI + 0.01
const after = camera.evaluate(1, ctx)
assert(Math.hypot(before.x - after.x, before.z - after.z) < 0.2, 'heading wrap must not orbit around the actor')
console.log('Replay fidelity regression checks passed')

// An unobstructed but distant shot is not useful portrait coverage.
const { score: shotScore } = require('../lib/match/autoshots')
const openWorld = { isSolid: () => false }
const stationary = { actor: () => ({ x: 0, y: 70, z: 0, yaw: 0, pitch: 0 }) }
const frame = distance => ({ start_tick: 0, end_tick: 40, fov: 60, path: { type: 'static', pos: [0, 71.6, distance], look: 'A' } })
assert(shotScore(frame(4), ['A'], stationary, openWorld) < shotScore(frame(22), ['A'], stationary, openWorld), 'readable portrait framing must beat a distant clear view')
const blockedWorld = { isSolid: (x, y, z) => z > 1.5 && z < 2.5 }
assert(shotScore(frame(4), ['A'], stationary, blockedWorld) > shotScore(frame(22), ['A'], stationary, openWorld), 'framing size must not outweigh a blocked subject')
console.log('Portrait framing checks passed')
const formats = require('../lib/formats')
assert.strictEqual(formats.forMatch(45 * 60, 100, { preferred: require('../lib/auto/config').DEFAULTS.match_format }).id, 'short', 'Max\'s short-form preference applies even to a large, long match')
assert.strictEqual(formats.forMatch(45 * 60, 2, { preferred: 'long' }).id, 'long', 'explicit long-video choice remains available')
assert.strictEqual(formats.forMatch(45 * 60, 100, { preferred: 'auto' }).id, 'long', 'Tabor\'s automatic player-count/duration selection remains available')
const lensFilm = new Film({ director: { bot: { blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }) } }, dir: '.', fps: 30, width: 1080, height: 1920 })
lensFilm.cfg.fov_portrait = 92
const lensCut = { local_start: 0, local_end: 40, cam: { target: { x: 0, y: 72, z: 0 }, evaluate: () => ({ x: 0, y: 72, z: 6, yaw: 0, pitch: 0, fov: 55 }) }, shot: { path: {} } }
const framed = lensFilm.pose(lensCut, 0, {})
assert(Math.abs(framed.z * Math.tan(92 * Math.PI / 360) - 6 * Math.tan(55 * Math.PI / 360)) < 0.01, 'real client lens must preserve planned subject size')
const bodyCut = { local_start: 0, local_end: 40, cam: { target: { x: 0, y: 1.5, z: 0 }, evaluate: () => ({ x: 2, y: 1.5, z: 0, yaw: 0, pitch: 0 }) }, shot: { path: {} } }
const body = { x: 1.7, y: 0, z: 0 }
const bodySafe = lensFilm.pose(bodyCut, 0, { actors: () => [body] })
assert(Math.hypot(bodySafe.x - body.x, bodySafe.z - body.z) >= 0.85 || bodySafe.y >= 2.05, 'a player crossing the camera cannot fill the lens with their body')
assert(Math.hypot(bodySafe.x, bodySafe.y - 1.5, bodySafe.z) >= 1.2, 'avoiding another player must not put the camera inside the subject')
const speechNames = require('../lib/voice/pronounce')
assert.strictEqual(speechNames.speakable('im a stomper silly', [], { chat: true }), "I'm a stomper, silly")
assert.strictEqual(speechNames.speakable('u r afk', [], { chat: true }), 'you are A F K')
assert.strictEqual(speechNames.speakable('cant won', ['cant'], { chat: true }), 'cant won', 'chat contractions must not corrupt a known username')

// Context must retain late conversations, including ones outside combat moments.
const fs = require('fs'); const path = require('path')
const R = require('../lib/match/recording'); const digest = require('../lib/match/digest')
const sample = R.load(path.join(__dirname, '..', 'sample', 'last-match', 'recording'))
sample.events = sample.events.filter(e => e.type !== 'chat')
for (let i = 0; i < 83; i++) sample.events.push({ type: 'chat', t: i * 70, name: sample.players[0].name, text: 'conversation evidence ' + i })
sample.events.sort((a, b) => a.t - b.t)
const out = path.resolve(__dirname, '..', '..', 'work', 'context-regression')
fs.mkdirSync(out, { recursive: true })
digest.write(sample, out)
const files = fs.readdirSync(path.join(out, 'context')).filter(f => f.startsWith('chat-'))
assert.strictEqual(files.length, 3)
const all = files.map(f => fs.readFileSync(path.join(out, 'context', f), 'utf8')).join('\n')
for (let i = 0; i < 83; i++) assert(all.includes('conversation evidence ' + i + '"'))
console.log('Full-match context retention checks passed')

const P = require('../lib/voice/pronounce')
assert.strictEqual(P.spokenName('Dreamyarl0'), 'Dreamy Arlo')
assert.strictEqual(P.guess('DreamyArl0'), 'Dreamy Arlo')
assert.strictEqual(P.guess('maxc153'), 'maxc')
assert.strictEqual(P.guess('42wizards'), 'forty-two wizards')
assert.strictEqual(P.guess('42 wizards'), 'forty-two wizards')
assert.strictEqual(P.guess('K1ng'), 'King')
assert.strictEqual(P.guess('N1nja'), 'Ninja')
assert.strictEqual(P.guess('Dr3amy'), 'Dreamy')
assert.strictEqual(P.guess('Player2'), 'Player two')
assert.strictEqual(P.guess('Agent47'), 'Agent forty-seven')
assert.strictEqual(P.guess('R2D2'), 'R two D two')
const written = 'DreamyArl0 met maxc153 and 42wizards. maxc1534 stayed back.'
assert.strictEqual(P.speakable(written, ['DreamyArl0', 'maxc153', '42wizards']), 'Dreamy Arlo met maxc and forty-two wizards. maxc1534 stayed back.')
assert(written.includes('DreamyArl0'), 'caption source retains the original username')
console.log('Spoken-name / caption separation checks passed')

const proofreading = require('../lib/match/proofread')
const draft = text => ({ segments: [{ id: 's', narration: [{ id: 'n', text }] }] })
assert(proofreading.problems(draft('maxc153 did the maths.')).length)
assert.strictEqual(proofreading.problems(draft('maxc153 did the math.')).length, 0)
assert(proofreading.problems(draft('He definately saw teh tower.')).length === 2)
assert.strictEqual(proofreading.problems(draft('teh won.'), ['teh']).length, 0)
const quote = draft('teh did the maths'); quote.segments[0].narration[0].chat = true
assert.strictEqual(proofreading.problems(quote).length, 0)
const captions = require('../lib/assemble/captions')
const longLine = 'DreamyArl0 did the math and made a very quick decision to run back toward the tower.'
const ass = captions.build({ width: 720, height: 1280, audio: [{ text: longLine, at_sec: 0, duration_sec: 1, character: 'narrator' }] })
const emitted = ass.split('\n').filter(l => l.startsWith('Dialogue:')).map(l => l.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '')).join(' ')
assert.strictEqual(emitted, longLine, 'caption timing must not silently drop the end of a sentence')
console.log('Proofreading and caption completeness checks passed')

const quoteRec = R.load(path.join(__dirname, '..', 'sample', 'last-match', 'recording'))
const recordedQuote = quoteRec.events.find(e => e.type === 'chat')
const quoteDoc = line => ({ title: 'Recorded Words', logline: 'A tower changes the match.', segments: [{ id: 'quote', from_sec: 0, to_sec: quoteRec.meta.ticks / 20, focus: [recordedQuote.name], narration: [{ id: 'line', at_sec: recordedQuote.t / 20, ...line }] }] })
const quoteCheck = line => require('../lib/match/build').check(quoteDoc(line), quoteRec).errors
const actualQuote = { text: recordedQuote.text, speaker: recordedQuote.name, chat: true }
assert(!quoteCheck(actualQuote).some(e => /never said|recorded player speaker|invented dialogue/.test(e)))
assert(quoteCheck({ ...actualQuote, text: recordedQuote.text + ' I never said this.' }).some(e => /never said exactly/.test(e)), 'unrecorded words cannot be attributed to a player')
assert(quoteCheck({ ...actualQuote, chat: false }).some(e => /invented dialogue/.test(e)), 'omitting the chat marker cannot bypass evidence validation')
assert(quoteCheck({ text: recordedQuote.text, chat: true }).some(e => /recorded player speaker/.test(e)), 'a real quote still needs its recorded speaker')
console.log('Recorded player dialogue checks passed')
