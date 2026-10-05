'use strict'
// The director is an op'd mineflayer bot ("Camera") that runs server
// commands (building sets, world events, gamemodes) and observes the world
// and all entities so the replay can be recorded. It is also what loads the
// chunks around the set. It never appears in renders.
const mineflayer = require('mineflayer')
const U = require('../util')

const SET_ROOT = require('path').join(U.ROOT, 'sets')
const FILL_LIMIT = 32768

function fmt (n) { return Number.isInteger(n) ? String(n) : n.toFixed(2) }
function xyz (a) { return `${fmt(a[0])} ${fmt(a[1])} ${fmt(a[2])}` }

// Split a fill that exceeds the vanilla per-command block limit.
function fillCommands (from, to, block, mode) {
  const lo = [0, 1, 2].map(i => Math.min(from[i], to[i]))
  const hi = [0, 1, 2].map(i => Math.max(from[i], to[i]))
  const vol = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1)
  const suffix = mode ? ' ' + mode : ''
  if (vol <= FILL_LIMIT) return [`/fill ${xyz(lo)} ${xyz(hi)} ${block}${suffix}`]
  // slice along the longest horizontal axis
  const out = []
  const axis = (hi[0] - lo[0]) >= (hi[2] - lo[2]) ? 0 : 2
  const other = axis === 0 ? 2 : 0
  const sliceLen = Math.max(1, Math.floor(FILL_LIMIT / ((hi[1] - lo[1] + 1) * (hi[other] - lo[other] + 1))))
  for (let a = lo[axis]; a <= hi[axis]; a += sliceLen) {
    const f = lo.slice(); const t = hi.slice()
    f[axis] = a; t[axis] = Math.min(hi[axis], a + sliceLen - 1)
    out.push(`/fill ${xyz(f)} ${xyz(t)} ${block}${suffix === ' hollow' || suffix === ' outline' ? '' : suffix}`)
  }
  return out
}

// Translate one world/set op (or scene world_event) into server commands.
// `origin` offsets relative coordinates for loaded set files.
function opToCommands (op, origin = [0, 0, 0]) {
  const o = (p) => p ? [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]] : null
  switch (op.type) {
    case 'fill': return fillCommands(o(op.from), o(op.to), op.block || 'minecraft:stone', op.mode)
    case 'line': return fillCommands(o(op.from), o(op.to), op.block || 'minecraft:stone', op.mode)
    case 'clear': return fillCommands(o(op.from), o(op.to), 'minecraft:air')
    case 'setblock': return [`/setblock ${xyz(o(op.at))} ${op.block || 'minecraft:stone'}`]
    case 'box': {
      const a = o(op.at); const s = op.size || [5, 4, 5]
      return fillCommands(a, [a[0] + s[0] - 1, a[1] + s[1] - 1, a[2] + s[2] - 1], op.block || 'minecraft:oak_planks', op.mode || 'hollow')
    }
    case 'floor': {
      const a = o(op.at); const s = op.size || [8, 1, 8]
      return fillCommands(a, [a[0] + s[0] - 1, a[1], a[2] + s[2] - 1], op.block || 'minecraft:stone_bricks')
    }
    case 'summon': return [`/summon ${op.entity || 'minecraft:cow'} ${xyz(o(op.at))}${op.nbt ? ' ' + op.nbt : ''}`]
    case 'kill': return [`/kill ${op.selector || '@e[type=!player]'}`]
    case 'time': return [`/time set ${op.value}`]
    case 'weather': return [`/weather ${op.value || 'clear'}`]
    case 'explode': return [`/summon minecraft:tnt ${xyz(o(op.at))} {fuse:0${op.power ? ',explosion_power:' + op.power : ''}}`]
    case 'lightning': return [`/summon minecraft:lightning_bolt ${xyz(o(op.at))}`]
    case 'sound': return [`/playsound ${op.name} master @a ${op.at ? xyz(o(op.at)) : '~ ~ ~'}`]
    case 'particle': return [`/particle ${op.name} ${op.at ? xyz(o(op.at)) : '~ ~ ~'}`]
    case 'item': return [`/item replace entity ${op.selector || op.actor} ${op.slot || 'weapon.mainhand'} with ${op.value || op.block || 'minecraft:air'}`]
    case 'command': return [op.cmd.startsWith('/') ? op.cmd : '/' + op.cmd]
    case 'load': {
      const file = require('path').join(SET_ROOT, op.name.endsWith('.json') ? op.name : op.name + '.json')
      const set = U.readJson(file)
      const at = o(op.at || [0, 0, 0])
      const out = []
      for (const sub of set.ops || []) out.push(...opToCommands(sub, at))
      return out
    }
    default: throw new Error(`unknown op type ${op.type}`)
  }
}

class Director {
  constructor (cfg, opts = {}) {
    this.cfg = cfg
    this.opts = opts
    this.bot = null
    this.username = opts.username || 'Camera'
    this.blockUpdates = [] // collected since last drain
    this._lastBlockUpdate = 0
  }

  async connect () {
    const bot = mineflayer.createBot({
      host: this.cfg.host, port: this.cfg.port, username: this.username,
      version: this.cfg.version, auth: 'offline', physicsEnabled: false,
      viewDistance: this.opts.viewDistance || 10, checkTimeoutInterval: 120000
    })
    this.bot = bot
    bot.on('kicked', r => U.log('director', 'kicked: ' + JSON.stringify(r)))
    bot.on('error', e => U.log('director', 'error: ' + e.message))
    bot.on('blockUpdate', (oldB, newB) => {
      if (!newB) return
      this.blockUpdates.push({ x: newB.position.x, y: newB.position.y, z: newB.position.z, s: newB.stateId })
      this._lastBlockUpdate = Date.now()
    })
    await new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('end', () => reject(new Error('director disconnected before spawn')))
      bot.once('error', reject)
    })
    // when the server's once-a-second time packet arrives: lib/mc/tickclock.js keeps the shoot
    // in step with the server's ticks from these
    this.tickTimes = []
    bot._client.on('update_time', () => { this.tickTimes.push(Date.now()); if (this.tickTimes.length > 20) this.tickTimes.shift() })
    await U.sleep(500)
    this.cmd(`/gamemode spectator ${this.username}`)
    return bot
  }

  cmd (c) {
    if (!c.startsWith('/')) c = '/' + c
    if (this.opts.verbose) U.log('cmd', c)
    this.bot.chat(c)
  }

  // Run commands with a small pacing delay so the server keeps up.
  async run (commands, delayMs = 30) {
    for (const c of commands) { this.cmd(c); await U.sleep(delayMs) }
  }

  async baseline (world) {
    const rules = [
      '/gamerule doDaylightCycle false', '/gamerule doWeatherCycle false', `/gamerule doMobSpawning ${world.natural ? 'true' : 'false'}`,
      '/gamerule randomTickSpeed 0', '/gamerule doFireTick false', '/gamerule mobGriefing false',
      '/gamerule sendCommandFeedback false', '/gamerule announceAdvancements false', '/gamerule doImmediateRespawn true',
      '/gamerule fallDamage false', '/gamerule doTileDrops false', '/gamerule commandModificationBlockLimit 2000000',
      '/gamerule spectatorsGenerateChunks true', '/gamerule logAdminCommands false', '/gamerule commandBlockOutput false',
      `/time set ${world.time_of_day !== undefined ? world.time_of_day : 6000}`,
      `/weather ${world.weather || 'clear'}`
    ]
    await this.run(rules, 20)
  }

  // Teleport the director to hover over a point so chunks and entities load.
  async hover (center, height = 12) {
    this.cmd(`/tp ${this.username} ${fmt(center[0])} ${fmt(center[1] + height)} ${fmt(center[2])}`)
    await U.sleep(300)
  }

  // Wait until the columns around a point have arrived (fresh terrain takes a moment to generate).
  async waitForChunks (center, radius = 4, maxMs = 45000) {
    const cx = Math.floor(center[0] / 16); const cz = Math.floor(center[2] / 16)
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      let missing = 0
      for (let x = cx - radius; x <= cx + radius; x++) for (let z = cz - radius; z <= cz + radius; z++) if (!this.bot.world.getColumn(x, z)) missing++
      if (!missing) return true
      await U.sleep(400)
    }
    return false
  }

  // Natural-terrain stage: take the trees and the tall grass off it, leave everything around it.
  async clearStage (stage) {
    const [x0, y0, z0] = stage.from; const [x1, , z1] = stage.to
    const cmds = []
    for (const tag of ['#minecraft:logs', '#minecraft:leaves']) cmds.push(...fillCommands([x0, y0 + 1, z0], [x1, y0 + 30, z1], 'minecraft:air', `replace ${tag}`))
    // two-block grass and ferns hide the actors from a real camera; short grass stays
    for (const b of ['minecraft:tall_grass', 'minecraft:large_fern']) cmds.push(...fillCommands([x0, y0 - 6, z0], [x1, y0 + 12, z1], 'minecraft:air', `replace ${b}`))
    await this.run(cmds, 60)
    await this.settle()
  }

  async buildSet (set) {
    const cmds = []
    for (const op of set.ops || []) cmds.push(...opToCommands(op))
    U.log('director', `building set ${set.id}: ${cmds.length} commands`)
    await this.run(cmds, 40)
    await this.settle()
  }

  // Between scenes: on a built flat set everything goes; on natural terrain the animals are
  // part of the backdrop, so only litter is removed.
  async clearEntities (natural = false) {
    if (natural) { this.cmd('/kill @e[type=item]'); this.cmd('/kill @e[type=experience_orb]'); this.cmd('/kill @e[type=tnt]') } else this.cmd('/kill @e[type=!player]')
    await U.sleep(100)
  }

  // Wait until the server has stopped sending block updates.
  async settle (quietMs = 600, maxMs = 20000) {
    const start = Date.now()
    this._lastBlockUpdate = Date.now()
    while (Date.now() - start < maxMs) {
      await U.sleep(100)
      if (Date.now() - this._lastBlockUpdate > quietMs) return
    }
  }

  drainBlockUpdates () {
    const out = this.blockUpdates
    this.blockUpdates = []
    return out
  }

  // Snapshot every entity this bot can see except itself and listed actors.
  entitiesExcept (names) {
    const out = []
    for (const e of Object.values(this.bot.entities)) {
      if (!e || e === this.bot.entity) continue
      if (e.username && (names.has(e.username) || e.username === this.username)) continue
      if (!e.position) continue
      out.push({ id: e.id, type: e.type, name: e.name, x: e.position.x, y: e.position.y, z: e.position.z, yaw: e.yaw, pitch: e.pitch, w: e.width, h: e.height })
    }
    return out
  }

  // Serialize loaded chunk columns within `radius` chunks of center.
  dumpColumns (center, radius) {
    const cx = Math.floor(center[0] / 16); const cz = Math.floor(center[2] / 16)
    const out = []
    for (const c of this.bot.world.getColumns()) {
      const x = parseInt(c.chunkX, 10); const z = parseInt(c.chunkZ, 10)
      if (Math.abs(x - cx) > radius || Math.abs(z - cz) > radius) continue
      try { out.push({ x, z, json: c.column.toJson() }) } catch (e) { U.log('director', `column ${x},${z} dump failed: ${e.message}`) }
    }
    return out
  }

  async disconnect () {
    if (this.bot) { try { this.bot.quit() } catch {} }
    await U.sleep(200)
  }
}

module.exports = { Director, opToCommands, fillCommands }
