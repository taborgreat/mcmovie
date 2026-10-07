'use strict'
// Match films in real Minecraft. Each segment of the film (a replay cut out of
// the recording by lib/match/build.js) is played back on the studio server,
// in the match's own world, by one bot per player, and filmed by the real
// client with the same camera system the staged films use (lib/capture).
//
// What is real here: the map, the players' skins and name tags, what they
// hold and wear, every step, swing, hit flash and death (a real /kill, with
// the drop), block changes as they happened, lightning, explosions,
// fireworks, and the game's sound. What is replayed from the recording rather
// than simulated: where everyone is each tick.
const fs = require('fs')
const path = require('path')
const U = require('../util')
const studio = require('./server')
const client = require('../capture/client')
const { Film } = require('../capture/film')
const { Director } = require('../mc/director')
const { ActorBot } = require('../mc/actor')
const { readReplay, replayPath } = require('../mc/replay')
const { TickClock } = require('../mc/tickclock')

const PREROLL = 10
const POSTROLL = 10
const PARK_Y = 315 // bots that are not in the scene wait high above it, out of sight

const ARMOR_SLOTS = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet']
const ns = id => (String(id).includes(':') ? String(id) : 'minecraft:' + id)

// Recorded mobs and projectiles (the recorder follows every creature near a player: the iron
// golem that hits someone, the skeleton, the wolves, the cow in the way). Each is summoned as
// the real creature with its own mind switched off and walked along its recorded track, so
// it looks and sounds like itself.
const PROJECTILES = new Set(['arrow', 'spectral_arrow', 'snowball', 'egg', 'ender_pearl', 'trident', 'splash_potion', 'lingering_potion', 'wind_charge', 'small_fireball'])
const NOT_SUMMONED = new Set(['player', 'item', 'experience_orb', 'fishing_bobber', 'firework_rocket', 'lightning_bolt', 'falling_block', 'tnt', 'area_effect_cloud', 'fireball'])
const mobYaw = yaw => { let d = U.rad2deg(Math.PI - yaw) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d }

// With the game's plugin in the studio (studio.kits()), a kit ability is the plugin's own
// code, run for the bot at the tick the recording logged it. These kits put a real thing into
// the world when they fire (a thrown ball, a fireball, the Wisp's doubles), so the recorded
// track of that same thing is not also summoned as a puppet.
const ABILITY_MAKES = { switcher: 'snowball', spiderman: 'snowball', pyro: 'small_fireball', wisp: 'mannequin' }

// "/studio fire <player> <kit> [x y z]": the plugin hands the kit's listener the event it
// waits for (a right click with the kit's item, a block going down, a landing...).
function abilityCommand (fx) {
  const aim = Array.isArray(fx.aim) ? ' ' + fx.aim.map(v => (+v).toFixed(2)).join(' ') : ''
  return `/studio fire ${fx.player} ${fx.kit}${aim}`
}

class Creatures {
  constructor (director) { this.d = director; this.live = new Map(); this.gone = new Set(); this.standIns = []; this.waiting = [] }

  // a kit ability just put its own real creature or projectile here: the recorded one that
  // appears next to it in the next moments is the same thing, and is left out
  standIn (type, k, at) { this.standIns.push({ type, until: k + 14, x: at.x, y: at.y, z: at.z }) }

  isStandIn (type, k, e) {
    this.standIns = this.standIns.filter(s => s.until >= k)
    return this.standIns.some(s => s.type === type && Math.hypot(e.x - s.x, e.y - s.y, e.z - s.z) < 10)
  }

  tick (k, frame, players) {
    const seen = new Set()
    const standing = this.waiting.filter(w => w.k > k).map(w => w.e)
    for (const e of [...(frame.e || []), ...standing]) {
      // the creature's real type (older replays only carry the old renderer's stand-in name)
      let type = String(e.mc || e.name || '').replace('minecraft:', '')
      if (type === 'potion') type = 'splash_potion'
      if (!type || NOT_SUMMONED.has(type) || this.gone.has(e.id)) continue
      seen.add(e.id)
      const yaw = mobYaw(e.yaw || 0); const pitch = U.clamp(U.rad2deg(-(e.pitch || 0)), -90, 90)
      let m = this.live.get(e.id)
      if (!m && this.standIns.length && this.isStandIn(type, k, e)) { this.gone.add(e.id); seen.delete(e.id); continue }
      if (!m) {
        m = { tag: `mmob_${e.id}`, type }
        const nbt = PROJECTILES.has(type)
          ? `{Tags:["mmob","${m.tag}"],NoGravity:1b,Rotation:[${yaw.toFixed(1)}f,${pitch.toFixed(1)}f]}`
          // Both movement and damage come from the recording, not another physics pass.
          : `{Tags:["mmob","${m.tag}"],NoAI:1b,NoGravity:1b,Invulnerable:1b,PersistenceRequired:1b,active_effects:[{id:"minecraft:resistance",amplifier:3b,duration:-1,show_particles:0b}],Rotation:[${yaw.toFixed(1)}f,${pitch.toFixed(1)}f]}`
        this.d.cmd(`/summon minecraft:${type} ${e.x.toFixed(2)} ${e.y.toFixed(2)} ${e.z.toFixed(2)} ${nbt}`)
        this.live.set(e.id, m)
      } else if (Math.hypot(e.x - m.x, e.y - m.y, e.z - m.z) > 0.005 || Math.abs(yaw - m.yaw) > 1 || Math.abs(pitch - m.pitch) > 1) {
        this.d.cmd(`/tp @e[tag=${m.tag},limit=1] ${e.x.toFixed(3)} ${e.y.toFixed(3)} ${e.z.toFixed(3)} ${yaw.toFixed(1)} ${pitch.toFixed(1)}`)
      }
      m.x = e.x; m.y = e.y; m.z = e.z; m.yaw = yaw; m.pitch = pitch; m.k = k
      // a player's blow landed on it: the flinch and the sound, and the real death if it was the last
      if (e.hit && k >= 0) { this.flagged = true; this.struck(m, typeof e.hit === 'string' ? e.hit : null) }
      if (e.die && k >= 0) { this.d.cmd(`/filmactor die @e[tag=${m.tag}]`); this.live.delete(e.id); this.gone.add(e.id); continue }
      // this creature landed a hit right now: let it really swing at whoever is in front of it
      // Do not enable AI: it could create an attack absent from the recording.

    }
    for (const [id, m] of this.live) {
      if (seen.has(id) || k - m.k < 2) continue
      // Leaving the recorder range is not evidence of death. Remove offscreen.
      this.d.cmd(`/filmactor remove @e[tag=${m.tag}]`)
      this.live.delete(id)
    }
  }

  struck (m, by) {
    this.d.cmd(`/filmactor hurt @e[tag=${m.tag},limit=1]`)
  }

  clear () { this.d.cmd('/filmactor remove @e[tag=mmob]'); this.live.clear() }
}

async function runAll (director, cmds, gapMs = 4, every = 20) {
  for (let i = 0; i < cmds.length; i++) { director.cmd(cmds[i]); if (i % every === every - 1) await U.sleep(gapMs * every) }
}

function fxCommands (fx) {
  const at = `${fx.x.toFixed(1)} ${fx.y.toFixed(1)} ${fx.z.toFixed(1)}`
  switch (fx.type) {
    case 'explosion': return [`/particle minecraft:explosion_emitter ${at}`, `/playsound minecraft:entity.generic.explode master @a ${at} 4`]
    case 'lightning': return [`/summon minecraft:lightning_bolt ${at}`]
    case 'firework': {
      const colors = (fx.colors && fx.colors.length ? fx.colors : [16711680, 16776960]).slice(0, 6).join(',')
      return [`/summon minecraft:firework_rocket ${at} {LifeTime:0,FireworksItem:{id:"minecraft:firework_rocket",count:1,components:{"minecraft:fireworks":{explosions:[{shape:"large_ball",colors:[I;${colors}],has_twinkle:1b}]}}}}`]
    }
    case 'teleport': return [`/particle minecraft:portal ${fx.x.toFixed(1)} ${(fx.y + 1).toFixed(1)} ${fx.z.toFixed(1)} 0.3 0.6 0.3 0.4 40`, `/playsound minecraft:entity.enderman.teleport player @a ${at} 1`]
    case 'stew': return [`/playsound minecraft:entity.player.burp player @a ${at} 0.6`]
    case 'drop': {
      // thrown the way a player throws: forward from the hand, a short arc
      const r = U.deg2rad(fx.yaw || 0)
      return [`/summon minecraft:item ${at} {Item:{id:"${ns(fx.item)}",count:${Math.max(1, Math.min(64, fx.n || 1))}},PickupDelay:40,Motion:[${(-Math.sin(r) * 0.3).toFixed(2)}d,0.2d,${(Math.cos(r) * 0.3).toFixed(2)}d]}`]
    }
    case 'loot':
      // everything they carried spills out where they fell
      return (fx.items || []).slice(0, 14).map(([id, n], i) => `/summon minecraft:item ${fx.x.toFixed(1)} ${(fx.y + 0.6).toFixed(1)} ${fx.z.toFixed(1)} {Item:{id:"${ns(id)}",count:${Math.max(1, Math.min(64, n || 1))}},PickupDelay:60,Motion:[${(Math.cos(i * 2.4) * 0.14).toFixed(2)}d,0.25d,${(Math.sin(i * 2.4) * 0.14).toFixed(2)}d]}`)
    default: return []
  }
}

// the sound a block makes going down, near enough by what it is made of
function placeSound (state) {
  const b = String(state)
  const kind = /log|planks|wood|fence|door|chest|crafting|ladder|sign/.test(b) ? 'wood' : /dirt|grass|podzol|mud|farmland/.test(b) ? 'grass' : /sand|gravel|snow/.test(b) ? (/snow/.test(b) ? 'snow' : (/gravel/.test(b) ? 'gravel' : 'sand')) : /wool|carpet|cake|sponge/.test(b) ? 'wool' : /glass/.test(b) ? 'glass' : 'stone'
  return `minecraft:block.${kind}.place`
}

class Cast {
  constructor (cfg, director) { this.cfg = cfg; this.director = director; this.bots = new Map(); this.state = new Map(); this.identities = new Map() }

  async get (name) {
    if (this.bots.has(name)) return this.bots.get(name)
    const identity = this.identities.get(name) || { bot: name, display: name }
    const bot = new ActorBot(this.cfg, { id: identity.bot })
    await bot.connect()
    this.bots.set(name, bot)
    this.director.cmd(`/team join mactors ${identity.bot}`)
    // Skin clearing and setting are asynchronous in SkinsRestorer. Issuing both
    // together can leave an empty property after the correct skin was applied.
    await U.sleep(400)
    if (identity.skin) {
      this.director.sourceCommand(`/skin set ${identity.skin} ${identity.bot}`)
      let stable = 0
      for (let attempt = 0; attempt < 60; attempt++) {
        await U.sleep(250)
        let expected = null
        try {
          const cached = U.readJson(path.join(studio.DIR, 'plugins', 'SkinsRestorer', 'skins', identity.uuid + '.playerskin'))
          expected = JSON.parse(Buffer.from(cached.value, 'base64').toString()).textures.SKIN.url
        } catch { /* the first lookup may still be pending */ }
        const actual = this.director.bot.players[identity.bot]?.skinData?.url
        if (expected && actual && expected.split('/').pop() === actual.split('/').pop()) stable++; else stable = 0
        if (stable >= 6) break
      }
      if (stable < 6) throw new Error('Skin did not settle for ' + identity.id + '; refusing to film a wrong identity')
      U.log('studio', 'verified skin for ' + identity.id)
    } else {
      this.director.sourceCommand(`/skin clear ${identity.bot}`)
      await U.sleep(800)
    }
    this.state.set(name, { held: undefined, armor: undefined, parked: false, dead: false })
    this.director.cmd(`/gamemode survival ${name}`)
    this.director.cmd(`/effect give ${name} minecraft:saturation infinite 1 true`)
    // a creature's real swing must not kill the bot playing its victim: most of it is absorbed
    this.director.cmd(`/effect give ${name} minecraft:resistance infinite 3 true`)
    await U.sleep(150)
    return bot
  }

  park (name, center) {
    const s = this.state.get(name)
    if (s.parked || s.dead) return
    s.parked = true
    this.bots.get(name).expectTeleport()
    this.director.cmd(`/tp ${name} ${center[0]} ${PARK_Y} ${center[2]}`)
  }

  // bring a player back for a scene that happens before their death in the film's order
  async revive (name) {
    const s = this.state.get(name); const bot = this.bots.get(name)
    if (!s.dead) return
    bot.bot._client.write('client_command', { actionId: 0 })
    bot.dead = false; s.dead = false; s.held = undefined; s.armor = undefined; s.parked = false
    await U.sleep(400)
    this.director.cmd(`/gamemode survival ${name}`)
    this.director.cmd(`/effect give ${name} minecraft:saturation infinite 1 true`)
    this.director.cmd(`/effect give ${name} minecraft:resistance infinite 3 true`)
  }

  dress (name, st) {
    const s = this.state.get(name)
    const held = st.held || 'minecraft:air'
    if (held !== s.held) { s.held = held; this.director.cmd(`/item replace entity ${name} weapon.mainhand with ${ns(held)}`) }
    const armor = st.armor || ',,,'
    if (armor !== s.armor) {
      const now = armor.split(','); const was = (s.armor || ',,,').split(',')
      ARMOR_SLOTS.forEach((slot, i) => { if ((now[i] || '') !== (was[i] || '') || s.armor === undefined) this.director.cmd(`/item replace entity ${name} ${slot} with ${now[i] ? ns(now[i]) : 'minecraft:air'}`) })
      s.armor = armor
    }
  }

  async quit () { for (const b of this.bots.values()) await b.disconnect() }
}

async function performScene (ctx, scene, cuts, shots) {
  const { director, cast, film } = ctx
  const replay = readReplay(replayPath(ctx.dir, scene.id))
  const D = replay.meta.duration_ticks
  const center = replay.meta.center
  const frames = replay.frames
  const frameAt = k => frames[Math.max(0, Math.min(frames.length - 1, k))]
  U.log('studio', `scene ${scene.id}: ${D} ticks, ${cuts.length} cuts`)

  if (ctx.kits) director.cmd('/studio reset')
  ctx.blocks.clear()
  // the world as it stood when this moment began
  const live = replay.meta.live || { changed: [], forward: [] }
  const sets = []
  for (const [x, y, z, state] of live.changed) {
    const key = `${x},${y},${z}`
    if (ctx.blocks.get(key) === state) continue
    ctx.blocks.set(key, state)
    sets.push(`/setblock ${x} ${y} ${z} ${ns(state)}`)
  }
  await director.hover(center, -80)
  await director.waitForChunks(center, 5)
  if (sets.length) { U.log('studio', `rewinding ${sets.length} blocks to this moment`); await runAll(director, sets) }
  // the sky the match had at this moment
  director.cmd(`/time set ${Math.round(replay.meta.time_of_day || 6000)}`)
  director.cmd(`/weather ${['rain', 'thunder'].includes(replay.meta.weather) ? replay.meta.weather : 'clear'}`)
  director.cmd('/kill @e[type=minecraft:item]')

  director.cmd('/team add mactors')
  director.cmd('/team modify mactors nametagVisibility never')
  director.cmd('/team modify mactors collisionRule never')
  director.cmd('/filmlabel clear')
  director.cmd('/kill @e[tag=mlabel]')
  for (const identity of replay.meta.actors || []) cast.identities.set(identity.id, identity)
  // everyone who appears in this scene
  const names = [...new Set(frames.flatMap(f => (f.a || []).map(a => a.username)))]
  for (const n of names) { await cast.get(n); await cast.revive(n) }
  if (ctx.kits) {
    // Each bot gets its player's kit from the plugin itself, then is emptied again: what a
    // puppet holds and wears is what the recording shows (dressed below), and the plugin
    // lends it the kit's item for the moment an ability fires.
    const kitOf = replay.meta.kits || {}
    for (const n of names) {
      const kit = String(kitOf[n] || 'none').replace(/[^a-z0-9_]/gi, '') || 'none'
      director.cmd(`/studio kit ${n} ${kit}`)
      director.cmd(`/clear ${n}`)
      const s = cast.state.get(n); s.held = undefined; s.armor = undefined
    }
  }
  for (const n of cast.bots.keys()) if (!names.includes(n)) cast.park(n, center)
  const liveStates = {}
  for (const n of names) {
    const first = frames.map(f => (f.a || []).find(a => a.username === n)).find(Boolean)
    const now = (frames[0].a || []).find(a => a.username === n)
    const bot = cast.bots.get(n); const s = cast.state.get(n)
    director.cmd(`/effect clear ${n} minecraft:invisibility`)
    s.invisible = false
    if (now) { s.parked = false; await bot.place(director, now, now.yaw, now.pitch); cast.dress(n, now) } else { s.parked = false; cast.park(n, center) }
    liveStates[n] = now || first
  }
  for (const n of names) {
    const identity = cast.identities.get(n)
    if (identity) director.sourceCommand('/filmlabel set ' + identity.bot + ' ' + identity.display + '<' + (identity.kit || 'none') + '>')
  }
  await U.sleep(1200)
  const camCtx = { actor: id => liveStates[id] || null, actors: () => Object.entries(liveStates).filter(([id]) => !cast.state.get(id)?.parked && !cast.state.get(id)?.dead).map(([, state]) => state) }
  await film.begin({ id: scene.id }, cuts, shots, camCtx, center)

  const forward = live.forward.slice().sort((a, b) => a[0] - b[0])
  let fw = 0
  const creatures = new Creatures(director)
  // Only show creatures while the recorder actually observes them.
  creatures.flagged = !!replay.meta.mob_marks // the recording names the creature in every blow: no guessing
  director.cmd('/filmactor remove @e[tag=mmob]')
  // slow motion is the game itself running slow: swings, falls, particles and the death all
  // play at this speed on the client, and stay smooth
  const slow = scene.slowmo && scene.slowmo > 0 && scene.slowmo < 1 ? scene.slowmo : null
  if (slow) { director.cmd(`/tick rate ${(20 * slow).toFixed(1)}`); await U.sleep(400) }
  const clock = new TickClock(director)
  clock.start()
  for (const n of names) cast.bots.get(n).beginReplay()
  let late = 0
  for (let k = -PREROLL; k <= D + POSTROLL; k++) {
    const f = frameAt(k)
    for (const n of names) {
      const bot = cast.bots.get(n); const s = cast.state.get(n)
      const st = (f.a || []).find(a => a.username === n)
      if (!st) { if (!s.dead) cast.park(n, center); if (s.parked && !s.dead) bot.sendPose({ x: center[0], y: PARK_Y, z: center[2] }, 0, 0, false); continue }
      if (s.dead) continue
      if (s.parked) { s.parked = false; bot.expectTeleport(); director.cmd(`/tp ${n} ${st.x.toFixed(2)} ${st.y.toFixed(2)} ${st.z.toFixed(2)}`) }
      liveStates[n] = st
      if (st.dying) {
        // the real thing: the body tips over, the loot drops
        if (k >= 0) { director.cmd(`/filmactor die ${n}`); s.dead = true; bot.dead = true }
        continue
      }
      bot.swungThisTick = false
      // Replay coordinates are authoritative. Guessing a new floor from block
      // names made ladders, portal frames and half blocks kick actors up/down.
      bot.sendPose(st, st.yaw, st.pitch, st.grounded !== undefined ? st.grounded : st.anim !== 'jump' && st.anim !== 'fly')
      try { bot.setSneak(st.anim === 'sneak' || st.anim === 'crouch'); bot.setSprint(st.anim === 'sprint' && !!st.moving) } catch { /* not every protocol translation carries these */ }
      if (st.swing && k >= 0 && k < frames.length) {
        bot.swing()

      }
      cast.dress(n, st)
      if (st.hurt && k >= 0 && k < frames.length) {
        director.cmd(`/filmactor hurt ${n}`)
      }
      if (k % 40 === 0) director.cmd(`/effect give ${n} minecraft:instant_health 1 4 true`)
      // a player the recording saw as invisible (a kit, a potion) is invisible here too
      if (!!st.invisible !== s.invisible) {
        director.cmd(st.invisible ? `/effect give ${n} minecraft:invisibility infinite 0 true` : `/effect clear ${n} minecraft:invisibility`)
        s.invisible = !!st.invisible
      }
    }
    if (k >= 0 && k <= D) {
      const fired = []
      for (const fx of frames[Math.min(k, frames.length - 1)].x || []) {
        if (fx.type === 'ability') { if (ctx.kits && names.includes(fx.player) && !cast.state.get(fx.player).dead && /^[a-z0-9_]+$/i.test(String(fx.kit))) fired.push(fx); continue }
        // the bolt a kit's own ability is about to draw is not also replayed from the recording
        if (ctx.kits && fx.kit) continue
        for (const c of fxCommands(fx)) director.cmd(c)
      }
      while (fw < forward.length && forward[fw][0] <= k) {
        const [, x, y, z, state, how] = forward[fw++]
        ctx.blocks.set(`${x},${y},${z}`, state)
        const gone = /(^|:)(air|cave_air|void_air)$/.test(String(state))
        // a block broken by hand breaks for real: the crack of it, the bits flying, the item
        // dropping. A blast already has its own bang and cloud.
        if (gone && how !== 'explosion') director.cmd(`/setblock ${x} ${y} ${z} minecraft:air destroy`)
        else {
          director.cmd(`/setblock ${x} ${y} ${z} ${ns(state)}`)
          if (!gone && how !== 'explosion') director.cmd(`/playsound ${placeSound(state)} block @a ${x} ${y} ${z} 1`)
        }
      }
      // after this tick's blocks, so a kit whose ability is a block going down finds it there
      for (const fx of fired) {
        director.cmd(abilityCommand(fx))
        if (ABILITY_MAKES[fx.kit]) creatures.standIn(ABILITY_MAKES[fx.kit], k, liveStates[fx.player] || fx)
      }
    }
    creatures.tick(k, k >= 0 && k < frames.length ? f : { ...f, e: (f.e || []).map(e => ({ ...e, hit: false, die: false, atk: false })) }, liveStates)
    film.tick(k, camCtx)
    if (!(await clock.wait(k + PREROLL + 1))) late++
  }
  for (const n of names) cast.bots.get(n).endReplay()
  await film.end()
  if (slow) director.cmd('/tick rate 20')
  creatures.clear()
  if (late > Math.max(2, Math.ceil(D * 0.02))) throw new Error(`scene ${scene.id} missed ${late} replay beats; retry this take instead of exporting stutter`)
  const clips = await film.finish()
  U.log('studio', `scene ${scene.id} filmed (${late} late ticks)`)
  return { id: scene.id, clips, late_ticks: late }
}

// Film every cut of a match project in the studio. Returns the clips; throws if the studio
// cannot do it (the caller tries again; it does not quietly hand the film to the offline renderer).
async function perform (dir, opts = {}) {
  if (!studio.available() || !client.available()) throw new Error('the studio is not set up (studio/ and capture/)')
  const tlFile = path.join(dir, 'timeline.json')
  const tl = U.readJson(tlFile)
  let scenes = tl.scenes.filter(s => tl.cuts.some(c => c.scene_id === s.id))
  if (opts.scene) scenes = scenes.filter(s => s.id === opts.scene)
  if (!scenes.length) throw new Error('no scenes to film')
  for (const s of scenes) if (!U.exists(replayPath(dir, s.id))) throw new Error(`no replay for scene ${s.id}; run build first`)

  // Invalidate only the scenes being reshot, including if server startup fails.
  // Assembly must not silently reuse an older take as the new replay.
  const reshooting = new Set(scenes.map(s => s.id))
  for (const c of tl.cuts) if (reshooting.has(c.scene_id)) { delete c.clip; delete c.frames; delete c.source }
  U.writeJson(tlFile, tl)

  await studio.stopRunning()
  if (await studio.firstBoot()) U.log('studio', 'first start of the studio server: it made its world')
  require('./labels').install()
  if (opts.regionDir && U.exists(opts.regionDir)) U.log('studio', `loaded ${studio.loadWorld(opts.regionDir)} region files of the match world`)
  else if (!opts.keepWorld) throw new Error('the match world (recording region files) is not available')
  const server = await studio.start()
  const scfg = server.cfg
  const cfg = { host: scfg.host, port: scfg.port, version: scfg.bot_version }
  let director = new Director(cfg, { verbose: opts.verbose })
  const results = []
  let cast = null
  let film = null
  try {
    // Now and then the server lets a first login hang until it times out. That is not a reason
    // to lose the take: join again.
    for (let attempt = 1; ; attempt++) {
      try { await director.connect(); break } catch (e) {
        if (attempt >= 3) throw e
        U.log('studio', `the director could not join (${e.message}); joining again (${attempt + 1} of 3)`)
        try { await director.disconnect() } catch { /* never joined */ }
        await U.sleep(4000)
        director = new Director(cfg, { verbose: opts.verbose })
      }
    }
    // both the old and the new names of the game rules; the wrong one is ignored
    for (const c of ['gamerule doDaylightCycle false', 'gamerule advance_time false', 'gamerule doWeatherCycle false', 'gamerule advance_weather false',
      'gamerule doMobSpawning false', 'gamerule spawn_mobs false', 'gamerule doMobLoot false', 'gamerule mob_drops false',
      // the bots are real players on a real server: a recorded drop or swim must not hurt them a second time.
      // Only the hits the recording logged do (sent as /damage).
      'gamerule fallDamage false', 'gamerule fall_damage false', 'gamerule drowningDamage false', 'gamerule drowning_damage false',
      'gamerule fireDamage false', 'gamerule fire_damage false', 'gamerule freezeDamage false', 'gamerule freeze_damage false', 'gamerule doFireTick false', 'gamerule fire_spread_radius 0', 'gamerule mobGriefing false', 'gamerule mob_griefing false',
      'gamerule announceAdvancements false', 'gamerule show_advancement_messages false', 'gamerule showDeathMessages false', 'gamerule show_death_messages false',
      'gamerule locatorBar false', 'gamerule locator_bar false', 'gamerule sendCommandFeedback false', 'gamerule send_command_feedback false', 'weather clear', 'difficulty easy']) director.cmd('/' + c)
    const size = { width: opts.width || 1920, height: opts.height || 1080 }
    await client.start({ ...size, host: scfg.host, port: scfg.port, version: scfg.game_version })
    await client.waitJoined(director)
    cast = new Cast(cfg, director)
    director.sourceCommand = director.cmd.bind(director)
    director.cmd = command => director.sourceCommand(command.split(/(\s+)/).map(token => cast.identities.get(token)?.bot || token).join(''))
    // the game's own plugin, if the studio has it: kit abilities are then the real thing
    const kits = studio.kits()
    if (kits) U.log('studio', 'kit abilities are played by the game plugin (/studio)')
    film = new Film({ director, dir, fps: opts.fps || tl.fps || 30, ...size })
    const ctx = { dir, director, cast, kits, blocks: new Map(), film }
    for (const s of scenes) results.push(await performScene(ctx, s, tl.cuts.filter(c => c.scene_id === s.id), tl.shots))
  } finally {
    if (film) await film.abort()
    await client.stop()
    if (cast) await cast.quit()
    await director.disconnect()
    await U.sleep(300)
    await server.stop()
  }
  const out = U.readJson(tlFile)
  let n = 0
  for (const r of results) {
    for (const k of r.clips) {
      const c = out.cuts.find(x => x.shot_id === k.cut.shot_id && x.start_tick === k.cut.start_tick)
      if (c) { c.clip = k.clip; c.frames = k.frames; c.fps = opts.fps || out.fps; c.source = 'client'; n++ }
      const sh = out.shots.find(x => x.id === k.cut.shot_id)
      if (sh) sh.clip = k.clip
    }
  }
  U.writeJson(tlFile, out)
  fs.writeFileSync(path.join(dir, 'studio_log.json'), JSON.stringify(results.map(r => ({ id: r.id, clips: r.clips.length, late_ticks: r.late_ticks })), null, 2))
  return { clips: n, scenes: results.length }
}

module.exports = { Creatures, perform, performScene, Cast, abilityCommand, ABILITY_MAKES }
