'use strict'
// Keeps heavy work out of live matches. The GPU and the LLM do not compete
// with the game server, so planning and voices run whenever. Shooting,
// rendering and encoding eat CPU, so they start only while no match is live,
// and a render or encode that is still going when a match starts is frozen
// (SIGSTOP on its whole process group) and thawed in the next lobby. If no
// match ever starts, nothing waits: the film just finishes and uploads.
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const U = require('../util')

function gameState (cfg) {
  return new Promise(resolve => {
    if (!cfg.gate || !cfg.gate.enabled) return resolve(null)
    const req = http.get(cfg.gate.status_url, { timeout: 3000 }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString()).state || null) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null)) // server down or restarting: nobody is playing
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

async function isLive (cfg) {
  const state = await gameState(cfg)
  return !!state && cfg.gate.live_states.includes(state)
}

async function waitForLobby (cfg, log) {
  let told = false
  while (await isLive(cfg)) {
    if (!told) { log('a match is live; heavy work waits for the lobby'); told = true }
    await U.sleep(cfg.gate.poll_seconds * 1000)
  }
  if (told) log('lobby again; continuing')
}

// Run a CPU-heavy command, frozen while a match is live. opts.pausable=false
// only gates the start (used for the bot shoot, which cannot be frozen mid-take).
async function runHeavy (cfg, argv, logFile, log, opts = {}) {
  await waitForLobby(cfg, log)
  const full = cfg.nice ? ['nice', '-n', String(cfg.nice), ...argv] : argv
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const out = fs.createWriteStream(logFile, { flags: 'a' })
  out.write(`\n$ ${full.join(' ')}\n`)
  return new Promise((resolve, reject) => {
    const child = spawn(full[0], full.slice(1), { cwd: U.ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true })
    let text = ''
    child.stdout.on('data', d => { text += d; out.write(d) })
    child.stderr.on('data', d => { text += d; out.write(d) })
    let paused = false; let done = false
    const signal = (sig) => { try { process.kill(-child.pid, sig) } catch { /* already gone */ } }
    const watch = async () => {
      while (!done) {
        await U.sleep(cfg.gate.poll_seconds * 1000)
        if (done || opts.pausable === false || !cfg.gate.enabled) continue
        const live = await isLive(cfg)
        if (live && !paused) { signal('SIGSTOP'); paused = true; log('match went live; render paused') } else if (!live && paused) { signal('SIGCONT'); paused = false; log('lobby again; render resumed') }
      }
    }
    watch()
    const stop = () => { signal('SIGCONT'); signal('SIGTERM') }
    process.once('exit', stop)
    child.on('error', e => { done = true; reject(e) })
    child.on('exit', code => {
      done = true; out.end(); process.removeListener('exit', stop)
      code === 0 ? resolve(text) : reject(new Error(`${argv.slice(0, 5).join(' ')} exited ${code}: ${text.split('\n').filter(l => /error/i.test(l)).slice(-3).join(' | ') || text.slice(-300)}`))
    })
  })
}

module.exports = { gameState, isLive, waitForLobby, runHeavy }
