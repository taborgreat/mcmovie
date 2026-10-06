'use strict'
// Live check of real kits in the studio (needs studio/ with the game plugin installed; not part
// of test/run.js). Starts the studio server, joins the director and two puppets, gives them kits
// with /studio kit, fires each kit with /studio fire, and reports what the server actually sent
// back for each one (bolts, explosions, particles, sounds, blocks, entities, potion effects).
//   node test/studio_kits.js [kit ...]
const fs = require('fs')
const net = require('net')
const path = require('path')
const { Vec3 } = require('vec3')
const U = require('../lib/util')
const studio = require('../lib/studio/server')
const { Director } = require('../lib/mc/director')
const { ActorBot } = require('../lib/mc/actor')

const only = process.argv.slice(2)
const A = 'KitA'; const B = 'KitB'

function portOpen (port) {
  return new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.setTimeout(600); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('timeout', () => { s.destroy(); resolve(false) }); s.once('error', () => resolve(false)) })
}

async function main () {
  if (!studio.available() || !studio.kits()) throw new Error('studio/ with plugins/HardcoreGames.jar is needed')
  const pidFile = path.join(studio.DIR, 'server.pid')
  for (let i = 0; U.exists(pidFile); i++) { if (i > 60) throw new Error('the studio is busy (studio/server.pid)'); console.log('studio busy, waiting...'); await U.sleep(30000) }
  const logFile = path.join(studio.DIR, 'logs', 'console.log')
  const logStart = U.exists(logFile) ? fs.statSync(logFile).size : 0
  const statusBefore = await portOpen(8085)

  const server = await studio.start()
  const cfg = { host: server.cfg.host, port: server.cfg.port, version: server.cfg.bot_version }
  const director = new Director(cfg)
  const a = new ActorBot(cfg, { id: A }); const b = new ActorBot(cfg, { id: B })
  const report = []
  let pump = null
  try {
    await director.connect()
    for (const c of ['gamerule fall_damage false', 'gamerule spawn_mobs false', 'gamerule fire_damage false', 'gamerule mob_griefing false', 'gamerule send_command_feedback false', 'weather clear', 'time set 6000']) director.cmd('/' + c)
    const spawn = director.bot.entity.position
    const cx = Math.floor(spawn.x); const cz = Math.floor(spawn.z)
    await director.hover([cx, 120, cz], 0)
    await director.waitForChunks([cx, 0, cz], 2)
    // a flat stone stage well above the terrain, so nothing natural is in the way
    const Y = 150
    director.cmd(`/fill ${cx - 10} ${Y} ${cz - 10} ${cx + 10} ${Y} ${cz + 10} minecraft:stone`)
    director.cmd(`/fill ${cx - 10} ${Y + 1} ${cz - 10} ${cx + 10} ${Y + 8} ${cz + 10} minecraft:air`)
    await director.hover([cx, Y + 6, cz - 6], 0)
    await a.connect(); await b.connect()
    for (const n of [A, B]) { director.cmd(`/effect give ${n} minecraft:resistance infinite 3 true`); director.cmd(`/effect give ${n} minecraft:saturation infinite 1 true`) }
    const pa = { x: cx - 1.5, y: Y + 1, z: cz + 0.5 }; const pb = { x: cx + 1.5, y: Y + 1, z: cz + 0.5 }
    const la = U.lookAt({ ...pa, y: pa.y + 1.62 }, { ...pb, y: pb.y + 1.62 }); const lb = U.lookAt({ ...pb, y: pb.y + 1.62 }, { ...pa, y: pa.y + 1.62 })
    await a.place(director, pa, la.yaw, la.pitch); await b.place(director, pb, lb.yaw, lb.pitch)
    // the puppets keep reporting their place 20 times a second, as in a film; B shuffles a little
    let tick = 0; let bAt = { ...pb }
    pump = setInterval(() => {
      tick++
      if (!a.dead) a.sendPose(pa, la.yaw, la.pitch, true)
      if (!b.dead) b.sendPose({ ...bAt, z: bAt.z + 0.25 * Math.sin(tick / 4) }, lb.yaw, lb.pitch, true)
    }, 50)

    // everything the server tells the watching director (and the two puppets) during one step
    let seen = null
    const note = (k, v) => { if (seen) (seen[k] = seen[k] || new Set()).add(String(v)) }
    director.bot.on('entitySpawn', e => note('spawned', e.name || e.displayName || e.type))
    director.bot._client.on('explosion', () => note('explosion', 'yes'))
    director.bot._client.on('world_particles', p => note('particles', (p.particle && (p.particle.type || p.particle.particleId)) ?? p.particleId))
    director.bot._client.on('set_passengers', p => note('riding', `${p.passengers.length} on ${p.entityId}`))
    for (const bot of [director.bot, a.bot, b.bot]) {
      bot.on('soundEffectHeard', name => note('sounds', String(name).replace('minecraft:', '')))
      bot.on('hardcodedSoundEffectHeard', (id) => { const s = bot.registry.sounds && bot.registry.sounds[id]; note('sounds', s ? s.name : 'sound#' + id) })
    }
    director.bot.on('blockUpdate', (o, n) => { if (n && (!o || o.type !== n.type)) note('blocks', n.name) })
    b.bot.on('entityEffect', (ent, eff) => { if (ent === b.bot.entity) { const e = b.bot.registry.effects[eff.id]; note('effects_on_B', e ? e.name : eff.id) } })
    let bHealth = 20
    b.bot.on('health', () => { if (b.bot.health < bHealth - 0.01) note('B_hurt', (bHealth - b.bot.health).toFixed(1)); bHealth = b.bot.health })
    const where = n => { const p = director.bot.players[n]; return p && p.entity ? p.entity.position.clone() : null }

    async function step (kit, opts = {}) {
      if (only.length && !only.includes(kit)) return
      director.cmd('/studio reset')
      director.cmd(`/effect give ${B} minecraft:instant_health 1 4 true`)
      director.cmd(`/effect clear ${B} minecraft:poison`); director.cmd(`/effect clear ${B} minecraft:wither`)
      for (const c of opts.before || []) director.cmd(c)
      director.cmd(`/studio kit ${A} ${kit}`)
      director.cmd(`/clear ${A}`)
      director.cmd(`/studio kit ${B} none`)
      for (const c of opts.afterKit || []) director.cmd(c)
      await U.sleep(500)
      const a0 = where(A); const b0 = where(B)
      seen = {}
      for (let i = 0; i < (opts.times || 1); i++) { director.cmd(`/studio fire ${A} ${kit}${opts.aim ? ' ' + opts.aim.join(' ') : ''}`); await U.sleep(opts.times ? 150 : 0) }
      if (opts.during) await opts.during()
      await U.sleep(opts.wait || 1800)
      const a1 = where(A); const b1 = where(B)
      const out = { kit }
      for (const [k, v] of Object.entries(seen)) out[k] = [...v].slice(0, 12).join(',')
      seen = null
      out.A_moved = a0 && a1 ? +a0.distanceTo(a1).toFixed(2) : '?'
      out.B_moved = b0 && b1 ? +b0.distanceTo(b1).toFixed(2) : '?'
      out.alive = !a.dead && !b.dead
      if (opts.check) Object.assign(out, await opts.check())
      for (const c of opts.after || []) director.cmd(c)
      report.push(out)
      console.log(JSON.stringify(out))
    }
    let timelordRange = null
    const blockName = (x, y, z) => { const bl = director.bot.blockAt(new Vec3(x, y, z)); return bl ? bl.name : '?' }

    await step('thor', { aim: [cx + 5.5, Y + 1, cz + 0.5] })
    await step('flash', { aim: [cx + 6.5, Y + 1, cz + 4.5] })
    await step('kangaroo')
    await step('pyro', { aim: [cx + 6.5, Y + 1.2, cz - 4.5], wait: 2500, check: async () => ({ stage_intact: blockName(cx + 6, Y, cz - 5) === 'stone' }) })
    await step('timelord', {
      wait: 500,
      // frozen by the kit, but a puppet's place is the recording's: B must keep shuffling
      during: async () => { let lo = Infinity; let hi = -Infinity; for (let i = 0; i < 30; i++) { const p = where(B); if (p) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z) } await U.sleep(60) } timelordRange = +(hi - lo).toFixed(2) },
      check: async () => ({ B_range_while_frozen: timelordRange })
    })
    await step('wisp')
    await step('cookiemonster')
    await step('jellyfish', { aim: [cx + 0.5, Y, cz + 4.5], check: async () => ({ water: blockName(cx, Y + 1, cz + 4) }) })
    await step('gladiator', { check: async () => ({ note: 'arena blocks appear high above; nobody is moved' }) })
    await step('monk', { before: [`/item replace entity ${B} weapon.mainhand with minecraft:stone_sword`], check: async () => { const e = director.bot.players[B].entity; return { B_holds_after: e.heldItem ? e.heldItem.name : 'nothing' } } })
    await step('hulk', { wait: 1200, during: async () => { await U.sleep(900); a.swing() }, check: async () => ({ note: 'grab, then the puppet swings an empty hand to throw' }) })
    await step('hulk', { wait: 6500, check: async () => ({ note: 'grab with no throw: the guard sets the rider down after 5 s' }) })
    await step('hades', { before: [`/summon minecraft:zombie ${cx - 1.5} ${Y + 1} ${cz + 2.5} {NoAI:1b,Tags:["tkit"],PersistenceRequired:1b}`], after: ['/kill @e[tag=tkit]'] })
    await step('beastmaster', { before: [`/summon minecraft:wolf ${cx - 1.5} ${Y + 1} ${cz + 2.5} {NoAI:1b,Tags:["tkit"],PersistenceRequired:1b}`], after: ['/kill @e[tag=tkit]'] })
    await step('endermage', { wait: 2500 })
    await step('demoman', {
      before: [`/setblock ${cx + 4} ${Y + 1} ${cz - 4} minecraft:gravel`, `/setblock ${cx + 4} ${Y + 2} ${cz - 4} minecraft:stone_pressure_plate`],
      aim: [cx + 4.5, Y + 2, cz - 3.5],
      during: async () => { await U.sleep(500); bAt = { x: cx + 4.5, y: Y + 2, z: cz - 3.5 }; await U.sleep(900); bAt = { ...pb } },
      check: async () => ({ stage_intact: blockName(cx + 4, Y, cz - 4) === 'stone' && blockName(cx + 3, Y, cz - 4) === 'stone' })
    })
    await step('launcher', {
      before: [`/setblock ${cx + 4} ${Y + 1} ${cz + 6} minecraft:sponge`], aim: [cx + 4.5, Y + 1, cz + 6.5],
      during: async () => { await U.sleep(500); bAt = { x: cx + 4.5, y: Y + 2, z: cz + 6.5 }; await U.sleep(700); bAt = { ...pb } },
      after: [`/setblock ${cx + 4} ${Y + 1} ${cz + 6} minecraft:air`]
    })
    for (const kit of ['viper', 'snail']) await step(kit, { times: 8 })
    for (const kit of ['cannibal', 'reaper', 'ninja']) await step(kit)
    await step('stomper')
    await step('switcher', { aim: [pb.x, pb.y + 1, pb.z] })
    await step('spiderman', { aim: [pb.x, pb.y + 1, pb.z], check: async () => ({ web_at_B: blockName(Math.floor(pb.x), Y + 1, Math.floor(pb.z)) }) })
    await step('fisherman')
    await step('digger', { aim: [cx - 6.5, Y + 1, cz - 6.5], wait: 4500 })
    await step('turtle') // a passive: nothing to fire, by design
    director.cmd(`/studio clear ${A}`); director.cmd(`/studio clear ${B}`); director.cmd('/studio reset')
    director.cmd('/kill @e[type=!minecraft:player]')
    await U.sleep(500)
  } finally {
    if (pump) clearInterval(pump)
    await a.disconnect(); await b.disconnect()
    await director.disconnect()
    await U.sleep(300)
    const pid = server.child.pid
    // is anything of the studio's listening on the status port? (the live server may be, the studio must not)
    let studioOwns8085 = false
    try { studioOwns8085 = require('child_process').execSync('ss -ltnpH 2>/dev/null || true').toString().split('\n').some(l => /:8085\s/.test(l) && l.includes(`pid=${pid},`)) } catch {}
    const statusDuring = await portOpen(8085)
    await server.stop()
    const log = fs.readFileSync(logFile, 'utf8').slice(logStart)
    const lines = log.split('\n')
    console.log('\n--- console.log of this run ---')
    console.log('studio mode line: ' + (lines.find(l => /STUDIO mode/.test(l)) || 'MISSING'))
    console.log(`port 8085 open before/while the studio ran: ${statusBefore}/${statusDuring}; bound by the studio process: ${studioOwns8085}`)
    const bad = lines.filter(l => /Exception|ERROR\]|SEVERE|Could not pass event|at com\.hardcorekits/.test(l))
    console.log(`error lines: ${bad.length}`); for (const l of bad.slice(0, 30)) console.log('  ' + l)
    console.log('match machinery lines (must be none): ' + lines.filter(l => /Waiting for players|Status server|status server|Recording|pregenerat|Hardcore Games enabled — state/i.test(l)).length)
    const fired = lines.filter(l => /studio: /.test(l)).map(l => l.replace(/^.*studio: /, ''))
    console.log(`plugin fire lines: ${fired.length}`); for (const l of fired) console.log('  ' + l)
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('FAILED: ' + (e.stack || e.message)); process.exit(1) })
