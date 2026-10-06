'use strict'
// The outro every film ends on, as Tabor described it, filmed in the real game.
//
// The camera sits in a sealed pocket inside a mass of stone: dark. A miner
// outside ("noob", plain Steve, no name tag) digs toward it and breaks three
// blocks of the wall, top to bottom, the last an iron ore; each break is a
// real one (the strike, cracks, bits, the pop) and punches a hole that lets
// the daylight in, close enough that the three holes fill four fifths of the
// frame. A word pops at each hole: HARDCORE, PVP, .COM. A creeper comes up
// behind him, hissing, and goes off 0.3 s after the last block. The stone is
// gone in the flash: open daylight, and him still standing, chest deep in the
// crater. The three words stay where they popped, trembling tighter. A bolt of
// lightning hits a cow in the field behind (nothing is built back there) and
// sets it alight; it runs. He thinks he got away with it, looks up at the
// words and holds the look, and a second bolt lands on him: we see it hit,
// then the words slam together into the address, branded white-hot, as the
// picture cuts to black. The address cools, holds, and fades with the thunder.
//
// Sound rhythm ("buda buda, buda KINK"): strike-break, strike-break, (hiss),
// strike-break, BOOM ... thunder far off ... crack, STAMP.
//
// Two steps, so the words can be redone without filming again:
//   film()  the take, with the real client (lib/capture) on the set server,
//           once per shape -> assets/outro/raw_<shape>.mp4
//   post()  finds the frames where things really happened in the take and
//           lays the words, the flashes and the cut to black over it on those
//           frames -> assets/outro/outro_<shape>.mp4 (+ outro.json: the beats)
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { Vec3 } = require('vec3')
const U = require('../util')
const asset = require('./asset')

// The beats, in ticks from the first frame (20 a second). The rhythm is Tabor's, after the
// lamp that hops on the letter: "buda buda, buda KINK". Two breaks as a quick pair, a held beat
// where nothing breaks and the creeper is heard and seen swelling, the third break, and the
// blast on its heels; the stamp is the tail of that one accent. Each "buda" is the pickaxe's
// strike and then the block giving way. `lead` is how many ticks before its beat a thing has
// to be sent for the picture to land on it (measured from filmed takes).
const PLAN = {
  end: 130, // 6.5 s filmed; the finished clip ends when the address and the thunder are gone (about 6 s)
  breaks: [9, 18, 33], // 0.45 s, 0.9 s ... 1.65 s: never evenly spaced
  dig_ticks: [6, 6, 13], // how long he is on each block before it goes (an iron pickaxe; the ore is slower)
  strike: 3, // the strike is heard this many ticks before its block breaks
  blast: 39, // 1.95 s: 0.3 s after the last block
  fuse: 20, // the creeper is lit this long before (1 s: the hiss fills the held beat)
  bolt1: 55, // 2.75 s: the far bolt, once the creeper's blast has been taken in (0.8 s after it)
  // The first bolt is a background gag, as it happened by itself in an early take: it comes down
  // on a cow grazing behind the scene, and the cow runs about on fire. Nothing is built back
  // there and nothing blows up. The cow is an ordinary one with its own mind, put there just
  // before the clip starts: [blocks behind the wall, blocks across from the camera's line] (to
  // one side, so it is not behind him or the words). The bolt lands where the cow really is.
  cow: [20, 2.6],
  lookup: 65, // 3.25 s (half a second of relief after the far bolt): he has stood in his crater long enough to think he got away with it, and looks up at the words
  lookup_ticks: 6, // the tilt takes 0.3 s, and then he holds the look, staring up, until the bolt (0.45 s)
  bolt2: 80, // 4.0 s: the second bolt, on him and in the lens: its own moment, watched. The stamp answers it (STAMP below)
  stamp_after: 4, // ticks from the bolt to the stamp's own sounds (0.2 s: crack, then STAMP)
  bolt2_kills: 3, // ticks later it is the end of him: until then he stands in it, lit, so the strike is seen on him
  bolt2_count: 2, // one of the game's bolts is thin this close, three white the picture out
  title_hold: 0.95, // seconds from the stamp until the address starts to dim: it cools (0.7 s) and rests a moment
  title_fade: 1.0, // then it dims with the thunder dying away, and both are gone together
  knock_up: 0.3, // how hard it lifts him (blocks a tick; a player's own jump is 0.42): a jolt, not a launch
  stamp_sounds: [['minecraft:item.mace.smash_ground_heavy', 1, 0.8], ['minecraft:block.anvil.land', 0.8, 0.8], ['minecraft:item.mace.smash_ground', 0.6, 0.7], ['minecraft:block.fire.extinguish', 1, 0.9]], // the stamp: iron on iron, and the brand sizzling as it cools
  lead: -1,
  miner: 'noob', // the account's name; the tag over his head is hidden for the take
  skin: 'MHF_Steve', // Mojang's own account that wears the classic Steve
  tool: 'minecraft:iron_pickaxe',
  wall: ['minecraft:stone', 'minecraft:stone', 'minecraft:iron_ore'], // the three blocks he breaks, top to bottom: the last is the prize
  mass: 'minecraft:infested_stone', // looks exactly like stone, and is no other block on the stage, so it can be taken away by name
  // The crater he is left standing in, one block deep so only his head and chest show over its
  // rim: [from, to] boxes of [along, across, up] taken out on the blast tick, behind the flash.
  pit: [[[1, -1, -1], [3, 1, -1]], [[2, -2, -1], [2, 2, -1]], [[4, 0, -1], [4, 0, -1]], [[2, 0, -2], [3, 1, -2]]],
  gamma: 0.0, // the game's darkest brightness setting for this film: the pocket must really be dark
  // Where it is filmed on the set world (seed "hardcorepvp"): the wall's bottom hole, and the way
  // the camera looks (0 south, 1 west, 2 north, 3 east). Open plain behind, nothing in the way of
  // the far rock. If the world is not that world any more (the ground there is different), a
  // flat place is scouted instead (scout_seed; or --near x,z).
  spot: { wall: [46, 70, 146], facing: 3 },
  scout_seed: 11,
  fov: 30, // the game's longest lens: the three holes fill the frame and he is right behind them, not down a tunnel
  fill: 0.8, // the three holes (their far edge, where the daylight is) span this much of the frame's height
  pocket: 7 // blocks from the wall back to the end of the pocket: just room for the camera
}

// Per shape: where the camera is in the pocket (blocks behind the wall, across, above the
// floor) and what it looks at; how big the words are when they pop and when they are joined.
// The camera is level with the middle block, as far back as it takes for the three holes to
// span `fill` of the frame: 1.5 blocks / (fill * tan(fov / 2)) from the wall's outer face.
const CAM = { w: 0.5 - 1.5 / (PLAN.fill * Math.tan(U.deg2rad(PLAN.fov) / 2)), l: 0, y: 1.5, look: [0, 0, 1.5] }
const SHAPES = {
  // pop: the size of a word on its block; line: the size of the joined address, which is as big
  // as the frame's width allows with a margin and always bigger than pop (the words grow as they
  // lock, never shrink); it sits in the middle: it is the whole mark.
  // slam_from: this shape's own overshoot for the stamp (the vertical line already fills the
  // width, so it can only come in a little oversized).
  // knock: where the creeper's blast puts him down in the crater, [along, across]: to one side,
  // so that .COM, which stays where its block was, is beside his face and not on it
  short: { width: 1080, height: 1920, cam: CAM, pop: 56, line: 68, line_y: 0.5, slam_from: 1.15, knock: [1.35, 0.85] },
  long: { width: 1920, height: 1080, cam: CAM, pop: 69, line: 120, line_y: 0.5, knock: [1.35, 1.0] }
}
// dy: where in its hole a word sits, in blocks above the middle
const WORDS = [{ text: 'HARDCORE', color: 'white', dy: 0 }, { text: 'PVP', color: '0xFFFF55', dy: -0.09 }, { text: '.COM', color: 'white', dy: 0 }]
PLAN.ignite = PLAN.blast - PLAN.fuse // set back from the blast, so the blast is what lands on its mark
const FPS = 30
const PRE_BLAST_GAIN = 1.8 // how much the quiet first half is lifted in the finished clip (x1.8 = +5 dB)
const WORK = path.join(asset.DIR, 'work')
const PRE = 30
const POST = 12

function alive (pid) { try { process.kill(pid, 0); return true } catch { return false } }

// The unattended loop films with the same client and display. Refuse to start over it.
function busy () {
  const client = require('../capture/client')
  const st = client.readState()
  if (st && [st.launcher, st.xvfb].some(p => p && alive(p))) return 'the filming client is running (capture/work/client.json)'
  const pid = path.join(U.ROOT, 'studio', 'server.pid')
  if (U.exists(pid) && alive(parseInt(fs.readFileSync(pid, 'utf8'), 10))) return 'the studio server is running (a match film is being made)'
  return null
}

// ---- the stage -------------------------------------------------------------

function groundTop (bot, x, z, from) {
  for (let y = from; y > from - 40; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)))
    if (!b) return null
    if (b.name === 'water' || b.name === 'lava') return null
    if (b.boundingBox === 'block' && !/leaves|log|wood/.test(b.name)) return y
  }
  return null
}

// A layout is the wall's place and the way the camera faces. Everything else is measured from
// it: w blocks along the camera's view (the wall is 0, the pocket is behind it, the miner
// and the creeper in front), l blocks across, y blocks above the miner's ground.
function layout (ox, g, oz, facing) {
  const a = [[0, 1], [-1, 0], [0, -1], [1, 0]][facing] // south, west, north, east
  const r = [-a[1], a[0]]
  const at = (w, l, y = 0) => [ox + 0.5 + a[0] * w + r[0] * l, g + y, oz + 0.5 + a[1] * w + r[1] * l]
  const blk = (w, l, y = 0) => { const p = at(w, l, y); return [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])] }
  return { ox, g, oz, facing, a, r, at, blk }
}

// The flattest place on the scouted stage for the miner and the creeper to stand, and the way
// to face there. A facing can be forced (the backdrop is a matter of taste).
function findSpot (bot, terrain, facing) {
  const [cx, cy, cz] = terrain.origin
  let best = null
  for (const f of facing !== undefined ? [facing] : [0, 1, 2, 3]) {
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        const g0 = groundTop(bot, cx + dx, cz + dz, cy + 8)
        if (g0 === null) continue
        const L = layout(cx + dx, g0 + 1, cz + dz, f)
        let bad = 0
        for (let w = -PLAN.pocket - 2; w <= 11; w++) {
          for (let l = -3; l <= 3; l++) {
            const p = L.at(w, l)
            const g = groundTop(bot, p[0], p[2], cy + 8)
            if (g === null) { bad += 50; continue }
            // in front of the wall the ground has to be level; under the stone it only must not stick out
            bad += w >= 1 ? Math.abs(g - g0) * (Math.abs(l) <= 2 ? 3 : 1) : Math.max(0, g - g0) + Math.max(0, g0 - g - 1)
          }
        }
        bad += (Math.abs(dx) + Math.abs(dz)) * 0.05
        if (!best || bad < best.bad) best = { bad, L }
      }
    }
  }
  if (!best) throw new Error('no ground for the outro stage here; try --near x,z')
  return best.L
}

const xyz = p => p.map(v => (Number.isInteger(v) ? String(v) : v.toFixed(2))).join(' ')
function box (L, from, to) {
  const A = L.blk(...from); const B = L.blk(...to)
  return [[0, 1, 2].map(i => Math.min(A[i], B[i])), [0, 1, 2].map(i => Math.max(A[i], B[i]))]
}

// What the take destroys (a crater where the stone stood) is put back afterwards from a copy
// kept deep under the stage, so both shapes are filmed on the same ground and the set world
// is left as it was found.
const KEEP = { from: [-PLAN.pocket - 5, -9, -8], to: [14, 9, 8], down: 30 }
function backup (director, L, restore = false) {
  const [lo, hi] = box(L, KEEP.from, KEEP.to)
  const dlo = [lo[0], lo[1] - KEEP.down, lo[2]]; const dhi = [hi[0], hi[1] - KEEP.down, hi[2]]
  director.cmd(restore ? `/clone ${xyz(dlo)} ${xyz(dhi)} ${xyz(lo)}` : `/clone ${xyz(lo)} ${xyz(hi)} ${xyz(dlo)}`)
}

async function build (director, L) {
  const fill = (from, to, what) => { const [lo, hi] = box(L, from, to); director.cmd(`/fill ${xyz(lo)} ${xyz(hi)} ${what}`) }
  const P = PLAN.pocket
  // standing room in front of the wall, and nothing growing in the way
  fill([1, -2, 0], [4, 2, 3], 'minecraft:air')
  for (const plant of ['minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern', '#minecraft:flowers', 'minecraft:snow']) fill([1, -5, 0], [12, 5, 2], `minecraft:air replace ${plant}`)
  // a clear view of the cow
  for (const tag of ['#minecraft:logs', '#minecraft:leaves']) fill([5, -9, 0], [PLAN.cow[0] + 12, 9, 22], `minecraft:air replace ${tag}`)
  // the mass: two blocks of stone round the pocket on every side but the front, where the wall is one thick
  fill([-P - 2, -3, -1], [0, 3, 5], PLAN.mass)
  fill([-P, -1, 0], [-1, 1, 2], 'minecraft:air')
  for (let i = 0; i < 3; i++) director.cmd(`/setblock ${xyz(L.blk(0, 0, 2 - i))} ${PLAN.wall[i]}`)
  await director.settle(400, 5000)
}

// Behind the wall there must be nothing but the field: no block anybody put there (an earlier
// take's, a story's). Anything worked or carried that stands in the camera's view is reported.
function strays (bot, L) {
  const found = {}
  for (let w = 1; w <= PLAN.cow[0] + 25; w++) {
    for (let l = -14; l <= 14; l++) {
      for (let y = -3; y <= 12; y++) {
        const b = bot.blockAt(new Vec3(...L.blk(w, l, y)))
        if (b && /cobble|infested|brick|plank|_ore$|tnt|glass|wool|concrete|obsidian|torch|fence|chest|furnace|crafting/.test(b.name)) found[b.name] = (found[b.name] || 0) + 1
      }
    }
  }
  return Object.entries(found).map(([name, n]) => `${n} ${name}`)
}

// ---- the take --------------------------------------------------------------

async function take (ctx, shape, cam) {
  const { director, film, miner, L } = ctx
  const bot = director.bot
  const name = PLAN.miner
  const lead = PLAN.lead
  director.cmd('/kill @e[tag=ocreep]'); director.cmd('/kill @e[type=minecraft:item]'); director.cmd('/kill @e[type=minecraft:experience_orb]')
  backup(director, L)
  await U.sleep(600)
  await build(director, L)

  // the miner: just outside the wall, facing it (and so the camera)
  const feet = (w, l) => { const p = L.at(w, l); const g = groundTop(bot, p[0], p[2], L.g + 6); return { x: p[0], y: (g === null ? L.g - 1 : g) + 1, z: p[2] } }
  const mpos = feet(1.0, -0.2)
  const eye = { x: mpos.x, y: mpos.y + 1.62, z: mpos.z }
  const holes = [2, 1, 0].map(i => L.blk(0, 0, i)) // top to bottom
  const lookAtHole = i => U.lookAt(eye, { x: holes[i][0] + 0.5, y: holes[i][1] + 0.5, z: holes[i][2] + 0.5 })
  if (miner.dead) { miner.bot._client.write('client_command', { actionId: 0 }); miner.dead = false; await U.sleep(600) }
  let look = lookAtHole(0)
  await miner.place(director, mpos, look.yaw, look.pitch)
  director.cmd(`/effect give ${name} minecraft:instant_health 1 4 true`)
  director.cmd(`/item replace entity ${name} weapon.mainhand with ${PLAN.tool}`)

  // the creeper: from well behind him, a little to one side so it is seen past him, to his shoulder
  const blastTick = PLAN.blast
  const cFrom = [11, 0.6]; const cTo = [2.7, 0.45]
  const creeperAt = t => {
    const u = U.clamp((t + PRE) / (blastTick - lead + PRE), 0, 1)
    const e = 1 - Math.pow(1 - u, 1.5) // it slows as it swells
    const p = feet(U.lerp(cFrom[0], cTo[0], e), U.lerp(cFrom[1], cTo[1], e))
    return { ...p, yaw: U.mfYawToMc(U.lookAt(p, mpos).yaw) }
  }
  const c0 = creeperAt(-PRE)
  // the one cow in the country (every other animal near the stage was sent away)
  const cow = feet(PLAN.cow[0], PLAN.cow[1])
  director.cmd('/kill @e[tag=ocow]')
  director.cmd(`/summon minecraft:creeper ${c0.x.toFixed(2)} ${c0.y.toFixed(2)} ${c0.z.toFixed(2)} {Tags:["ocreep"],NoAI:1b,PersistenceRequired:1b,Fuse:${PLAN.fuse}s,Rotation:[${c0.yaw.toFixed(1)}f,0f]}`)

  // one fixed camera in the pocket
  const pos = L.at(cam.w, cam.l, cam.y); const aim = L.at(...cam.look)
  const shot = { id: 'outro', local_start: 0, local_end: PLAN.end, path: { type: 'static', pos, look: aim } }
  const cut = { shot_id: 'outro', scene_id: 'outro', local_start: 0, local_end: PLAN.end, start_tick: 0, end_tick: PLAN.end }
  const camCtx = { actor: () => null }
  await U.sleep(800)
  await director.settle(400, 4000)
  await film.begin({ id: 'outro' }, [cut], [shot], camCtx, L.at(-2, 0, 1))

  // what really happened, by the clock: used to find the frames afterwards
  const seen = { breaks: [null, null, null], blasts: [] }
  const onBlock = (oldB, newB) => {
    if (!newB || newB.name !== 'air') return
    const i = holes.findIndex(h => h[0] === newB.position.x && h[1] === newB.position.y && h[2] === newB.position.z)
    if (i >= 0 && seen.breaks[i] === null) seen.breaks[i] = Date.now()
  }
  const onBlast = () => seen.blasts.push(Date.now())
  bot.on('blockUpdate', onBlock)
  miner.bot._client.on('explosion', onBlast)

  const { TickClock } = require('../mc/tickclock')
  const clock = new TickClock(director)
  clock.start()
  let seq = 0; let late = 0; let digging = -1; let sealed = false; let struck = false
  // after the blast: where he stands (he drops into the crater as the ground goes) and where he looks
  const cur = { ...mpos }
  const land = L.at(...SHAPES[shape].knock)
  // the arc: thrown up at knock_up, falling as the game makes a player fall, landing a block lower
  const arc = { pts: [{ d: 0, y: 0 }], air_ticks: 0 }
  for (let v = PLAN.knock_up, y = 0, i = 1; i < 60; i++) { y += v; v = (v - 0.08) * 0.98; if (y <= -1) { arc.pts.push({ d: i, y: -1 }); break } arc.pts.push({ d: i, y }) }
  arc.air_ticks = arc.pts.length - 1
  const camLook = at => U.lookAt({ x: at.x, y: at.y + 1.62, z: at.z }, { x: pos[0], y: pos[1], z: pos[2] })
  const dig = (status, b) => miner.bot._client.write('block_dig', { status, location: { x: b[0], y: b[1], z: b[2] }, face: 3, sequence: ++seq })
  for (let t = -PRE; t <= PLAN.end + POST; t++) {
    // the cow is let go just before the clip starts, so it has not wandered far by the strike
    if (t === -PRE + 2) director.cmd(`/summon minecraft:cow ${cow.x.toFixed(2)} ${cow.y.toFixed(2)} ${cow.z.toFixed(2)} {Tags:["ocow"],PersistenceRequired:1b}`)
    // the miner: each block is started so that it gives way on its beat
    PLAN.breaks.forEach((beat, i) => {
      if (t === beat - lead - PLAN.dig_ticks[i]) { dig(0, holes[i]); digging = i; look = lookAtHole(i) }
      // the strike of the pickaxe, as the one mining hears it (the game plays it to nobody else)
      if (t === beat - lead - PLAN.strike) director.cmd(`/playsound minecraft:block.stone.hit block ${film.lens} ${xyz(holes[i].map(v => v + 0.5))} 1 0.5`)
      if (t === beat - lead) { dig(2, holes[i]); digging = -1 }
      // if the game did not take the dig, the block still breaks for real, two ticks late
      if (t === beat - lead + 2 && (bot.blockAt(new Vec3(...holes[i])) || {}).name !== 'air') { director.cmd(`/setblock ${xyz(holes[i])} minecraft:air destroy`); U.log('outro', `block ${i + 1} was broken by command (the dig did not finish)`) }
    })
    const since = t - (blastTick - lead)
    if (since >= 1) {
      // The blast throws him: the arc a real hit gives, kept short, coming down a block lower
      // in the crater the same tick took out from under him.
      const k = Math.min(since, arc.air_ticks); const p = arc.pts[k]; const far = arc.pts[arc.air_ticks].d
      cur.x = U.lerp(mpos.x, land[0], p.d / far); cur.z = U.lerp(mpos.z, land[2], p.d / far); cur.y = mpos.y + p.y
      const air = since < arc.air_ticks
      // he looks out at where the wall was (the camera), and then, on his mark, up at the words;
      // in the air his head is thrown back and round
      const want = camLook(cur)
      const up = t >= PLAN.lookup - lead ? U.clamp((t - (PLAN.lookup - lead) + 1) / PLAN.lookup_ticks, 0, 1) : 0
      want.pitch += (0.95 - want.pitch) * up * up * (3 - 2 * up)
      const spin = Math.sin(Math.PI * since / arc.air_ticks)
      look = air
        ? { yaw: want.yaw + 0.7 * spin, pitch: want.pitch + 0.9 * spin }
        : { yaw: U.lerpAngle(look.yaw, want.yaw, 0.5), pitch: up > 0 ? want.pitch : look.pitch + (want.pitch - look.pitch) * 0.35 }
    }
    if (!miner.dead && t < PLAN.bolt2 - lead + PLAN.bolt2_kills) {
      miner.sendPose(cur, look.yaw, look.pitch, since < 1 || since >= arc.air_ticks)
      if (digging >= 0) miner.swing()
    }
    // the creeper
    if (t < blastTick - lead) {
      const c = creeperAt(t)
      director.cmd(`/tp @e[tag=ocreep,limit=1] ${c.x.toFixed(3)} ${c.y.toFixed(3)} ${c.z.toFixed(3)} ${c.yaw.toFixed(1)} 0`)
    }
    // the hiss is the creeper's own, but from behind a wall it is faint: the same sound is also played at the lens
    if (t === PLAN.ignite - lead) { director.cmd('/data merge entity @e[tag=ocreep,limit=1] {ignited:1b}'); director.cmd(`/playsound minecraft:entity.creeper.primed hostile ${film.lens} ${xyz(pos)} 1 0.5`) }
    // He lives through the creeper (the game still shows him take it), so the second bolt can have him.
    if (t === blastTick - lead - 10) director.cmd(`/effect give ${name} minecraft:resistance 2 255 true`)
    // With block damage off the game draws a creeper's blast as one puff. It gets the cloud of a
    // blast that breaks things, and its bang is also played at the lens (the creeper is nine blocks off).
    if (since === 0) {
      const c = creeperAt(blastTick)
      director.cmd(`/particle minecraft:explosion_emitter ${c.x.toFixed(2)} ${(c.y + 1).toFixed(2)} ${c.z.toFixed(2)} 0 0 0 0 1 force`)
      director.cmd(`/playsound minecraft:entity.generic.explode master ${film.lens} ${xyz(pos)} 1 0.8`)
    }
    // The blast is the creeper's own, but a creeper cannot open a mass of stone, and he needs
    // the same crater every take. So on the tick after it, behind the flash and the cloud, the
    // stone is taken away (its floor goes back to grass) and the crater is cut under him.
    if (since === 1) {
      const [lo, hi] = box(L, [-PLAN.pocket - 2, -3, 0], [0, 3, 5]); director.cmd(`/fill ${xyz(lo)} ${xyz(hi)} minecraft:air replace ${PLAN.mass}`)
      const [flo, fhi] = box(L, [-PLAN.pocket - 2, -3, -1], [0, 3, -1]); director.cmd(`/fill ${xyz(flo)} ${xyz(fhi)} minecraft:grass_block replace ${PLAN.mass}`)
      for (const [from, to] of PLAN.pit) { const [plo, phi] = box(L, from, to); director.cmd(`/fill ${xyz(plo)} ${xyz(phi)} minecraft:air`) }
    }
    if (t === PLAN.bolt1 - lead && !sealed) {
      sealed = true
      // the bolt is the game's own, so its thunder is in the take. It lands on the cow, wherever
      // the cow has wandered to; a real strike lights it, and the fire is lit as well so it never fails.
      director.cmd('/execute at @e[tag=ocow,limit=1] run summon minecraft:lightning_bolt ~ ~ ~')
      director.cmd('/data merge entity @e[tag=ocow,limit=1] {Fire:200s}')
    }
    // the second bolt: on him, where he really is, and this one is the end of him
    if (t === PLAN.bolt2 - lead && !struck) {
      struck = true // (he does not move again)
      director.cmd(`/effect clear ${name} minecraft:resistance`)
      for (let i = 0; i < PLAN.bolt2_count; i++) director.cmd(`/summon minecraft:lightning_bolt ${cur.x.toFixed(2)} ${cur.y.toFixed(2)} ${cur.z.toFixed(2)}`)
    }
    if (t === PLAN.bolt2 - lead + PLAN.bolt2_kills) director.cmd(`/damage ${name} 1000 minecraft:lightning_bolt`)
    // the stamp's sounds, a beat after the crack (the low thump is added under them in the finished clip)
    if (t === PLAN.bolt2 - lead + PLAN.stamp_after) for (const [sound, vol, pitch] of PLAN.stamp_sounds) director.cmd(`/playsound ${sound} master ${film.lens} ${xyz(pos)} ${vol} ${pitch}`)
    film.tick(t, camCtx)
    if (!(await clock.wait(t + PRE + 1))) late++
  }
  bot.removeListener('blockUpdate', onBlock)
  miner.bot._client.removeListener('explosion', onBlast)
  await film.end()
  const clapWall = film.clapWall
  const clips = await film.finish()
  // put the ground back
  director.cmd('/kill @e[tag=ocreep]'); director.cmd('/kill @e[tag=ocow]')
  backup(director, L, true)
  await U.sleep(500)
  director.cmd('/kill @e[type=minecraft:item]'); director.cmd('/kill @e[type=minecraft:experience_orb]')
  await director.settle(400, 5000)
  // the clock's guess at where each thing is in the clip (the clap is at tick -6, the clip starts 2 frames after tick 0)
  const { CLAP_TICK } = require('../capture/film')
  const clipTime = wall => wall === null || wall === undefined ? null : +((wall - clapWall) / 1000 + CLAP_TICK / 20 - 2 / FPS - 0.07).toFixed(3)
  const guess = { breaks: seen.breaks.map(clipTime), blast: clipTime(seen.blasts[0]), blasts: seen.blasts.length }
  U.log('outro', `${shape}: filmed (${late} late ticks); by the clock: breaks ${guess.breaks.join(', ')} s, blast ${guess.blast} s (${guess.blasts} explosions)`)
  return { clip: path.join(film.dir, clips[0].clip), frames: clips[0].frames, late_ticks: late, guess, camera: { pos, look: aim } }
}

// Film the outro. opts.shapes: ['short', 'long']; opts.cams: { short: [cam, ...] } films extra
// trial takes (kept in assets/outro/work/) instead of replacing the raw clips.
async function film (opts = {}) {
  const why = busy()
  if (why) throw new Error(`cannot film the outro now: ${why}`)
  const server = require('../mc/server')
  const terrainLib = require('../mc/terrain')
  const client = require('../capture/client')
  const { Film } = require('../capture/film')
  const { Director } = require('../mc/director')
  const { ActorBot } = require('../mc/actor')
  if (!client.available()) throw new Error('real-client capture is not set up (capture/); the outro is filmed with it')
  const shapes = opts.shapes || ['short', 'long']
  const cfg = { ...server.config(), version: server.MC_VERSION }
  let started = null
  const up = await server.isUp(cfg.host, cfg.port)
  // a set server made before the outro existed refuses every summoned monster; that is read at start-up
  const props = path.join(server.SERVER_DIR, 'server.properties')
  if (U.exists(props) && /^spawn-monsters=false$/m.test(fs.readFileSync(props, 'utf8'))) {
    if (up) throw new Error('the set server is running with spawn-monsters=false (no creeper can be summoned); stop it (mcmovie server:stop) and run outro:make again')
    fs.writeFileSync(props, fs.readFileSync(props, 'utf8').replace(/^spawn-monsters=false$/m, 'spawn-monsters=true'))
  }
  if (!up) { U.log('outro', 'starting the set server'); started = await server.start() }
  let director = null; let miner = null
  const results = {}
  try {
    // (now and then the first login after the server starts hangs; a second try gets in)
    for (let i = 0; ; i++) {
      director = new Director(cfg, { verbose: opts.verbose })
      try { await director.connect(); break } catch (e) { if (i >= 2) throw e; U.log('outro', 'the director could not join; trying again'); await U.sleep(3000) }
    }
    await director.baseline({ natural: true, time_of_day: 6000, weather: 'clear' })
    // a creeper cannot exist on peaceful. Its blast breaks nothing and the bolts light nothing:
    // what goes is taken away on the blast tick, the same every take.
    await director.run(['/difficulty easy', '/gamerule mobGriefing false', '/gamerule doFireTick false', '/gamerule doMobSpawning false', '/gamerule doTileDrops false', '/gamerule showDeathMessages false'], 30)
    // the usual place, if the ground there is what it was; otherwise a scouted one
    let L = null
    const forced = opts.near || opts.facing !== undefined
    if (PLAN.spot && !forced) {
      const [x, y, z] = PLAN.spot.wall
      await director.hover([x, y, z], -60)
      await director.waitForChunks([x, y, z], 5)
      await U.sleep(1500)
      if (groundTop(director.bot, x, z, y + 12) === y - 1) L = layout(x, y, z, PLAN.spot.facing)
      else U.log('outro', 'the usual place is not as it was; scouting another')
    }
    if (!L) {
      await director.disconnect()
      const terrain = await terrainLib.pick(opts.near ? { near: opts.near } : { seed: PLAN.scout_seed })
      U.log('outro', `stage: ${terrain.biome}, ground y=${terrain.ground_y}, origin ${terrain.origin.join(',')}`)
      await director.connect()
      await director.hover(terrain.origin, -60)
      await director.waitForChunks(terrain.origin, 5)
      await U.sleep(1500)
      L = findSpot(director.bot, terrain, opts.facing)
    }
    const [wx, wy, wz] = L.blk(0, 0, 0)
    await director.clearStage({ from: [wx - 14, wy - 1, wz - 14], to: [wx + 14, wy - 1, wz + 14] })
    // no animals wandering into the back of the shot: the only cow is the one put there
    director.cmd(`/execute positioned ${wx} ${wy} ${wz} run tp @e[type=!minecraft:player,type=!minecraft:item_display,distance=..120] ~ -300 ~`)
    await U.sleep(600)
    U.log('outro', `wall at ${L.blk(0, 0, 0).join(',')}, facing ${['south', 'west', 'north', 'east'][L.facing]}`)
    const left = strays(director.bot, L)
    if (left.length) throw new Error(`the field behind the stage is not clean (${left.join(', ')}): something was left there. Wipe the set world (delete server/set_terrain; it regrows from its seed) and run outro:make again`)
    fs.mkdirSync(WORK, { recursive: true })
    for (const shape of shapes) {
      const S = SHAPES[shape]
      const trials = opts.cams && opts.cams[shape]
      await client.start({ width: S.width, height: S.height, host: cfg.host, port: cfg.port, gamma: PLAN.gamma, fov: PLAN.fov })
      try {
        await client.waitJoined(director)
        if (!miner) {
          miner = new ActorBot(cfg, { id: PLAN.miner })
          await miner.connect()
          await U.sleep(300)
          // plain Steve, set outright: left alone, the skin plugin would look the name up
          director.cmd(`/skin set ${PLAN.skin} ${PLAN.miner}`)
          // no name over his head: the words are the thing to read. (A team of its own, removed
          // after the take, so name tags in ordinary films are untouched.)
          await director.run(['/team add outro', '/team modify outro nametagVisibility never', `/team join outro ${PLAN.miner}`], 30)
          await U.sleep(4000)
        }
        const f = new Film({ director, dir: path.join(WORK, shape), fps: FPS, width: S.width, height: S.height, lift: false })
        const cams = trials || [S.cam]
        for (let i = 0; i < cams.length; i++) {
          const r = await take({ director, film: f, miner, L }, shape, { ...S.cam, ...cams[i] })
          const meta = { shape, late_ticks: r.late_ticks, guess: r.guess, camera: r.camera, cam: { ...S.cam, ...cams[i] }, wall: L.blk(0, 0, 0), facing: L.facing, g: L.g, filmed: new Date().toISOString() }
          const out = trials ? path.join(WORK, `raw_${shape}_${i}.mp4`) : asset.rawFile(shape)
          fs.copyFileSync(r.clip, out)
          U.writeJson(out.replace(/\.mp4$/, '.json'), meta)
          results[trials ? `${shape}_${i}` : shape] = { file: out, ...meta }
        }
      } finally { await client.stop() }
    }
  } finally {
    if (director) {
      try { await director.run(['/kill @e[tag=ocreep]', '/team remove outro', '/gamerule showDeathMessages true', '/difficulty peaceful'], 30) } catch {}
    }
    if (miner) await miner.disconnect()
    if (director) await director.disconnect()
    await U.sleep(300)
    if (started) { U.log('outro', 'stopping the set server'); await started.stop() }
  }
  return results
}

// ---- the words -------------------------------------------------------------

// Where a point of the world is on the frame, for the camera the take used.
function projector (camera, width, height) {
  const fov = U.deg2rad(PLAN.fov)
  const F = (height / 2) / Math.tan(fov / 2)
  const [px, py, pz] = camera.pos; const [lx, ly, lz] = camera.look
  let f = [lx - px, ly - py, lz - pz]; const fl = Math.hypot(...f); f = f.map(v => v / fl)
  let r = [-f[2], 0, f[0]]; const rl = Math.hypot(...r); r = r.map(v => v / rl) // right of the view (y up)
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  return (p) => {
    const d = [p[0] - px, p[1] - py, p[2] - pz]
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]
    const x = d[0] * r[0] + d[1] * r[1] + d[2] * r[2]
    const y = d[0] * u[0] + d[1] * u[1] + d[2] * u[2]
    return { x: width / 2 + x / z * F, y: height / 2 - y / z * F, scale: F / z }
  }
}

// mean brightness (0-255) of a part of the picture, frame by frame
function luma (file, crop) {
  const vf = (crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '') + 'scale=16:16,format=gray'
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
  const out = []
  for (let i = 0; i + 256 <= buf.length; i += 256) { let s = 0; for (let k = 0; k < 256; k++) s += buf[i + k]; out.push(s / 256) }
  return out
}

// the sound, as loudness every 10 ms (whole, and only its bright top end: the stamp is all
// top end, the blast is not)
function loudness (file, filter) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-af', (filter ? filter + ',' : '') + 'aresample=48000', '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 26 })
  const n = Math.floor(buf.length / 2); const win = 480; const out = []
  for (let i = 0; i + win <= n; i += win) {
    let s = 0; let peak = 0
    for (let k = 0; k < win; k++) { const v = buf.readInt16LE((i + k) * 2) / 32768; s += v * v; if (Math.abs(v) > peak) peak = Math.abs(v) }
    out.push({ rms: Math.sqrt(s / win), peak })
  }
  return out
}
const db = v => v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -120

// Find the beats in a filmed take: the frame each hole opens (its patch of the frame goes
// from cave dark to daylight), the frame the blast lands (the whole frame changes), and where
// the sounds are.
function measure (raw, meta) {
  const S = SHAPES[meta.shape]
  const proj = projector(meta.camera, S.width, S.height)
  const L = layout(meta.wall[0], meta.g, meta.wall[2], meta.facing)
  const holes = [2, 1, 0].map((i, n) => {
    const c = proj(L.at(0, 0, i + 0.5)); const near = proj(L.at(-0.5, 0, i + 0.5)); const far = proj(L.at(0.5, 0, i + 0.5))
    // y and opening: the daylight end of the hole, which is what shows; size: the block's near face
    return { x: Math.round(c.x), y: Math.round(far.y), size: Math.round(near.scale), opening: Math.round(far.scale), word_y: Math.round(far.y - WORDS[n].dy * far.scale) }
  })
  // the blast: the first frame of the biggest change of the whole frame
  const whole = luma(raw)
  const rise = (ys, k) => k > 0 ? ys[k] - ys[k - 1] : 0
  let jump = 0
  for (let k = Math.round(FPS * 0.8); k < whole.length; k++) jump = Math.max(jump, rise(whole, k))
  let blast = whole.findIndex((v, k) => k >= Math.round(FPS * 0.8) && rise(whole, k) > jump * 0.4)
  if (blast < 0 || jump < 20) blast = null
  // a hole: the frame the middle of its block stops being cave and is outdoors. (The block below
  // gets lighter too when a hole opens above it, so each is looked for after the one before.)
  const breaks = []
  holes.forEach((h, i) => {
    const s = Math.max(16, Math.round(h.opening * 0.5) & ~1)
    const ys = luma(raw, { w: s, h: s, x: Math.max(0, Math.round(h.x - s / 2)), y: Math.max(0, Math.round(h.y - s / 2)) }).slice(0, blast || undefined)
    const from = i && breaks[i - 1] !== null ? breaks[i - 1] + 5 : 1
    const k = ys.findIndex((v, n) => n >= from && rise(ys, n) >= 12)
    breaks.push(k < 0 ? null : k)
  })
  // sound
  const env = loudness(raw); const top = loudness(raw, 'highpass=f=4000')
  const onset = (e, from, to) => { let best = -1; let bi = null; for (let i = Math.max(1, Math.round(from * 100)); i < Math.min(e.length, Math.round(to * 100)); i++) { const rise = e[i].rms - e[i - 1].rms; if (rise > best) { best = rise; bi = i } } return bi === null ? null : +(bi / 100).toFixed(2) }
  const level = (t, len = 0.2) => { const w = env.slice(Math.max(0, Math.round(t * 100)), Math.round((t + len) * 100)); if (!w.length) return null; return { rms_db: db(Math.sqrt(w.reduce((n, v) => n + v.rms * v.rms, 0) / w.length)), peak_db: db(Math.max(...w.map(v => v.peak))) } }
  const sec = k => k === null ? null : +(k / FPS).toFixed(3)
  const bt = breaks.map(sec); const blastT = sec(blast)
  // The take's sound can sit a few frames off its picture. The breaks say by how much (each is
  // one sharp crack and one frame), and the finished clip is put right by that.
  const heard = bt.map(t => t === null ? null : onset(env, t - 0.25, t + 0.15))
  const offs = bt.map((t, i) => t === null || heard[i] === null ? null : t - heard[i]).filter(v => v !== null).sort((x, y) => x - y)
  const early = offs.length ? +offs[Math.floor(offs.length / 2)].toFixed(3) : 0 // seconds the sound runs ahead of the picture
  const blastHeard = blastT === null ? null : onset(env, blastT - early - 0.15, blastT - early + 0.2)
  const fix = t => t === null ? null : +(t + early).toFixed(3)
  // later things, by the tick clock from the blast
  const after = dt => +((blastT !== null ? blastT : PLAN.blast / 20) + dt / 20).toFixed(3)
  // the second bolt: the first frame the picture jumps (it lands on him, close), and its crack
  const b2 = Math.round(after(PLAN.bolt2 - PLAN.blast) * FPS)
  let flash = 0
  for (let k = Math.max(1, b2 - 5); k <= Math.min(whole.length - 1, b2 + 5); k++) flash = Math.max(flash, Math.abs(rise(whole, k)))
  let bolt2 = null
  for (let k = Math.max(1, b2 - 5); k <= Math.min(whole.length - 1, b2 + 5) && bolt2 === null; k++) if (flash > 6 && Math.abs(rise(whole, k)) > flash * 0.3) bolt2 = k
  const bolt2T = bolt2 !== null ? sec(bolt2) : after(PLAN.bolt2 - PLAN.blast)
  const crack = (t) => { // the 10 ms where the sound first reaches half of its loudest near t (sound's own clock)
    const w = env.slice(Math.max(0, Math.round((t - 0.15) * 100)), Math.round((t + 0.3) * 100)); const top = Math.max(...w.map(v => v.rms))
    const i = w.findIndex(v => v.rms >= top * 0.5); return i < 0 ? null : +(Math.max(0, t - 0.15) + i / 100).toFixed(2)
  }
  const bolt1T = after(PLAN.bolt1 - PLAN.blast)
  const bolt1Heard = onset(env, bolt1T - early - 0.15, bolt1T - early + 0.2)
  const bolt2Heard = crack(bolt2T - early)
  const sound = {
    early_by: early,
    breaks: bt.map((t, i) => t === null ? null : { heard_at: fix(heard[i]), ...level((heard[i] !== null ? heard[i] : t) - 0.02) }),
    hiss: level(PLAN.ignite / 20 + 0.1 - early, 0.5),
    blast: blastT === null ? null : { heard_at: fix(blastHeard), ...level((blastHeard || blastT) - 0.02, 0.3) },
    bolt1: { heard_at: fix(bolt1Heard), ...level((bolt1Heard || bolt1T - early) - 0.02, 0.3) },
    before_bolt2: level(bolt2T - early - 0.3, 0.25),
    bolt2: { heard_at: fix(bolt2Heard), ...level((bolt2Heard || bolt2T - early) - 0.02, 0.3) },
    dark_start_luma: +(whole.slice(0, 6).reduce((a, b) => a + b, 0) / 6).toFixed(1)
  }
  // the second bolt at its brightest (where the picture is stopped), and how loud each part of the take gets
  let bright = bolt2 !== null ? bolt2 : b2
  for (let k = bright; k <= Math.min(whole.length - 1, bright + 3); k++) if (whole[k] > whole[bright]) bright = k
  const peak = (from, to) => Math.max(1e-4, ...env.slice(Math.max(0, Math.round((from - early) * 100)), Math.max(1, Math.round((to - early) * 100))).map(v => v.peak))
  const crackT = fix(bolt2Heard !== null ? bolt2Heard : bolt2T - early)
  const tx = blastT !== null ? blastT : PLAN.blast / 20
  const beat = PLAN.stamp_after / 20
  const peaks = { before_blast: peak(0, tx - 0.1), blast_to_bolt2: peak(tx - 0.1, crackT - 0.03), crack: peak(crackT - 0.02, crackT + beat - 0.04), hit: peak(crackT + beat - 0.04, crackT + beat + 0.5) }
  // the stamp's own sounds in the take: all top end, a beat after the crack
  const stampHeard = fix(onset(top, crackT - early + beat - 0.1, crackT - early + beat + 0.12))
  return { holes, frames: whole.length, breaks: bt, blast: blastT, bolt1: bolt1T, lookup: after(PLAN.lookup - PLAN.blast), bolt2: bolt2T, bolt2_brightest: sec(bright), crack: crackT, stamp_heard: stampHeard, peaks, early, sound, whole, env }
}

// The words over the take. Each pops on its hole the frame the hole opens (big, settling in a
// tenth of a second) and then stays exactly there: through the blast, which only jolts it,
// and through what follows, trembling a little in place, tighter and harder as the second
// bolt comes, like something charging. On the bolt all three go straight to the line in one
// move and are stamped (below).
const CHARGE = {
  jolt_px: 12, // the creeper's blast shakes each word in place by this much (of a 1080-wide frame), dying in a fifth of a second
  tremble_px: [0.8, 4], // the tremble, from just after the blast to just before the bolt
  pulse: 0.035 // and the swell in size that goes with it, at its most
}

// The stamp: the second bolt brands the address onto the screen like a hot iron. What it does
// to the picture, the words and the sound; each piece is a setting, and 0 switches it off.
const STAMP = {
  // The bolt is its own moment and has to be seen on him: the crack, him lit and flinching, the
  // words still apart on their blocks. freeze_at: this many frames after the bolt first shows
  // (it is fully drawn and he is lit by it) the picture stops (the hit-stop), and that frame is
  // held freeze_frames more while the words drive together. Then, on one frame: black, the
  // words locked, the stamp. So the bolt is on screen for freeze_at + 1 + freeze_frames frames.
  freeze_at: 2,
  freeze_frames: 3,
  flash: 0.1, // how much the picture is brightened while the bolt is on it (the game's own flash does most of it; more hides the bolt)
  slam_frames: 3, // over the last frames before the lock the words come together oversized ...
  slam_from: 1.55, // ... this many times their final size, and drop to size on the lock frame
  shake_frames: 4, // then the address alone shakes, sharp and dying away,
  shake_px: 9, // by this much (of a 1080-wide frame), and after that it does not move again
  // the heat: on the lock the address is white-hot, and cools through these colours to its own
  // (white, PVP yellow). [colour, seconds after the lock it starts to go, seconds it takes to go]
  heat: [['0xFFFBE6', 0.03, 0.08], ['0xFFE14F', 0.08, 0.1], ['0xFF8A1E', 0.15, 0.22], ['0xD63C14', 0.3, 0.38]],
  hot_edge: '0x8A2E06', // while it is hot its outline is not black but burnt
  glow: '0xFF7A14', // the glow bleeding into the black round the hot letters,
  glow_sigma: 28, // this soft (pixels of a 1080-wide frame),
  glow_gain: 4, // this strong,
  glow_sec: 0.7, // and gone in this time
  sparks: 10, // square embers thrown off the mark on the lock,
  spark_sec: 0.4, // falling and dead in this time
  red: '0x6E0C0C', red_sec: 0, // (off) the game's death-screen red under the address on the lock, falling to black
  silence_sec: 0.08, // nothing is heard for at least this long before the hit, so it lands out of nothing
  thump_hz: 55, thump_sec: 0.25, thump_gain: 0.36, // a low thump under the crack, for weight
  blast_peak: 0.45, // the creeper's blast is held to this level (1 = full scale),
  crack_peak: 0.5, // the bolt's crack to this,
  hit_peak: 0.62 // and the stamp's own sounds to this, so with the thump under them the stamp is the loudest instant of the clip
}

// When everything in the ending happens, from where the second bolt is in this take.
function ending (m) {
  const bolt = Math.round(m.bolt2 * FPS) // the first frame the bolt shows: the crack
  const held = bolt + STAMP.freeze_at // the frame the picture stops on
  const black = +((held + 1 + STAMP.freeze_frames) / FPS).toFixed(4) // the first black frame,
  const lock = black // which is the stamp: the words locked, its sounds
  const fadeFrom = +(lock + PLAN.title_hold).toFixed(4); const fadeTo = +(fadeFrom + PLAN.title_fade).toFixed(4)
  // how lit the address is on each frame of the fade: how loud the fading thunder still is,
  // smoothed, and only ever less. (The clip's sound from the crack on is the take's, unmoved.)
  const rawAt = t => m.crack - m.early + (t - bolt / FPS)
  const smooth = t => { const i = Math.round(rawAt(t) * 100); const w = m.env.slice(Math.max(0, i - 10), i + 10); return w.length ? Math.sqrt(w.reduce((n, v) => n + v.rms * v.rms, 0) / w.length) : 0 }
  const window = t => t <= fadeFrom ? 1 : (t >= fadeTo ? 0 : Math.pow(1 - (t - fadeFrom) / (fadeTo - fadeFrom), 1.5))
  const ref = smooth(fadeFrom) || 1e-6
  const title = []; let last = 1
  for (let k = Math.round(fadeFrom * FPS); k / FPS < fadeTo - 1e-6; k++) { last = Math.min(last, U.clamp(smooth(k / FPS) / ref, 0, 1) * window(k / FPS)); title.push({ t: +(k / FPS).toFixed(4), a: +last.toFixed(3) }) }
  const rings = smooth(fadeFrom + PLAN.title_fade * 0.8) > ref * 0.12 // is the game's own tail long enough to fade over?
  return { bolt: +(bolt / FPS).toFixed(4), held, lock, black, slam: +(lock - STAMP.slam_frames / FPS).toFixed(4), silence_from: +(bolt / FPS - STAMP.silence_sec).toFixed(4), fadeFrom, fadeTo, title, rings, frames: Math.round(fadeTo * FPS) + 3 }
}

function overlay (S, m, E) {
  const cx = S.width / 2; const fy = Math.round(S.height * S.line_y)
  const chars = WORDS.reduce((n, w) => n + w.text.length, 0)
  const x0 = cx - chars * S.line / 2
  const tx = m.blast !== null ? m.blast : PLAN.blast / 20
  const tl = E.lock; const eps = 0.004
  const c = `clip((t-${tx})/${(E.slam - tx).toFixed(3)},0,1)` // the charge: 0 at the blast, 1 as the bolt lands
  // the slam: straight to the line, in line (and oversized) on the frame before the lock, to size on the lock
  const closing = Math.max(1, STAMP.slam_frames - 1) / FPS
  const e2 = STAMP.slam_frames ? `pow(clip((t-${E.slam})/${closing.toFixed(4)},0,1),2)` : `gte(t,${tl - eps})`
  const locked = `gte(t,${(tl - eps).toFixed(4)})`
  // the shake: the address only, a few frames, dying away; then nothing moves
  const sh = STAMP.shake_frames ? `clip(1-(t-${tl})/${(STAMP.shake_frames / FPS).toFixed(4)},0,1)*${locked}` : '0'
  const unit = Math.min(S.width, S.height) / 1080
  const amt = (STAMP.shake_px * unit).toFixed(1)
  const filters = []
  // the hit-stop: the picture stops on the bolt, fully drawn, him lit by it
  if (STAMP.freeze_frames > 0) filters.push(`loop=loop=${STAMP.freeze_frames}:size=1:start=${E.held}`)
  // a flash on the blast (the wall is gone in one frame; the flash is what carries it), and a
  // touch more light while the second bolt is on the picture
  filters.push(`eq=brightness='min(1,0.55*gte(t,${tx})*clip(1-(t-${tx})/0.16,0,1)+${STAMP.flash}*gte(t,${(E.bolt - eps).toFixed(4)})*lt(t,${(E.black - eps).toFixed(4)}))':eval=frame`)
  // a hard cut: the picture goes in one frame. The words (drawn after this) do not.
  filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,${(E.black - eps).toFixed(4)})'`)
  const words = []; const hot = []; const glow = []
  const over = STAMP.slam_frames ? (S.slam_from || STAMP.slam_from) : 1
  // how lit the address is over the black, frame by frame (from the thunder's own decay)
  const alpha = E.title.reduceRight((rest, f) => `if(lt(t,${(f.t + 1 / FPS - eps).toFixed(4)}),${f.a},${rest})`, '0')
  const lit = `if(lt(t,${(E.fadeFrom - eps).toFixed(4)}),1,${alpha})`
  // how far a word can swell as it pops without leaving the frame
  const amp = Math.min(0.5, 0.96 * S.width / (Math.max(...WORDS.map(w => w.text.length)) * S.pop) - 1).toFixed(2)
  const px = Math.max(4, Math.round(S.line / 8)) // one pixel of the font: the outline and the drop of the shadow
  let off = 0
  WORDS.forEach((w, i) => {
    const tb = m.breaks[i] !== null ? m.breaks[i] : PLAN.breaks[i] / 20
    const h = m.holes[i]
    const fx = +(x0 + (off + w.text.length / 2) * S.line).toFixed(1); off += w.text.length
    // where it is until the bolt: its hole, jolted by the blast and trembling as the charge builds
    const ph = (i * 2.1).toFixed(1)
    const jolt = `(${(CHARGE.jolt_px * unit).toFixed(1)}*exp(-(t-${tx})/0.07)*gte(t,${tx}))`
    const trem = `((${(CHARGE.tremble_px[0] * unit).toFixed(2)}+${((CHARGE.tremble_px[1] - CHARGE.tremble_px[0]) * unit).toFixed(2)}*${c}*${c})*gte(t,${tx}))`
    const lx = `(${h.x}+${jolt}*sin(95*(t-${tx})+${ph})+${trem}*sin(71*t+${ph}))`
    const ly = `(${h.word_y}+${jolt}*cos(83*(t-${tx})+${ph})+${trem}*cos(59*t+${ph}))`
    const ls = `(${S.pop}*(1+0.1*exp(-(t-${tx})/0.08)*gte(t,${tx})+${CHARGE.pulse}*${c}*sin(38*t+${ph})))`
    // coming together it grows to slam_from times its final size; on the lock frame it is its final size, for good
    const big = `(${S.line}*${over})`
    const size = `if(lt(t,${tx}),${S.pop}*(1+${amp}*clip(1-(t-${tb})/0.1,0,1)),if(${locked},${S.line},${ls}+(${big}-${ls})*${e2}))`
    const scale = `if(${locked},1,1+(${over}-1)*${e2})` // the line is oversized about the middle of the frame
    const x = `${lx}+((${cx}+(${fx}-${cx})*${scale})-${lx})*${e2}+${amt}*sin(47*(t-${tl}))*${sh}-text_w/2`
    const y = `${ly}+(${fy}-${ly})*${e2}+${amt}*0.8*cos(61*(t-${tl}))*${sh}-text_h/2`
    const font = `drawtext=fontfile=${asset.FONT.replace(/:/g, '\\:')}:text='${w.text}'`
    const outline = `borderw=${px}:bordercolor=black:shadowx=${px}:shadowy=${px}:shadowcolor=black`
    words.push(`${font}:fontcolor=${w.color}:fontsize='${size}':x='${x}':y='${y}':alpha='${lit}':${outline}:enable='gte(t,${tb})'`)
    // the heat, over the same letters: each colour lies on the one it cools to and goes in its turn
    for (const [colour, from, len] of STAMP.heat.slice().reverse()) {
      hot.push(`${font}:fontcolor=${colour}:fontsize=${S.line}:x='${x}':y='${y}':alpha='clip(1-(t-${(tl + from).toFixed(4)})/${len},0,1)':borderw=${px}:bordercolor=${STAMP.hot_edge}:enable='between(t,${(tl - eps).toFixed(4)},${(tl + from + len).toFixed(4)})'`)
    }
    // the same letters once more, fat and orange on nothing: blurred, that is the glow
    glow.push(`${font}:fontcolor=${STAMP.glow}:fontsize=${S.line}:x=${fx}-text_w/2:y=${fy}-text_h/2:borderw=${px * 3}:bordercolor=${STAMP.glow}`)
  })
  // embers: square pixels (the font's full stop is one) thrown off the mark, falling, dying
  const sparks = []
  for (let n = 0; n < STAMP.sparks; n++) {
    const a = n * 2.399 + 0.5; const sx = Math.round(cx + Math.cos(a * 1.7) * chars * S.line * 0.42)
    const vx = Math.round(Math.cos(a) * (260 + (n % 4) * 90) * unit); const vy = Math.round((-380 - (n % 3) * 160) * unit)
    const dt = `(t-${tl})`
    sparks.push(`drawtext=fontfile=${asset.FONT.replace(/:/g, '\\:')}:text='.':fontcolor=${n % 3 ? '0xFF8A1E' : '0xFFE14F'}:fontsize=${Math.round(S.line * (0.6 + (n % 3) * 0.2))}:x='${sx}+(${vx})*${dt}':y='${fy}-${Math.round(S.line * 0.6)}+(${vy})*${dt}+${Math.round(1900 * unit)}*${dt}*${dt}':alpha='clip(1-${dt}/${STAMP.spark_sec},0,1)':enable='between(t,${(tl - eps).toFixed(4)},${(tl + STAMP.spark_sec).toFixed(4)})'`)
  }
  const chain = [`[0:v]fps=${FPS},${filters.join(',')}[pic]`]
  let bg = '[pic]'
  // (off by default) under the words on the lock frame: the red of the death screen, falling to black
  if (STAMP.red_sec > 0) {
    chain.push(`color=c=${STAMP.red}:s=${S.width}x${S.height}:r=${FPS}:d=${(E.frames / FPS).toFixed(3)},format=yuva420p,fade=t=out:st=${E.black}:d=${STAMP.red_sec}:alpha=1[red]`, `${bg}[red]overlay=enable='between(t,${(E.black - eps).toFixed(4)},${(E.black + STAMP.red_sec).toFixed(4)})'[red1]`)
    bg = '[red1]'
  }
  if (STAMP.glow_sec > 0) {
    chain.push(`color=c=black@0.0:s=${S.width}x${S.height}:r=${FPS}:d=${(STAMP.glow_sec + 0.1).toFixed(3)},format=rgba,${glow.join(',')},gblur=sigma=${(STAMP.glow_sigma * unit).toFixed(1)}:steps=2,colorchannelmixer=aa=${Math.min(2, Math.sqrt(STAMP.glow_gain)).toFixed(2)},colorchannelmixer=aa=${Math.min(2, Math.sqrt(STAMP.glow_gain)).toFixed(2)},fade=t=out:st=0.06:d=${STAMP.glow_sec}:alpha=1,setpts=PTS+${tl}/TB[glow]`,
      `${bg}[glow]overlay=eof_action=pass:enable='between(t,${(tl - eps).toFixed(4)},${(tl + STAMP.glow_sec + 0.06).toFixed(4)})'[lit]`)
    bg = '[lit]'
  }
  chain.push(`${bg}${[...words, ...hot, ...sparks].join(',')},format=yuv420p[v]`)
  return chain.join(';\n')
}

// The sound of the finished clip. Slid onto the picture; the strikes and breaks before the
// blast lifted a little, the blast held to its level; nothing squeezed. Before the bolt,
// silence. Then two beats a fifth of a second apart: the bolt's crack on the frame it shows,
// and the stamp (iron, the sizzle, and a low thump put under them here) on the frame the
// picture goes. Over the black the thunder rings on and fades on the same curve as the
// address; if the game's own tail is too short to last that second it is given an echo, on
// the tail only, so the hits stay dry and hard.
function soundtrack (m, E) {
  const ms = v => Math.round(v * 1000)
  const slide = m.early > 0.004 ? `adelay=${ms(m.early)}|${ms(m.early)},` : (m.early < -0.004 ? `atrim=start=${(-m.early).toFixed(3)},asetpts=PTS-STARTPTS,` : '')
  const tx = m.blast !== null ? m.blast : PLAN.blast / 20
  const cut = Math.min(E.silence_from, m.crack - 0.03)
  const gPre = Math.min(PRE_BLAST_GAIN, 0.3 / m.peaks.before_blast).toFixed(3)
  const gMid = Math.min(1, STAMP.blast_peak / m.peaks.blast_to_bolt2).toFixed(3)
  const gCrack = Math.min(3, STAMP.crack_peak / m.peaks.crack).toFixed(3)
  const gHit = Math.min(3, STAMP.hit_peak / m.peaks.hit).toFixed(3)
  const from = m.crack - 0.015 // where the take's sound is picked up again: just before the crack
  const stampAt = (E.lock - 0.02 - from).toFixed(3) // the stamp, on that piece's own clock
  const dur = (E.fadeTo - E.fadeFrom).toFixed(3)
  const parts = [
    `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${slide}asplit=2[a1][a2]`,
    `[a1]atrim=0:${cut.toFixed(3)},afade=t=in:st=0:d=0.02,afade=t=out:st=${(cut - 0.015).toFixed(3)}:d=0.015,volume='if(lt(t,${(tx - 0.08).toFixed(3)}),${gPre},${gMid})':eval=frame[pre]`,
    `[a2]atrim=start=${from.toFixed(3)},asetpts=PTS-STARTPTS,volume='if(lt(t,${stampAt}),${gCrack},${gHit})':eval=frame[crack]`
  ]
  if (E.rings) parts.push(`[crack]adelay=${ms(from)}|${ms(from)}[hit]`)
  else parts.push('[crack]asplit[dry][wet]', `[wet]aecho=0.8:0.75:110|230|370:0.5|0.38|0.26,volume='gte(t,${(+stampAt + 0.2).toFixed(3)})':eval=frame[more]`, `[dry][more]amix=inputs=2:duration=longest:normalize=0,adelay=${ms(from)}|${ms(from)}[hit]`)
  const mix = ['[pre]', '[hit]']
  if (STAMP.thump_gain > 0 && STAMP.thump_sec > 0) {
    parts.push(`sine=f=${STAMP.thump_hz}:r=48000:d=${STAMP.thump_sec},aformat=sample_fmts=fltp:channel_layouts=stereo,volume='${STAMP.thump_gain}*exp(-${(3 / STAMP.thump_sec).toFixed(1)}*t)':eval=frame,adelay=${ms(E.lock)}|${ms(E.lock)}[thump]`)
    mix.push('[thump]')
  }
  parts.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,alimiter=limit=0.97:attack=1:release=50:level=disabled,volume='if(lt(t,${E.fadeFrom}),1,pow(clip(1-(t-${E.fadeFrom})/${dur},0,1),1.5))':eval=frame,apad[a]`)
  return parts.join(';')
}

// raw take -> finished outro for one shape
function post (shape, opts = {}) {
  const raw = opts.raw || asset.rawFile(shape)
  if (!U.exists(raw)) throw new Error(`${path.relative(U.ROOT, raw)} is missing; film it first (mcmovie outro:make)`)
  if (!U.exists(asset.FONT)) throw new Error(`${path.relative(U.ROOT, asset.FONT)} is missing (Press Start 2P, from Google Fonts)`)
  const meta = U.readJson(raw.replace(/\.mp4$/, '.json'))
  const S = SHAPES[shape]
  const m = measure(raw, meta)
  const E = ending(m)
  const out = opts.out || asset.file(shape)
  const frames = E.frames // three black, silent frames after the address and the thunder are gone
  const graphFile = path.join(WORK, `post_${shape}.txt`)
  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(graphFile, overlay(S, m, E) + ';\n' + soundtrack(m, E))
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-filter_complex_script', graphFile, '-map', '[v]', '-map', '[a]', '-frames:v', String(frames), '-t', (frames / FPS).toFixed(4),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out])
  // The finished clip, checked: the stamp is red, then there is a stretch that is black but for
  // the address, and the last frames are black and silent.
  const done = luma(out); const heard = loudness(out)
  const at = t => done[Math.min(done.length - 1, Math.round(t * FPS))]
  const peakAt = (from, to) => db(Math.max(1e-6, ...heard.slice(Math.max(0, Math.round(from * 100)), Math.round(to * 100)).map(v => v.peak)))
  const rmsAt = t => { const w = heard.slice(Math.max(0, Math.round((t - 0.05) * 100)), Math.round((t + 0.05) * 100)); return w.length ? db(Math.sqrt(w.reduce((n, v) => n + v.rms * v.rms, 0) / w.length)) : -120 }
  const tx = m.blast !== null ? m.blast : PLAN.blast / 20
  const finished = {
    last_frame_luma: +done[done.length - 1].toFixed(2), title_on_black_luma: +at(E.black + 0.1).toFixed(2), bolt_on_him_luma: +at(E.bolt + 2 / FPS).toFixed(1), relief_luma: +at(m.lookup - 0.1).toFixed(1),
    peak_db: { breaks: peakAt(0, tx - 0.1), creeper_blast: peakAt(tx - 0.1, tx + 0.4), far_bolt: peakAt(m.bolt1 - 0.05, m.bolt1 + 0.4), silence_before_crack: peakAt(E.bolt - 0.06, E.bolt - 0.025), crack: peakAt(E.bolt - 0.02, E.lock - 0.03), stamp: peakAt(E.lock - 0.02, E.lock + 0.3) },
    rms_db: { title_fade_start: rmsAt(E.fadeFrom), halfway: rmsAt((E.fadeFrom + E.fadeTo) / 2), title_gone: rmsAt(E.fadeTo), last_100ms: rmsAt(frames / FPS - 0.05) }
  }
  const problems = []
  if (finished.last_frame_luma > 1) problems.push(`the last frame is not black (brightness ${finished.last_frame_luma})`)
  if (!(finished.title_on_black_luma > 0.5 && finished.title_on_black_luma < 40)) problems.push(`after the stamp the frame should be black but for the address (brightness ${finished.title_on_black_luma})`)
  if (!(finished.relief_luma > 60)) problems.push('the daylight after the blast is missing')
  if (m.breaks.some(b => b === null) || m.blast === null) problems.push('a break or the blast could not be found in the take')
  if (!(finished.peak_db.stamp > finished.peak_db.creeper_blast + 1.5 && finished.peak_db.stamp > finished.peak_db.crack)) problems.push(`the stamp (${finished.peak_db.stamp} dB) is not the loudest instant (crack ${finished.peak_db.crack} dB, creeper ${finished.peak_db.creeper_blast} dB)`)
  if (finished.rms_db.last_100ms > -55) problems.push('the clip does not end in silence')
  const report = {
    shape, file: path.relative(U.ROOT, out), seconds: +(frames / FPS).toFixed(3),
    planned: { breaks: PLAN.breaks.map(t => t / 20), ignite: PLAN.ignite / 20, blast: PLAN.blast / 20, bolt1: PLAN.bolt1 / 20, lookup: PLAN.lookup / 20, bolt2: PLAN.bolt2 / 20 },
    measured: { breaks: m.breaks, blast: m.blast, bolt1: m.bolt1, lookup: m.lookup, lookup_reached: +(m.lookup + PLAN.lookup_ticks / 20).toFixed(3), bolt2: E.bolt, stamp_sounds_in_take: m.stamp_heard, seal: E.lock, bolt2_frames_on_screen: STAMP.freeze_at + 1 + STAMP.freeze_frames, picture_stops: +(E.held / FPS).toFixed(3), first_black_frame: E.black, title_fade_start: E.fadeFrom, title_gone: E.fadeTo, end: +(frames / FPS).toFixed(3) },
    sound_in_take: m.sound, echo_added: !E.rings, finished, problems, words_at: m.holes, late_ticks: meta.late_ticks, filmed: meta.filmed
  }
  if (!opts.out) {
    const f = path.join(asset.DIR, 'outro.json')
    const all = U.exists(f) ? U.readJson(f) : {}
    all[shape] = report
    U.writeJson(f, all)
  }
  return report
}

async function make (opts = {}) {
  const shapes = opts.shapes || ['short', 'long']
  if (!opts.postOnly) await film({ ...opts, shapes })
  return shapes.map(s => post(s))
}

module.exports = { make, film, post, measure, busy, PLAN, SHAPES, WORDS, STAMP, WORK }
