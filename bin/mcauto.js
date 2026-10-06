#!/usr/bin/env node
'use strict'
// The unattended loop. One job at a time, never interrupted:
//   - every finished match recording becomes a vertical short by default
//     (match_format can override), uploaded and announced;
//   - if no match has been played for idle_hours, a staged story is made
//     from random recent players and kits, then the idle clock restarts.
// A match that ends while a story is being made simply waits its turn.
// Planning and voices run at any time; shooting, rendering and exporting run
// only while no match is live (lib/auto/gate.js), so a film is usually spoken
// during the next match and exported in the lobby after it. With no next
// match it just finishes.
// Settings: config/auto.json (see lib/auto/config.js for defaults).
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const U = require('../lib/util')
const R = require('../lib/match/recording')
const C = require('../lib/auto/config')
const jobs = require('../lib/auto/jobs')

const AUTO_DIR = path.join(U.ROOT, 'automation')
const STATE = path.join(AUTO_DIR, 'state.json')
const LOCK = path.join(AUTO_DIR, 'daemon.pid')

function loadState () {
  if (U.exists(STATE)) { try { return U.readJson(STATE) } catch { /* start fresh */ } }
  return { started_at: Date.now(), last_match_at: 0, last_story_at: 0, attempts: {}, history: [] }
}
function saveState (s) { s.history = s.history.slice(-200); U.writeJson(STATE, s) }
const log = (msg) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`)

function healthy (url) {
  return new Promise(resolve => {
    const req = http.get(url.replace(/\/$/, '') + '/health', { timeout: 3000 }, res => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

let voiceChild = null
async function ensureVoice (cfg) {
  if (cfg.voice.mock) return
  if (await healthy(cfg.voice.url)) return
  const a = cfg.voice.autostart
  if (!a) throw new Error(`voice server is not answering at ${cfg.voice.url} and autostart is off`)
  log('starting the voice server')
  fs.mkdirSync(AUTO_DIR, { recursive: true })
  const out = fs.openSync(path.join(AUTO_DIR, 'voice_server.log'), 'a')
  voiceChild = spawn(a.command, a.args, { cwd: path.resolve(U.ROOT, a.cwd), env: { ...process.env, ...(a.env || {}) }, stdio: ['ignore', out, out], detached: false })
  for (let i = 0; i < (a.ready_seconds || 240); i += 3) { await U.sleep(3000); if (await healthy(cfg.voice.url)) return }
  throw new Error('voice server did not come up; see automation/voice_server.log')
}

// What to do next: the oldest ready recording, else a story if the idle clock ran out.
function nextJob (cfg, state) {
  const ready = R.list().filter(r => r.ready && (state.attempts[r.id] || 0) < cfg.max_attempts)
  if (ready.length) return { kind: 'match', recording: ready[0] }
  if (!cfg.idle_stories) return null
  const lastActivity = Math.max(state.started_at, state.last_match_at, state.last_story_at)
  if (Date.now() - lastActivity >= cfg.idle_hours * 3600 * 1000) return { kind: 'story' }
  return null
}

async function runJob (cfg, state, job) {
  const id = job.kind === 'match' ? job.recording.id : 'story-' + Date.now()
  const logFile = path.join(AUTO_DIR, 'logs', `${job.kind}-${job.kind === 'match' ? id : new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}.log`)
  const entry = { kind: job.kind, id, started: new Date().toISOString() }
  log(`${job.kind} job ${id} started (log: ${path.relative(U.ROOT, logFile)})`)
  try {
    await ensureVoice(cfg)
    if (job.kind === 'match') {
      state.attempts[id] = (state.attempts[id] || 0) + 1
      // the idle clock counts from when the match was played, not when it was filmed
      const meta = R.readMeta(job.recording.dir)
      state.last_match_at = Math.max(state.last_match_at, (meta && meta.ended_ms) || Date.now())
      saveState(state)
      Object.assign(entry, await jobs.matchJob(cfg, job.recording, logFile, log))
    } else {
      state.last_story_at = Date.now() // restart the idle clock whether or not the story works out
      saveState(state)
      Object.assign(entry, await jobs.storyJob(cfg, logFile, log))
    }
    entry.ok = true
    log(`${job.kind} job ${id} done: ${entry.url || 'final.mp4 in projects/' + entry.slug}${entry.published ? '' : ' (not published)'}`)
  } catch (e) {
    entry.ok = false; entry.stage = e.stage || 'setup'; entry.error = e.message.slice(0, 600)
    log(`${job.kind} job ${id} FAILED at ${entry.stage}: ${entry.error}`)
    if (job.kind === 'match' && state.attempts[id] >= cfg.max_attempts) {
      // out of tries: free the disk rather than keep a recording nobody will film
      try { R.remove(job.recording.dir); log(`recording ${id} deleted after ${cfg.max_attempts} failed attempts`) } catch { /* already gone */ }
    }
  }
  entry.finished = new Date().toISOString()
  state.history.push(entry)
  saveState(state)
}

async function status () {
  const cfg = C.load(); const state = loadState()
  const last = Math.max(state.started_at, state.last_match_at, state.last_story_at)
  const due = last + cfg.idle_hours * 3600 * 1000
  console.log(`recordings waiting: ${R.list().filter(r => r.ready).map(r => r.id).join(', ') || 'none'}`)
  console.log(cfg.idle_stories ? `idle story due: ${new Date(due).toLocaleString()} (${Math.max(0, (due - Date.now()) / 3600000).toFixed(1)} h)` : 'idle stories: off (matches only)')
  for (const p of jobs.pendingUploads()) console.log(`waiting to upload: ${p.slug} (tried ${p.tries}x, last ${p.last_tried}; ${/uploadLimitExceeded|exceeded the number of videos/.test(String(p.error)) ? 'YouTube upload limit' : 'upload failed'})`)
  console.log(`publishing: ${cfg.publish ? 'on' : 'off'}   voice: ${cfg.voice.mock ? 'mock' : cfg.voice.url}   llm: ${cfg.llm.command}`)
  const st = await require('../lib/auto/gate').gameState(cfg)
  console.log(`game server: ${st || 'not reachable'}${st && cfg.gate.live_states.includes(st) ? ' (live: heavy work would wait)' : ' (shoot/render/export may run)'}`)
  for (const h of state.history.slice(-8)) console.log(`${h.finished || h.started}  ${h.kind.padEnd(5)} ${h.ok ? 'ok    ' : 'FAILED'} ${h.slug || h.id} ${h.url || h.error || ''}`)
}

async function main () {
  const cmd = process.argv[2] || 'run'
  if (cmd === 'help' || cmd === '--help') {
    console.log('mcauto run [--story-first]   the loop (keep it in tmux); --story-first makes a story before anything else\nmcauto once       run one pending job, if any, then exit\nmcauto story      make one idle story now, then exit\nmcauto status     what is waiting, when the idle story is due, recent jobs')
    return
  }
  if (cmd === 'status') return status()
  fs.mkdirSync(AUTO_DIR, { recursive: true })
  if (U.exists(LOCK)) {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10)
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* stale lock */ }
    if (alive) throw new Error(`mcauto is already running (pid ${pid})`)
  }
  fs.writeFileSync(LOCK, String(process.pid))
  const cleanup = () => { try { fs.unlinkSync(LOCK) } catch {} if (voiceChild) { try { voiceChild.kill() } catch {} } }
  process.on('exit', cleanup)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  const state = loadState()
  // old logs are not kept forever
  try { for (const f of fs.readdirSync(path.join(AUTO_DIR, 'logs'))) { const p = path.join(AUTO_DIR, 'logs', f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400000) fs.unlinkSync(p) } } catch { /* no logs yet */ }
  // --no-publish: make the film and keep it, upload nothing (for looking at a result first)
  const loadCfg = () => { const c = C.load(); if (process.argv.includes('--no-publish')) c.publish = false; return c }
  if (cmd === 'story') { await runJob(loadCfg(), state, { kind: 'story' }); return }
  if (cmd === 'once') { const cfg = loadCfg(); const job = nextJob(cfg, state); if (job) await runJob(cfg, state, job); else log('nothing to do'); return }
  log('mcauto running; one job at a time')
  let storyFirst = process.argv.includes('--story-first')
  if (storyFirst) log('starting with a story')
  while (true) {
    const cfg = C.load() // re-read so settings can change without a restart
    // finished films whose upload failed earlier (YouTube's daily limit, a network blip)
    for (const h of await jobs.retryUploads(cfg, log)) { h.started = h.finished = new Date().toISOString(); state.history.push(h); saveState(state) }
    const job = storyFirst ? { kind: 'story' } : nextJob(cfg, state)
    storyFirst = false
    if (job) await runJob(cfg, state, job)
    else await U.sleep(cfg.poll_seconds * 1000)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('error: ' + e.message); process.exit(1) })
