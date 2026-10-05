'use strict'
// Lobby gating: a heavy command must not start while a match is live, must
// freeze when one starts, and must finish once the lobby returns.
const http = require('http')
const assert = require('assert')
const gate = require('../lib/auto/gate')

let state = 'ACTIVE'
const srv = http.createServer((req, res) => res.end(JSON.stringify({ state })))
srv.listen(0, '127.0.0.1', async () => {
  const cfg = { nice: 0, gate: { enabled: true, status_url: `http://127.0.0.1:${srv.address().port}/api/status`, live_states: ['INVULNERABLE', 'ACTIVE', 'FEAST'], poll_seconds: 0.2 } }
  const events = []
  const log = (m) => events.push(m)
  const t0 = Date.now()
  setTimeout(() => { state = 'WAITING' }, 700) // lobby: the command may start
  setTimeout(() => { state = 'ACTIVE' }, 1500) // a match starts mid-run: freeze
  setTimeout(() => { state = 'RESETTING' }, 3200) // over: thaw
  // counts ten 150 ms steps = 1.5 s of work if never frozen
  const out = await gate.runHeavy(cfg, ['node', '-e', 'let i=0; const t=setInterval(()=>{ if(++i>=10){ console.log("done"); clearInterval(t) } },150)'], '/tmp/claude-1000/-home-tabor-github-mcmovie/7cecbfaf-4244-4f15-b7df-42c0fcea73ff/scratchpad/gate-test.log', log)
  const took = Date.now() - t0
  assert(/done/.test(out), 'command finished')
  assert(events.some(e => /waits for the lobby/.test(e)), 'did not start during a live match')
  assert(events.some(e => /paused/.test(e)) && events.some(e => /resumed/.test(e)), 'froze and thawed: ' + events.join(' | '))
  assert(took > 3200, `finished only after the second match ended (${took} ms)`)
  console.log('ok   gate: waits for lobby, pauses during a match, resumes after  (' + took + ' ms)')
  srv.close()
  process.exit(0)
})
