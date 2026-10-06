'use strict'
// The two unattended jobs. Each is a straight line of stages; a failure
// throws with the stage name so the daemon can log it and decide on a retry.
//   match: import -> LLM writes doc.json (checked, fixed) -> make -> publish
//   story: pick cast -> LLM outline -> LLM per scene -> validate (fixed) -> make -> publish
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const U = require('../util')
const llm = require('./llm')
const R = require('../match/recording')
const formats = require('../formats')
const gate = require('./gate')

const XVFB = ['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24']

function sh (cfg, argv, logFile, opts = {}) {
  return new Promise((resolve, reject) => {
    const full = cfg.nice ? ['nice', '-n', String(cfg.nice), ...argv] : argv
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const log = fs.createWriteStream(logFile, { flags: 'a' })
    log.write(`\n$ ${full.join(' ')}\n`)
    const child = spawn(full[0], full.slice(1), { cwd: U.ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } })
    let out = ''
    child.stdout.on('data', d => { out += d; log.write(d) })
    child.stderr.on('data', d => { out += d; log.write(d) })
    child.on('error', reject)
    child.on('exit', code => { log.end(); code === 0 ? resolve(out) : reject(new Error(`${argv.slice(0, 4).join(' ')} exited ${code}: ${out.split('\n').filter(l => /error/i.test(l)).slice(-3).join(' | ') || out.slice(-300)}`)) })
  })
}

function stage (name, fn) {
  return fn().catch(e => { e.stage = name; throw e })
}

function voiceArgs (cfg) { return cfg.voice.mock ? ['--mock-voice'] : ['--url', cfg.voice.url] }
function stagedVoiceArgs (cfg) { return cfg.voice.mock ? ['--mock'] : ['--url', cfg.voice.url] }

async function publish (cfg, slug, logFile) {
  if (!cfg.publish) return { skipped: true }
  const args = ['node', 'bin/mcpublish.js', slug]
  if (cfg.privacy) args.push('--privacy', cfg.privacy)
  let out
  try {
    out = await sh({ nice: 0 }, args, logFile)
  } catch (e) {
    // The film is finished and checked; only the upload did not go through (YouTube's daily
    // upload limit, a network blip). Leave a note so the loop tries the upload again later
    // instead of the film sitting there forever.
    const dir = U.projectDir(slug)
    if (U.exists(path.join(dir, 'final.mp4'))) {
      const f = path.join(dir, PENDING)
      const prev = U.exists(f) ? U.readJson(f) : { first_failed: new Date().toISOString(), tries: 0 }
      U.writeJson(f, { ...prev, tries: prev.tries + 1, last_tried: new Date().toISOString(), error: (String(e.message).match(/"message": "([^"]+)"/) || [null, String(e.message).slice(0, 300)])[1] })
    }
    throw e
  }
  try { fs.unlinkSync(path.join(U.projectDir(slug), PENDING)) } catch { /* was not pending */ }
  try { return JSON.parse(out.slice(out.indexOf('{'))) } catch { return { raw: out.slice(-300) } }
}

// Finished films whose upload failed. Each is tried again every cfg.upload_retry_minutes
// until it goes up; then it is cleaned up like any other published film.
const PENDING = 'upload_pending.json'
function pendingUploads () {
  const root = path.join(U.ROOT, 'projects')
  return fs.readdirSync(root).filter(slug => U.exists(path.join(root, slug, PENDING)) && U.exists(path.join(root, slug, 'final.mp4')))
    .map(slug => ({ slug, ...U.readJson(path.join(root, slug, PENDING)) }))
}

async function retryUploads (cfg, log = () => {}) {
  const done = []
  if (!cfg.publish) return done
  const every = (cfg.upload_retry_minutes || 45) * 60000
  for (const p of pendingUploads()) {
    if (Date.now() - Date.parse(p.last_tried || 0) < every) continue
    const logFile = path.join(U.ROOT, 'automation', 'logs', `upload-${p.slug}.log`)
    try {
      const pub = await publish(cfg, p.slug, logFile)
      if (pub && pub.url) {
        log(`upload of ${p.slug} went through on retry ${p.tries}: ${pub.url}`)
        done.push({ kind: p.slug.startsWith('match-') ? 'match' : 'story', id: p.slug, slug: p.slug, title: pub.title, url: pub.url, published: true, ok: true, cleaned: cleanup(cfg, p.slug, pub, log), note: 'uploaded on a later try' })
      }
    } catch (e) {
      log(`upload of ${p.slug} still failing (try ${p.tries + 1}): ${String(e.message).split('\n').find(l => /message|error/i.test(l)) || e.message.slice(0, 160)}`)
    }
  }
  return done
}

// Instagram and TikTok chores, about every half hour: retry a post that failed, keep the
// Instagram token alive, clear hosted clips nobody needs (lib/publish/social.js). Run as its
// own process so it always uses the code on disk; never allowed to disturb the loop.
let lastSocialTick = 0
async function socialTick (cfg, log = () => {}) {
  if (!cfg.publish || Date.now() - lastSocialTick < 30 * 60000) return
  lastSocialTick = Date.now()
  if (!U.exists(path.join(U.ROOT, 'config', 'publish.json'))) return
  const pub = U.readJson(path.join(U.ROOT, 'config', 'publish.json'))
  if (!require('../publish/social').enabled(pub).length) return
  try { await sh({ nice: 0 }, ['node', 'bin/mcpublish.js', 'social', 'tick'], path.join(U.ROOT, 'automation', 'logs', 'social.log')) } catch (e) { log('social chores failed: ' + String(e.message).slice(0, 160)) }
}

// After an upload nothing made for the film is kept: the project folder goes (replays,
// clips, voice lines, the rendered file). The record of what was published lives in
// automation/state.json. A film that was not uploaded is left alone.
function cleanup (cfg, slug, pub, log) {
  if (!cfg.cleanup_after_publish || !pub || !pub.url) return false
  const dir = U.projectDir(slug)
  if (!dir.startsWith(path.join(U.ROOT, 'projects') + path.sep)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  log(`uploaded and cleaned up: projects/${slug} deleted`)
  return true
}

// ---------------------------------------------------------------- match
// A film's recording is deleted once the film is made, and its project once it is uploaded.
// So that the newest matches can still be re-filmed, tested on or handed to someone, a copy of
// each recording (and the plan written for it) is kept in keep/matches/<id>/, the last
// `keep_recordings` of them (0 = keep none). Never allowed to fail a job.
function keepCopy (cfg, recording, docFile, log = () => {}) {
  const n = cfg.keep_recordings === undefined ? 3 : cfg.keep_recordings
  if (!(n > 0)) return
  try {
    const root = path.join(U.ROOT, 'keep', 'matches')
    const dst = path.join(root, recording.id)
    if (!U.exists(path.join(dst, 'recording', 'meta.json'))) {
      fs.mkdirSync(dst, { recursive: true })
      fs.cpSync(recording.dir, path.join(dst, 'recording'), { recursive: true })
      log(`kept a copy of recording ${recording.id} in keep/matches/`)
    }
    if (docFile && U.exists(docFile)) fs.copyFileSync(docFile, path.join(dst, 'doc.json'))
    const all = fs.readdirSync(root).filter(d => U.exists(path.join(root, d, 'recording', 'meta.json'))).sort()
    for (const old of all.slice(0, Math.max(0, all.length - n))) fs.rmSync(path.join(root, old), { recursive: true, force: true })
  } catch (e) { log(`could not keep a copy of recording ${recording.id}: ${e.message}`) }
}

async function matchJob (cfg, recording, logFile, log = () => {}) {
  const slug = 'match-' + recording.id
  const dir = U.projectDir(slug)
  const fmt = formats.forMatch(recording.seconds, recording.players, { shortMinutes: cfg.short_match_minutes, longMinPlayers: cfg.long_min_players, preferred: cfg.match_format })
  await stage('import', () => sh({ nice: 0 }, ['node', 'bin/mcmatch.js', 'import', recording.dir, slug, '--format', fmt.id], logFile))
  keepCopy(cfg, recording, null, log)
  await stage('plan', async () => {
    let errors = ''
    for (let round = 0; round <= cfg.llm.fix_rounds; round++) {
      const prompt = round === 0
        ? llm.fill('match_plan.md', { slug, format: fmt.id, format_label: fmt.label, min_sec: fmt.min_sec, max_sec: fmt.max_sec })
        : llm.fill('fix.md', { slug, file: `projects/${slug}/doc.json`, guide: 'prompts/match.md', errors })
      await llm.run(cfg, prompt, logFile)
      if (!U.exists(path.join(dir, 'doc.json'))) { errors = 'doc.json was not written'; continue }
      let report
      try { report = require('../match/build').check(U.readJson(path.join(dir, 'doc.json')), R.load(recording.dir), fmt.id) } catch (e) { errors = 'doc.json is not valid JSON or could not be checked: ' + e.message; continue }
      const lengthWarn = report.warnings.filter(w => /film runs/.test(w))
      if (!report.errors.length && !lengthWarn.length) return
      errors = [...report.errors, ...lengthWarn].join('\n')
      if (!report.errors.length && round >= 1) return // length is a preference after one retry
    }
    throw new Error('doc.json still has errors: ' + errors)
  })
  keepCopy(cfg, recording, path.join(dir, 'doc.json'), log)
  // any time: cut the replays (light) and speak the lines (GPU)
  await stage('build', () => sh({ nice: 0 }, ['node', 'bin/mcmatch.js', 'build', slug], logFile))
  await stage('voice', () => sh({ nice: 0 }, ['node', 'bin/mcmatch.js', 'voice', slug, ...voiceArgs(cfg)], logFile))
  // lobby only: render and export; frozen if a match starts, finished regardless if none does
  // with the studio set up the match is re-played live for the real client: a take cannot be frozen half way
  const liveTake = require('../studio/server').available() && require('../capture/client').available()
  await stage('render', () => gate.runHeavy(cfg, [...XVFB, 'node', 'bin/mcmatch.js', 'finish', slug], logFile, log, liveTake ? { pausable: false } : {}))
  const pub = await stage('publish', () => publish(cfg, slug, logFile))
  const title = pub.title || (U.exists(path.join(dir, 'doc.json')) ? U.readJson(path.join(dir, 'doc.json')).title : slug)
  const cleaned = cleanup(cfg, slug, pub, log)
  return { slug, format: fmt.id, title, url: pub.url || null, published: !!pub.url, cleaned }
}

// ---------------------------------------------------------------- story
function pick (arr, n, rand = Math.random) {
  const pool = arr.slice(); const out = []
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  return out
}

function kitNames () {
  const f = path.join(U.ROOT, 'prompts', 'reference', 'kits.md')
  if (!U.exists(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('### ')).map(l => l.slice(4).trim())
}

// People who have actually played, most recent first, that we have a skin for.
function castPool (cfg) {
  const roster = require('../skins').readRoster().players
  const have = new Map(roster.map(p => [p.name.toLowerCase(), p]))
  const prefsLib = require('../prefs'); const prefs = prefsLib.read()
  for (const p of roster) if (prefsLib.isBlocked(p.name, p.uuid, prefs)) have.delete(p.name.toLowerCase()) // /movie block
  let recent = []
  try {
    const stats = U.readJson(cfg.stats_file).players || {}
    recent = Object.entries(stats).filter(([uuid, p]) => p.name && !p.name.startsWith('.') && have.has(p.name.toLowerCase()) && !prefsLib.isBlocked(p.name, uuid, prefs)).map(([, p]) => p).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).map(p => ({ name: have.get(p.name.toLowerCase()).name, games: p.games || 0, wins: p.wins || 0, kills: p.kills || 0, favourite_kit: Object.entries(p.kits || {}).sort((a, b) => (b[1].games || b[1] || 0) - (a[1].games || a[1] || 0)).map(e => e[0])[0] || null }))
  } catch { /* no stats: fall back to the skin roster */ }
  if (!recent.length) recent = roster.filter(p => have.has(p.name.toLowerCase())).map(p => ({ name: p.name, games: 0, wins: 0, kills: 0, favourite_kit: null }))
  return recent
}

// The set world is scenery, not an archive: once a story is shot its props would only
// litter some later story's backdrop. The seed is fixed, so the same land grows back.
function wipeSetWorld (log) {
  const server = require('../mc/server')
  const cfg = server.config()
  if (cfg.terrain !== 'normal') return
  const world = path.join(server.SERVER_DIR, 'set_terrain')
  if (U.exists(path.join(server.SERVER_DIR, 'server.pid')) || !U.exists(world)) return
  fs.rmSync(world, { recursive: true, force: true })
  log('set world wiped (regenerates from its seed)')
}

async function storyJob (cfg, logFile, log = () => {}) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const slug = 'story-' + stamp
  const dir = U.projectDir(slug)
  const fmt = formats.get(cfg.idle_story_format)
  const pool = castPool(cfg)
  if (pool.length < 2) throw Object.assign(new Error('fewer than two players with skins to cast'), { stage: 'cast' })
  const stars = pick(pool.slice(0, 16), 2 + Math.floor(Math.random() * 2))
  const kits = pick(kitNames(), stars.length)
  const genre = pick(cfg.genres, 1)[0]
  const brief = [
    `Make ${genre} for the hardcorepvp community.`,
    `Format: ${fmt.id} (${fmt.label}).`,
    `Cast these real players as the characters, using their exact usernames as character ids and skins:`,
    ...stars.map((s, i) => `- ${s.name}: kit ${kits[i] || s.favourite_kit || 'none'}${s.wins ? `, ${s.wins} lifetime wins` : ''}${s.kills ? `, ${s.kills} lifetime kills` : ''}`),
    'You may swap a kit for one that makes the situation work (see prompts/reference/kits.md); the kit must cause the turn.',
    'It needs a point a viewer could repeat in one sentence, with a clear outcome on screen, told by the narrator like a match film.',
    'Keep it kind: these are real people who will watch it. Losing a fight is fine; being humiliated is not.'
  ].join('\n')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'prompt.txt'), brief + '\n')
  formats.writeProject(dir, fmt.id, 'idle story')
  // a real piece of land to shoot on (starts the set server, so it waits for the lobby)
  await stage('scout', () => gate.runHeavy(cfg, ['node', 'bin/mcmovie.js', 'terrain:pick', slug], logFile, log, { pausable: false }))
  const terrain = U.readJson(path.join(dir, 'terrain.json'))

  const V = require('../validate')
  const outlineProblems = () => {
      const problems = []
      for (const f of ['story.json', 'world.json', 'cast.json']) if (!U.exists(path.join(dir, f))) problems.push(`${f} was not written`)
      if (!problems.length) {
        try {
          const story = U.readJson(path.join(dir, 'story.json'))
          problems.push(...V.checkStory(story).errors, ...V.checkWorld(U.readJson(path.join(dir, 'world.json')), story).errors, ...V.checkCast(U.readJson(path.join(dir, 'cast.json')), story).errors)
          if (story.format !== fmt.id) problems.push(`story.json "format" must be "${fmt.id}"`)
          for (const k of ['point', 'premise', 'turn', 'final_image', 'feeling']) if (!String(story[k] || '').trim()) problems.push(`story.json needs a non-empty "${k}" (see "The story comes first" in prompts/outline.md)`)
          const world = U.readJson(path.join(dir, 'world.json'))
          if ((world.sets || []).length !== 1) problems.push('world.json must have exactly one set (the stage in terrain.json)')
          else {
            const set = world.sets[0]
            if (Math.abs(set.origin[0] - terrain.origin[0]) > 4 || Math.abs(set.origin[2] - terrain.origin[2]) > 4) problems.push(`the set's origin must be terrain.json's origin ${JSON.stringify(terrain.origin)}`)
            if (world.ground_y !== terrain.ground_y) problems.push(`world.json "ground_y" must be ${terrain.ground_y} (terrain.json)`)
            const far = (set.ops || []).filter(op => ['fill', 'floor', 'box', 'clear', 'line'].includes(op.type) && op.from && op.to && (Math.abs(op.to[0] - op.from[0]) > 14 || Math.abs(op.to[2] - op.from[2]) > 14))
            if (far.length) problems.push('the set paves or covers too much ground; build only small props (nothing wider than 14 blocks)')
          }
        } catch (e) { problems.push('invalid JSON: ' + e.message) }
      }
      return problems
  }
  const outlineRounds = async (first, what) => {
    let errors = ''
    for (let round = 0; round <= cfg.llm.fix_rounds; round++) {
      const prompt = round === 0
        ? first
        : llm.fill('fix.md', { slug, file: `projects/${slug}/story.json, world.json and cast.json`, guide: 'prompts/outline.md and prompts/casting.md', errors })
      await llm.run(cfg, prompt, logFile)
      const problems = outlineProblems()
      if (!problems.length) return
      errors = problems.join('\n')
    }
    throw new Error(`${what} still has errors: ` + errors)
  }
  await stage('outline', () => outlineRounds(llm.fill('story_outline.md', { slug, format: fmt.id, format_label: fmt.label, max_sec: fmt.max_sec, min_sec: fmt.min_sec }), 'outline'))
  // a second pair of eyes: an editor that reads the outline cold and rewrites it if it has no point
  await stage('review', () => outlineRounds(llm.fill('story_review.md', { slug }), 'reviewed outline'))
  const story = U.readJson(path.join(dir, 'story.json'))
  await stage('scenes', async () => {
    // one focused LLM context per scene, in parallel
    await Promise.all(story.scenes.map(sc => llm.run(cfg, llm.fill('story_scene.md', { slug, scene: sc.id, format: fmt.id }), logFile.replace(/\.log$/, `.${sc.id}.log`))))
    for (let round = 0; round < cfg.llm.fix_rounds; round++) {
      const r = V.validateProject(dir)
      const bad = Object.entries(r.reports).filter(([k, v]) => k.startsWith('scene_') && v.errors.length)
      if (!bad.length) return
      await Promise.all(bad.map(([k, v]) => llm.run(cfg, llm.fill('fix.md', { slug, file: `projects/${slug}/${k}.json`, guide: 'prompts/scene.md', errors: v.errors.join('\n') }), logFile.replace(/\.log$/, `.${k}.log`))))
    }
    const r = V.validateProject(dir)
    if (!r.ok) throw new Error('plan still has errors: ' + Object.entries(r.reports).filter(([, v]) => v.errors.length).map(([k, v]) => `${k}: ${v.errors[0]}`).join('; '))
  })
  // any time: timeline and voices. Lobby only: the bot shoot (started in a lobby, never
  // frozen mid-take), then render and export (frozen while a match is live).
  await stage('timeline', () => sh({ nice: 0 }, ['node', 'bin/mcmovie.js', 'timeline', slug], logFile))
  await stage('voice', () => sh({ nice: 0 }, ['node', 'bin/mcmovie.js', 'voice', slug, ...stagedVoiceArgs(cfg)], logFile))
  await stage('shoot', () => gate.runHeavy(cfg, ['node', 'bin/mcmovie.js', 'shoot', slug], logFile, log, { pausable: false }))
  await stage('render', () => gate.runHeavy(cfg, [...XVFB, 'node', 'bin/mcmovie.js', 'render', slug], logFile, log))
  await stage('assemble', () => gate.runHeavy(cfg, ['node', 'bin/mcmovie.js', 'assemble', slug], logFile, log))
  const pub = await stage('publish', () => publish(cfg, slug, logFile))
  const title = pub.title || story.title
  const cleaned = cleanup(cfg, slug, pub, log)
  wipeSetWorld(log)
  return { slug, format: fmt.id, title, url: pub.url || null, published: !!pub.url, cleaned, stars: stars.map(s => s.name), genre }
}

module.exports = { retryUploads, pendingUploads, socialTick, matchJob, storyJob, castPool, kitNames, cleanup, wipeSetWorld }
