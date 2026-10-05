'use strict'
// Schema validation plus the self-checks every scene agent must pass:
// lines covered by shots, no two actors in one block at one tick, speeds
// achievable, duration near target, references resolve.
const path = require('path')
const Ajv = require('ajv')
const U = require('./util')
const S = require('./speeds')
const { buildTracks } = require('./motion')
const { referencedActors, CameraPath } = require('./camera')
const copy = require('./publish/copy')

const ajv = new Ajv({ allErrors: true, strict: false })
const schemas = {
  story: require('./schemas/story.schema.json'),
  world: require('./schemas/world.schema.json'),
  scene: require('./schemas/scene.schema.json'),
  cast: require('./schemas/cast.schema.json')
}
const validators = Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, ajv.compile(v)]))

function schemaErrors (kind, obj) {
  const v = validators[kind]
  if (v(obj)) return []
  return v.errors.map(e => `${e.instancePath || '/'} ${e.message}${e.params && e.params.allowedValues ? ' (' + e.params.allowedValues.join('|') + ')' : ''}`)
}

let _kitRules = null
function kitRules () {
  if (_kitRules) return _kitRules
  const f = path.join(U.ROOT, 'config', 'kit_rules.json')
  try { _kitRules = U.exists(f) ? U.readJson(f) : {} } catch { _kitRules = {} }
  return _kitRules
}

function sceneDuration (scene) {
  let d = scene.duration_ticks || 0
  for (const s of scene.shots || []) d = Math.max(d, s.end_tick)
  for (const k of scene.keyframes || []) d = Math.max(d, k.tick)
  for (const l of scene.lines || []) d = Math.max(d, l.tick + S.estimateLineTicks(l.text))
  return d
}

function checkStory (story) {
  const errors = schemaErrors('story', story)
  const warnings = []
  const ids = new Set()
  for (const c of story.characters || []) {
    if (ids.has(c.id)) errors.push(`duplicate character id ${c.id}`)
    ids.add(c.id)
  }
  const sids = new Set()
  for (const sc of story.scenes || []) {
    if (sids.has(sc.id)) errors.push(`duplicate scene id ${sc.id}`)
    sids.add(sc.id)
    for (const c of sc.characters || []) if (!ids.has(c)) errors.push(`scene ${sc.id} references unknown character ${c}`)
  }
  const total = (story.scenes || []).reduce((a, s) => a + (s.target_seconds || 0), 0)
  if (total > 600) warnings.push(`total target ${total}s is long; shoots scale linearly with duration`)
  if (story.format === 'short' && total > 90) errors.push(`a short must total 35-90 seconds; scenes add up to ${total}s`)
  errors.push(...copy.problems(story.title, story.logline))
  return { errors, warnings }
}

function checkWorld (world, story) {
  const errors = schemaErrors('world', world)
  const warnings = []
  const setIds = new Set((world.sets || []).map(s => s.id))
  for (const sc of (story && story.scenes) || []) {
    if (!setIds.has(sc.location)) errors.push(`scene ${sc.id} location "${sc.location}" is not a set id in world.json`)
  }
  for (const set of world.sets || []) {
    for (const op of set.ops || []) {
      if (op.type === 'fill' && op.from && op.to) {
        const vol = Math.abs(op.to[0] - op.from[0] + 1) * Math.abs(op.to[1] - op.from[1] + 1) * Math.abs(op.to[2] - op.from[2] + 1)
        if (vol > 200000) warnings.push(`set ${set.id}: fill of ${vol} blocks is very large`)
      }
    }
  }
  return { errors, warnings }
}

function checkScene (scene, story, storyScene) {
  const errors = schemaErrors('scene', scene)
  const warnings = []
  if (errors.length) return { errors, warnings }
  const charIds = new Set((story && story.characters || []).map(c => c.id))
  const groupIds = new Set((story && story.characters || []).filter(c => c.group).map(c => c.id))
  const inScene = new Set((storyScene && storyScene.characters) || [])
  const duration = sceneDuration(scene)

  // ids unique
  for (const key of ['lines', 'shots', 'beats']) {
    const seen = new Set()
    for (const it of scene[key] || []) {
      if (seen.has(it.id)) errors.push(`${key}: duplicate id ${it.id}`)
      seen.add(it.id)
    }
  }

  // actors
  const actorIds = [...new Set((scene.keyframes || []).map(k => k.actor))]
  for (const a of actorIds) {
    if (charIds.size && !charIds.has(a)) errors.push(`keyframes reference unknown character ${a}`)
    if (inScene.size && !inScene.has(a)) warnings.push(`actor ${a} has keyframes but is not listed in the story's scene character list`)
    if (!/^[A-Za-z0-9_]{1,16}$/.test(a)) errors.push(`actor id ${a} is not a valid Minecraft username`)
  }
  let tracks, ctx
  try { ({ tracks, ctx } = buildTracks(scene)) } catch (e) { errors.push(e.message); return { errors, warnings } }

  // speed check per segment
  for (const [id, tr] of Object.entries(tracks)) {
    for (let i = 0; i < tr.kf.length - 1; i++) {
      const a = tr.kf[i]; const b = tr.kf[i + 1]
      if (b.tick === a.tick) {
        if (U.dist(a, b) > 0.01) errors.push(`${id}: two keyframes at tick ${a.tick} with different positions`)
        continue
      }
      const d = U.distXZ(a, b)
      const have = b.tick - a.tick
      // a knockback flies exactly as far as the server's knockback settings send it
      if (String(a.anim || '').split(':')[0] === 'knockback') {
        const level = parseFloat(String(a.anim).split(':')[1]) || 0
        // some kits cannot be knocked back at all (config/kit_rules.json, from the plugin's code)
        const ch = ((story && story.characters) || []).find(c => c.id === id)
        const rule = ch && ch.kit ? kitRules()[String(ch.kit).toLowerCase()] : null
        const before = i > 0 ? tr.kf[i - 1]._mode : 'idle'
        if (rule && (rule.no_knockback === 'always' || (rule.no_knockback === 'sneaking' && (before === 'sneak' || before === 'crouch')))) {
          errors.push(`${id}: knockback at tick ${a.tick}, but a ${ch.kit}${rule.no_knockback === 'sneaking' ? ' who is crouching' : ''} takes no knockback (prompts/reference/kit_staging.md)`)
          continue
        }
        const real = S.knockbackPath(level, b.y - a.y)
        if (d < real.distance * 0.7 || d > real.distance * 1.3) errors.push(`${id}: knockback:${level} at tick ${a.tick} lands ${d.toFixed(1)} blocks away; in the game it carries ${real.distance.toFixed(1)} blocks (put the next keyframe that far, straight away from the attacker)`)
        if (have < real.ticks) errors.push(`${id}: knockback:${level} at tick ${a.tick} needs ${real.ticks} ticks to land; the next keyframe is ${have} ticks later`)
        continue
      }
      const need = S.ticksForMove(d, a._mode)
      if (a._mode !== 'fly' && a._mode !== 'idle' && d > 0.01 && have < need * 0.9) {
        errors.push(`${id}: ${a._mode} from tick ${a.tick} to ${b.tick} covers ${d.toFixed(1)} blocks in ${have} ticks; needs >= ${need} ticks at ${S.speedFor(a._mode)} b/s`)
      }
      if (a._mode === 'idle' && d > 0.01) warnings.push(`${id}: moves ${d.toFixed(1)} blocks between ticks ${a.tick}-${b.tick} with anim idle (will slide); use walk/sprint/sneak`)
      if (a._mode === 'fly' && have > 0 && d / have * 20 > 40) warnings.push(`${id}: fly segment ${a.tick}-${b.tick} is very fast (${(d / have * 20).toFixed(0)} b/s)`)
    }
    if (tr.firstTick > 0) warnings.push(`${id}: first keyframe at tick ${tr.firstTick}; actor is spawned there (fine if intended)`)
  }

  // collisions: sample every 2 ticks
  const ids = Object.keys(tracks)
  const reported = new Set()
  for (let t = 0; t <= duration; t += 2) {
    const st = ids.map(id => [id, tracks[id].stateAt(t, ctx)])
    for (let i = 0; i < st.length; i++) {
      for (let j = i + 1; j < st.length; j++) {
        const [ia, a] = st[i]; const [ib, b] = st[j]
        if (!a.present || !b.present) continue
        const key = ia + '|' + ib
        if (U.distXZ(a, b) < 0.6 && Math.abs(a.y - b.y) < 1.8 && !reported.has(key)) {
          errors.push(`${ia} and ${ib} occupy the same space around tick ${t} (${a.x.toFixed(1)},${a.z.toFixed(1)})`)
          reported.add(key)
        }
      }
    }
  }

  // lines
  const shots = (scene.shots || []).slice().sort((a, b) => a.start_tick - b.start_tick)
  const lines = (scene.lines || []).slice().sort((a, b) => a.tick - b.tick)
  for (const l of lines) {
    const est = S.estimateLineTicks(l.text)
    if (charIds.size && !charIds.has(l.character)) errors.push(`line ${l.id}: unknown character ${l.character}`)
    if (!tracks[l.character] && !l.offscreen && !groupIds.has(l.character) && l.character !== 'narrator') {
      errors.push(`line ${l.id}: ${l.character} speaks but has no keyframes in this scene (add keyframes or set "offscreen": true)`)
    }
    const covering = shots.filter(s => s.start_tick <= l.tick && l.tick < s.end_tick)
    if (!covering.length) errors.push(`line ${l.id} at tick ${l.tick} is not covered by any shot`)
    else if (!shots.some(s => s.start_tick <= l.tick && l.tick + est <= s.end_tick) && !shots.some(s => s.start_tick <= l.tick + est && l.tick + est < s.end_tick)) {
      warnings.push(`line ${l.id} probably runs past the last shot (ends ~tick ${l.tick + est})`)
    }
    if (l.tick + est > duration + 10) warnings.push(`line ${l.id} ends ~tick ${l.tick + est}, after the scene ends (${duration}); the last shot will be held`)
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]; const b = lines[i + 1]
    const est = S.estimateLineTicks(a.text)
    if (b.tick < a.tick + est - 4 && !groupIds.has(a.character) && !groupIds.has(b.character)) {
      warnings.push(`line ${b.id} (tick ${b.tick}) starts before ${a.id} probably ends (~tick ${a.tick + est}); they will overlap or be delayed`)
    }
  }

  // shots
  if (!shots.length) errors.push('scene has no shots')
  else {
    if (shots[0].start_tick > 0) errors.push(`first shot ${shots[0].id} starts at tick ${shots[0].start_tick}; a shot must start at tick 0`)
    let covered = 0
    for (const s of shots) {
      if (s.end_tick <= s.start_tick) errors.push(`shot ${s.id}: end_tick must be > start_tick`)
      if (s.start_tick > covered + 1) warnings.push(`no shot covers ticks ${covered}-${s.start_tick} (previous shot will be held)`)
      covered = Math.max(covered, s.end_tick)
      for (const a of referencedActors(s)) if (!tracks[a]) errors.push(`shot ${s.id} references unknown actor ${a}`)
      for (const lid of s.covers_lines || []) if (!lines.find(l => l.id === lid)) warnings.push(`shot ${s.id} claims to cover unknown line ${lid}`)
      try {
        const cp = new CameraPath(s)
        for (const t of [s.start_tick, (s.start_tick + s.end_tick) / 2, s.end_tick]) {
          const pose = cp.evaluate(t, ctx)
          if (![pose.x, pose.y, pose.z, pose.yaw, pose.pitch].every(Number.isFinite)) errors.push(`shot ${s.id}: camera pose is not finite at tick ${t}`)
        }
      } catch (e) { errors.push(`shot ${s.id}: ${e.message}`) }
    }
    if (covered < duration - 10) warnings.push(`shots end at tick ${covered} but the scene runs to ${duration}; the last shot will be held`)
  }

  // world events
  for (const ev of scene.world_events || []) {
    if (ev.tick > duration) warnings.push(`world event at tick ${ev.tick} is after the scene ends`)
  }

  // duration vs target
  if (storyScene && storyScene.target_seconds) {
    const target = storyScene.target_seconds * S.TICK_RATE
    const ratio = duration / target
    if (ratio < 0.6 || ratio > 1.5) warnings.push(`duration ${duration} ticks (${(duration / 20).toFixed(1)}s) is far from target ${storyScene.target_seconds}s`)
  }
  return { errors, warnings, duration }
}

function checkCast (cast, story) {
  const errors = schemaErrors('cast', cast)
  const warnings = []
  for (const c of (story && story.characters) || []) {
    if (!cast.characters || !cast.characters[c.id]) errors.push(`character ${c.id} has no voice in cast.json`)
  }
  return { errors, warnings }
}

// Validate a whole project directory. Returns { ok, reports }.
function validateProject (dir, opts = {}) {
  const reports = {}
  let ok = true
  const storyFile = path.join(dir, 'story.json')
  if (!U.exists(storyFile)) return { ok: false, reports: { story: { errors: ['story.json missing'], warnings: [] } } }
  const story = U.readJson(storyFile)
  reports.story = checkStory(story)
  const worldFile = path.join(dir, 'world.json')
  const world = U.exists(worldFile) ? U.readJson(worldFile) : null
  reports.world = world ? checkWorld(world, story) : { errors: ['world.json missing'], warnings: [] }
  for (const sc of story.scenes || []) {
    const f = path.join(dir, `scene_${sc.id}.json`)
    if (!U.exists(f)) { reports[`scene_${sc.id}`] = { errors: [`scene_${sc.id}.json missing`], warnings: [] }; continue }
    let scene
    try { scene = U.readJson(f) } catch (e) { reports[`scene_${sc.id}`] = { errors: ['invalid JSON: ' + e.message], warnings: [] }; continue }
    if (scene.scene_id !== sc.id) reports[`scene_${sc.id}`] = { errors: [`scene_id "${scene.scene_id}" does not match file (${sc.id})`], warnings: [] }
    else reports[`scene_${sc.id}`] = checkScene(scene, story, sc)
  }
  const castFile = path.join(dir, 'cast.json')
  if (U.exists(castFile)) reports.cast = checkCast(U.readJson(castFile), story)
  else if (!opts.allowMissingCast) reports.cast = { errors: [], warnings: ['cast.json missing (voice stage will use stock voices by character description)'] }
  for (const r of Object.values(reports)) if (r.errors.length) ok = false
  return { ok, reports }
}

function printReports (reports) {
  for (const [name, r] of Object.entries(reports)) {
    const status = r.errors.length ? 'FAIL' : (r.warnings.length ? 'WARN' : 'OK')
    console.log(`${status.padEnd(4)} ${name}${r.duration ? ` (${r.duration} ticks = ${(r.duration / 20).toFixed(1)}s)` : ''}`)
    for (const e of r.errors) console.log(`   error: ${e}`)
    for (const w of r.warnings) console.log(`   warn:  ${w}`)
  }
}

module.exports = { checkStory, checkWorld, checkScene, checkCast, validateProject, printReports, sceneDuration, schemaErrors }
