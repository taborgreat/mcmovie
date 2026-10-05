'use strict'
// Stage 5a: drive the Minecraft server from shoot.json on a tick clock and
// record a replay per scene. Nothing is rendered here; the renderer turns
// replays into clips afterwards (so a single shot can be re-rendered without
// re-shooting, and the renderer can be swapped later).
const path = require('path')
const fs = require('fs')
const U = require('../util')
const server = require('./server')
const { TickClock } = require('./tickclock')
const { Director } = require('./director')
const { ActorBot } = require('./actor')
const { buildTracks } = require('../motion')
const { opToCommands } = require('./director')
const { ReplayWriter, replayPath } = require('./replay')

const PREROLL_TICKS = 10
const POSTROLL_TICKS = 10

// Where feet should be at (x,z) for a planned height y. Normally the surface just below
// (so roofs overhead are ignored); if the plan put the actor inside the ground (real terrain
// is higher than the plan thought), the first standing room above.
function groundAt (bot, x, y, z) {
  const V = require('vec3').Vec3
  const bx = Math.floor(x); const bz = Math.floor(z)
  const solidTop = (by) => {
    const b = bot.blockAt(new V(bx, by, bz))
    if (!b || b.boundingBox !== 'block') return null
    return b.shapes && b.shapes.length ? by + Math.max(...b.shapes.map(s => s[4])) : by + 1
  }
  const buried = solidTop(Math.floor(y + 0.2)) !== null && solidTop(Math.floor(y + 0.2)) > y + 0.4
  if (buried) {
    for (let by = Math.floor(y); by <= Math.floor(y) + 6; by++) {
      const top = solidTop(by)
      if (top !== null && solidTop(by + 1) === null && solidTop(by + 2) === null) return top
    }
    return null
  }
  for (let by = Math.floor(y + 1.5); by >= Math.floor(y) - 6; by--) {
    const top = solidTop(by)
    if (top !== null && top <= y + 1.5) return top
  }
  return null
}

async function shootScene (ctx, scene, opts) {
  const { director, cfg, dir, replayDir } = ctx
  const set = scene.set
  const center = set ? set.origin : [0, 65, 0]
  const radius = (set && set.radius) || 6
  U.log('shoot', `scene ${scene.id}: ${scene.duration_ticks} ticks, ${scene.actors.length} actors, ${scene.shots.length} shots`)

  // when the real client films, the director waits deep under the set: a spectator would
  // otherwise show up in shot as a ghost head
  await director.hover(center, ctx.film ? -80 : 24)
  await director.waitForChunks(center, Math.min(radius, 6))
  await U.sleep(1500)
  await director.clearEntities(!!ctx.world.natural)
  if (set && !ctx.builtSets.has(set.id)) {
    if (ctx.world.stage) await director.clearStage(ctx.world.stage)
    await director.buildSet(set)
    ctx.builtSets.add(set.id)
  }
  // scene-start world events (tick <= 0)
  const events = (scene.world_events || []).slice().sort((a, b) => a.tick - b.tick)
  for (const ev of events.filter(e => e.tick <= 0)) await director.run(opToCommands(ev), 30)

  // actors
  const { tracks, ctx: mctx } = buildTracks({ keyframes: scene.keyframes })
  const actors = []
  for (const def of scene.actors) {
    const a = new ActorBot(cfg, def)
    await a.connect()
    actors.push(a)
    await U.sleep(150)
    // the real client shows real skins: the set server's SkinsRestorer fetches the cast skin by name
    if (ctx.film && def.skin && def.skin !== def.id) director.cmd(`/skin set ${def.skin} ${def.id}`)
  }
  if (ctx.film) await U.sleep(2500)
  for (const a of actors) {
    const st = tracks[a.id].stateAt(tracks[a.id].firstTick, mctx)
    await a.place(director, st, st.yaw, st.pitch)
  }
  await U.sleep(800)
  await director.settle(500, 5000)
  director.drainBlockUpdates()

  // the world as it is at tick 0
  const columns = director.dumpColumns(center, radius)
  U.log('shoot', `captured ${columns.length} chunk columns around ${center.join(',')}`)

  const replay = new ReplayWriter({
    scene_id: scene.id, duration_ticks: scene.duration_ticks, version: cfg.version, ground_y: ctx.world.ground_y,
    center, radius, recorded: new Date().toISOString(), time_of_day: ctx.world.time_of_day, weather: ctx.world.weather,
    actors: scene.actors
  })
  replay.setColumns(columns)
  const actorNames = new Set(actors.map(a => a.id))
  const shotLog = scene.shots.map(s => ({ id: s.id, start_tick: s.start_tick, end_tick: s.end_tick, actual_start_tick: null, actual_end_tick: null }))
  const lineLog = scene.lines.map(l => ({ id: l.id, tick: l.tick, actual_tick: null }))
  const pending = events.filter(e => e.tick > 0)

  // live filming: the real client records this take through one camera per cut
  const live = {}
  for (const a of actors) live[a.id] = tracks[a.id].stateAt(tracks[a.id].firstTick, mctx)
  const camCtx = { actor: (id) => live[id] || null }
  const film = ctx.film
  if (film) await film.begin(scene, ctx.timeline.cuts.filter(c => c.scene_id === scene.id), ctx.timeline.shots, camCtx, center)

  // tick clock
  const total = scene.duration_ticks + POSTROLL_TICKS
  const clock = new TickClock(director)
  clock.start()
  const t0 = Date.now()
  let lateTicks = 0
  for (let t = -PREROLL_TICKS; t <= total; t++) {
    const serverAge = director.bot.time ? director.bot.time.age : null
    const frameActors = []
    for (const a of actors) {
      const tr = tracks[a.id]
      const st = tr.stateAt(Math.max(t, tr.firstTick), mctx)
      if (!st.present && t < tr.firstTick) { /* actor waits at first keyframe */ }
      const def = scene.actors.find(d => d.id === a.id)
      const snap = (scene.keyframes.find(k => k.actor === a.id && k.snap_to_ground !== undefined) || {}).snap_to_ground
      if ((snap === undefined ? opts.snapToGround !== false : snap) && st.anim !== 'fly' && st.anim !== 'jump') {
        const g = groundAt(director.bot, st.x, st.y, st.z)
        if (g !== null && Math.abs(g - st.y) < 6.5) st.y = g
      }
      if (t >= 0) for (const o of tr.oneshotsAt(t)) await a.oneshot(o, director, t)
      a.apply(st, t)
      live[a.id] = st
      if (t >= 0) frameActors.push(a.record(st, t))
      void def
    }
    if (film) film.tick(t, camCtx)
    if (t >= 0) {
      while (pending.length && pending[0].tick <= t) {
        const ev = pending.shift()
        await director.run(opToCommands(ev), 0)
        replay.addEvent(t, 'world_event', { event: ev, server_age: serverAge })
      }
      for (const s of shotLog) {
        if (s.start_tick === t) { s.actual_start_tick = t; replay.addEvent(t, 'shot_start', { id: s.id, server_age: serverAge }) }
        if (s.end_tick === t) { s.actual_end_tick = t; replay.addEvent(t, 'shot_end', { id: s.id, server_age: serverAge }) }
      }
      for (const l of lineLog) if (l.tick === t) { l.actual_tick = t; replay.addEvent(t, 'line', { id: l.id, server_age: serverAge }) }
      replay.addFrame(t, frameActors, director.entitiesExcept(actorNames), director.drainBlockUpdates())
    }
    // wait for the next tick boundary (never skip ticks; drift is logged)
    if (!(await clock.wait(t + PREROLL_TICKS + 1))) lateTicks++
  }
  const wall = (Date.now() - t0) / 1000
  U.log('shoot', `scene ${scene.id} done in ${wall.toFixed(1)}s (${lateTicks} late ticks)`)
  for (const s of shotLog) if (s.actual_end_tick === null) s.actual_end_tick = Math.min(s.end_tick, scene.duration_ticks)

  if (film) await film.end()
  for (const a of actors) await a.disconnect()
  await U.sleep(300)
  const clips = film ? await film.finish() : null
  const file = replayPath(dir, scene.id)
  replay.write(file)
  U.log('shoot', `wrote ${path.relative(dir, file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`)
  return { id: scene.id, offset_tick: scene.offset_tick, duration_ticks: scene.duration_ticks, shots: shotLog, lines: lineLog, late_ticks: lateTicks, wall_seconds: wall, clips }
}

async function shoot (dir, opts = {}) {
  const shootJson = U.readJson(path.join(dir, 'shoot.json'))
  const cfg = { ...server.config(), version: server.MC_VERSION }
  let started = null
  if (!(await server.isUp(cfg.host, cfg.port))) {
    U.log('shoot', `server not running on ${cfg.host}:${cfg.port}; starting it`)
    started = await server.start({ echo: !!opts.verbose })
    U.log('shoot', 'server ready')
  }
  const director = new Director(cfg, { verbose: opts.verbose })
  await director.connect()
  await director.baseline(shootJson.world)
  const ctx = { director, cfg, dir, world: shootJson.world, builtSets: new Set(), replayDir: path.join(dir, 'replay') }
  // --film: the real Minecraft client records each scene as it is acted (lib/capture)
  const capture = opts.film ? require('../capture/client') : null
  if (capture) {
    const { Film } = require('../capture/film')
    ctx.timeline = U.readJson(path.join(dir, 'timeline.json'))
    const size = { width: opts.width || 1920, height: opts.height || 1080 }
    await capture.start({ ...size, host: cfg.host, port: cfg.port })
    await capture.waitJoined(director)
    ctx.film = new Film({ director, dir, fps: opts.fps || ctx.timeline.fps || 30, ...size })
  }
  const results = []
  try {
    const scenes = shootJson.scenes.filter(s => !opts.scene || opts.scene === s.id || (Array.isArray(opts.scene) && opts.scene.includes(s.id)))
    if (!scenes.length) throw new Error(`no scenes match ${opts.scene}`)
    for (const sc of scenes) results.push(await shootScene(ctx, sc, opts))
  } finally {
    if (capture) await capture.stop()
    await director.disconnect()
    if (started && !opts.keepServer) { U.log('shoot', 'stopping server'); await started.stop() }
  }
  // merge into shoot_log.json and timeline.json
  const logFile = path.join(dir, 'shoot_log.json')
  const log = U.exists(logFile) ? U.readJson(logFile) : { scenes: {} }
  for (const r of results) log.scenes[r.id] = { ...r, recorded: new Date().toISOString() }
  U.writeJson(logFile, log)
  const tlFile = path.join(dir, 'timeline.json')
  if (U.exists(tlFile)) {
    const tl = U.readJson(tlFile)
    for (const r of results) {
      for (const s of r.shots) {
        const g = tl.shots.find(x => x.scene_id === r.id && x.local_id === s.id)
        if (g) { g.actual_start_tick = r.offset_tick + s.actual_start_tick; g.actual_end_tick = r.offset_tick + s.actual_end_tick; g.replay = path.relative(dir, replayPath(dir, r.id)) }
      }
      for (const l of r.lines) {
        const g = tl.lines.find(x => x.scene_id === r.id && x.local_id === l.id)
        if (g) g.actual_tick = r.offset_tick + l.actual_tick
      }
      for (const k of r.clips || []) {
        const c = tl.cuts.find(x => x.shot_id === k.cut.shot_id && x.start_tick === k.cut.start_tick)
        if (c) { c.clip = k.clip; c.frames = k.frames; c.fps = opts.fps || tl.fps; c.source = 'client' }
        const sh = tl.shots.find(x => x.id === k.cut.shot_id)
        if (sh) sh.clip = k.clip
      }
    }
    U.writeJson(tlFile, tl)
  }
  return results
}

module.exports = { shoot, shootScene, groundAt }
