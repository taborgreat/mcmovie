'use strict'
// One actor = one mineflayer bot with physics disabled. The shoot controller
// computes the actor's state every tick from its keyframes (lib/motion.js)
// and this class turns that into packets: position/look, sneak/sprint
// actions, arm swings, plus server commands for things a client can't fake
// (damage, death, held items).
const mineflayer = require('mineflayer')
const U = require('../util')

function toNotchYaw (yaw) { return U.rad2deg(Math.PI - yaw) }
function toNotchPitch (pitch) { return U.rad2deg(-pitch) }

class ActorBot {
  constructor (cfg, def) {
    this.cfg = cfg
    this.id = def.id
    this.def = def
    this.bot = null
    this.sneaking = false
    this.sprinting = false
    this.held = null
    this.lastSwingTick = -100
    this.swungThisTick = false
    this.dead = false
    this.deathTick = null
    this.hurtTick = null
    this.armor = ''
  }

  async connect () {
    const bot = mineflayer.createBot({
      host: this.cfg.host, port: this.cfg.port, username: this.id,
      version: this.cfg.version, auth: 'offline', physicsEnabled: false, viewDistance: 'tiny', checkTimeoutInterval: 120000
    })
    this.bot = bot
    bot.on('kicked', r => U.log('actor:' + this.id, 'kicked: ' + JSON.stringify(r)))
    bot.on('error', e => U.log('actor:' + this.id, 'error: ' + e.message))
    bot.on('death', () => { this.dead = true })
    bot.on('respawn', () => { this.dead = false })
    await new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('end', () => reject(new Error(`actor ${this.id} disconnected before spawn`)))
      bot.once('error', reject)
    })
    return bot
  }

  get entityId () { return this.bot && this.bot.entity ? this.bot.entity.id : -1 }

  // Place via server teleport (long distances) then take over with packets.
  async place (director, pos, yaw, pitch) {
    director.cmd(`/gamemode survival ${this.id}`)
    director.cmd(`/effect give ${this.id} minecraft:saturation infinite 1 true`)
    director.cmd(`/tp ${this.id} ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)} ${toNotchYaw(yaw).toFixed(1)} ${toNotchPitch(pitch).toFixed(1)}`)
    await U.sleep(250)
    for (let i = 0; i < 5; i++) { this.sendPose(pos, yaw, pitch, true); await U.sleep(50) }
  }

  sendPose (pos, yaw, pitch, onGround = true) {
    this.bot.entity.position.set(pos.x, pos.y, pos.z)
    this.bot.entity.yaw = yaw
    this.bot.entity.pitch = pitch
    this.bot._client.write('position_look', {
      x: pos.x, y: pos.y, z: pos.z, yaw: toNotchYaw(yaw), pitch: toNotchPitch(pitch),
      flags: { onGround, hasHorizontalCollision: false }
    })
  }

  setSneak (on) {
    if (on === this.sneaking) return
    this.sneaking = on
    this.bot._client.write('entity_action', { entityId: this.entityId, actionId: on ? 0 : 1, jumpBoost: 0 })
  }

  setSprint (on) {
    if (on === this.sprinting) return
    this.sprinting = on
    this.bot._client.write('entity_action', { entityId: this.entityId, actionId: on ? 3 : 4, jumpBoost: 0 })
  }

  swing () {
    this.bot._client.write('arm_animation', { hand: 0 })
    this.swungThisTick = true
  }

  // Apply a motion state (from ActorTrack.stateAt) at tick t.
  apply (state, t) {
    this.swungThisTick = false
    if (this.dead) return
    const anim = state.anim
    const grounded = anim !== 'fly' && anim !== 'jump'
    this.sendPose(state, state.yaw, state.pitch, grounded)
    this.setSneak(anim === 'sneak' || anim === 'crouch')
    this.setSprint(anim === 'sprint' && state.moving)
    if (anim === 'swing' && t - this.lastSwingTick >= 6) { this.swing(); this.lastSwingTick = t }
  }

  // One-shot actions scheduled on a keyframe. t is the scene tick it fires on.
  async oneshot (action, director, t = 0) {
    const idx = String(action).indexOf(':')
    const kind = idx < 0 ? String(action) : String(action).slice(0, idx)
    const arg = idx < 0 ? undefined : String(action).slice(idx + 1)
    switch (kind) {
      case 'swing_once': this.swing(); break
      case 'hurt': director.cmd(`/damage ${this.id} ${arg || 1} minecraft:generic`); this.hurtTick = t; break
      case 'death': director.cmd(`/kill ${this.id}`); this.dead = true; this.deathTick = t; break
      case 'wear': {
        // a full set of one material: wear:iron, wear:diamond, wear:leather, wear:golden ...
        const m = (arg || 'iron').replace('minecraft:', '')
        const pieces = { 'armor.head': `${m}_helmet`, 'armor.chest': `${m}_chestplate`, 'armor.legs': `${m}_leggings`, 'armor.feet': `${m}_boots` }
        for (const [slot, item] of Object.entries(pieces)) director.cmd(`/item replace entity ${this.id} ${slot} with minecraft:${item}`)
        this.armor = Object.values(pieces).join(',')
        break
      }
      case 'respawn':
        this.bot._client.write('client_command', { actionId: 0 })
        this.dead = false
        break
      case 'hold':
        this.held = arg || 'minecraft:air'
        director.cmd(`/item replace entity ${this.id} weapon.mainhand with ${this.held}`)
        break
      case 'drop':
        this.held = null
        director.cmd(`/item replace entity ${this.id} weapon.mainhand with minecraft:air`)
        break
      case 'jump_once': break // handled in motion
      default: U.log('actor:' + this.id, `unknown one-shot ${action}`)
    }
  }

  // What the replay records for this actor this tick. A death plays out as a short fall
  // (the renderer tips the body over and scatters loot) before the actor disappears.
  record (state, t = 0) {
    const dying = this.dead && this.deathTick !== null && t - this.deathTick <= 24 ? Math.max(0.05, (t - this.deathTick) / 24) : 0
    const extra = {}
    if (dying) extra.dying = +dying.toFixed(2)
    if (this.hurtTick !== null && t - this.hurtTick >= 0 && t - this.hurtTick <= 1) extra.hurt = 1
    if (this.armor) extra.armor = this.armor
    return {
      ...extra,
      id: this.entityId, username: this.id, name: 'player',
      x: +state.x.toFixed(3), y: +state.y.toFixed(3), z: +state.z.toFixed(3),
      yaw: +state.yaw.toFixed(4), pitch: +state.pitch.toFixed(4),
      anim: state.anim, moving: state.moving ? 1 : 0, swing: this.swungThisTick ? 1 : 0,
      held: this.held, dead: this.dead && !dying ? 1 : 0, skin: this.def.skin || null, model: this.def.model || 'classic'
    }
  }

  async disconnect () {
    if (this.bot) { try { this.bot.quit() } catch {} }
  }
}

module.exports = { ActorBot, toNotchYaw, toNotchPitch }
