'use strict'
// Automation settings: config/auto.json over these defaults.
const path = require('path')
const os = require('os')
const U = require('../util')

const DEFAULTS = {
  idle_hours: 8, // no match for this long -> make a staged story
  idle_stories: true, // false = only film real matches; no stories are made
  poll_seconds: 30,
  short_match_minutes: 12, // a big match still becomes a Short under this length
  long_min_players: 10, // fewer players than this is always a Short, however long the match ran
  idle_story_format: 'short', // 'short' or 'long'
  publish: true, // false = make films but do not upload or post
  privacy: null, // override config/publish.json's youtube.privacy
  keep_recordings: 3, // copies of the newest match recordings (and their plans) kept in keep/matches/ after their films are made
  max_attempts: 2,
  // Once a film is uploaded, everything made for it is deleted: recording, replays, clips,
  // voice lines and the rendered file. Only the record in automation/state.json stays.
  cleanup_after_publish: true,
  nice: 10, // CPU priority for render/encode so the game server keeps its ticks
  // Heavy steps (shoot, render, encode) only run while no match is live. The state comes
  // from the plugin's local status API; an unreachable server counts as "not live".
  gate: { enabled: true, status_url: 'http://127.0.0.1:8085/api/status', live_states: ['INVULNERABLE', 'ACTIVE', 'FEAST'], poll_seconds: 5 },
  stats_file: path.join(os.homedir(), 'hgserver', 'plugins', 'HardcoreGames', 'stats.json'),
  llm: {
    // Claude Code headless. The LLM only reads and writes plan files; the daemon runs every command.
    command: 'claude',
    args: ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    model: null,
    timeout_minutes: 20,
    fix_rounds: 3
  },
  voice: {
    mock: false,
    url: 'http://127.0.0.1:8880',
    // started by the daemon when the health check fails; null = never start it
    autostart: { cwd: 'voice_server', command: '.venv/bin/uvicorn', args: ['server:app', '--host', '127.0.0.1', '--port', '8880'], env: { MCMOVIE_TTS_BACKEND: 'qwen3tts' }, ready_seconds: 240 }
  },
  // story seeds: a situation from the game with a point built in (who wins, who loses, why).
  // The planner picks the kits that make it work and builds the rest.
  genres: [
    'a short where someone towers to camp and the one kit that loves heights finds them',
    'a short where two teamers each plan to betray the other at the same moment',
    'a short about the last stew: two hurt players, one bowl, and who gets to it',
    'a short where the best-geared player loses to the simplest trick in the game',
    'a short where a kit everyone laughs at wins by being used exactly right',
    'a short where a hunter chases someone to the forcefield and forgets where they are',
    'a short where a trap catches the player who built it',
    'a short where someone hides all match and is finally found by the last person they wanted',
    'a short where a kit\'s one weakness decides the fight',
    'a short where a player who hotkeys stews like a machine runs out one bowl early',
    'a short where a teamer saves their partner and the partner takes the win anyway',
    'a short where the feast lands and the one who waited for it never gets to open a chest'
  ]
}

function merge (a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b || {})) out[k] = (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) ? merge(a[k], v) : v
  return out
}

function load () {
  const f = path.join(U.ROOT, 'config', 'auto.json')
  return U.exists(f) ? merge(DEFAULTS, U.readJson(f)) : merge(DEFAULTS, {})
}

module.exports = { load, DEFAULTS }
