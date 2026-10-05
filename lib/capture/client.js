'use strict'
// The real Minecraft client as the film camera. It runs with no monitor: a
// virtual X display (Xvfb) holds the window, VirtualGL sends the game's OpenGL
// to the NVIDIA card (so rendering costs the game server's CPU nothing), and
// OpenAL writes the game's own sound straight to a wav file. Everything lives
// under capture/ in this repo: the launcher (portablemc, in a venv), the game
// files, VirtualGL. Nothing is installed system-wide.
//
// The client joins the set server as a spectator ("Lens"). lib/capture/film.js
// points it at camera entities and records the display with ffmpeg.
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const U = require('../util')

const CAP = path.join(U.ROOT, 'capture')
const WORK = path.join(CAP, 'work')
const VGL = path.join(CAP, 'vgl', 'usr', 'lib')
const STATE = path.join(WORK, 'client.json')
const WAV = path.join(WORK, 'game.wav')

const DEFAULTS = {
  enabled: true, // film staged scenes with the real client; false = old offline renderer
  display: ':77',
  username: 'Lens',
  mc_version: '1.21.4',
  render_distance: 14,
  fov: 70, // vertical field of view for 16:9 films
  fov_portrait: 92, // and for 9:16 shorts
  encoder: 'h264_nvenc', // capture and clip encoding on the GPU; 'libx264' to use the CPU
  keep_capture: false // keep capture/scene_<id>.mkv after the clips are cut
}

function config () {
  const f = path.join(U.ROOT, 'config', 'capture.json')
  if (!U.exists(f)) return { ...DEFAULTS }
  try { return { ...DEFAULTS, ...U.readJson(f) } } catch { return { ...DEFAULTS } }
}

function available () {
  return U.exists(path.join(CAP, '.venv', 'bin', 'portablemc')) && U.exists(path.join(VGL, 'libvglfaker.so'))
}

function alive (pid) { try { process.kill(pid, 0); return true } catch { return false } }

function readState () { return U.exists(STATE) ? U.readJson(STATE) : null }

function writeOptions (cfg, width, height) {
  const fov = height > width ? cfg.fov_portrait : cfg.fov
  const opts = {
    version: 4189,
    onboardAccessibility: false,
    skipMultiplayerWarning: true,
    joinedFirstServer: true,
    tutorialStep: 'none',
    narrator: 0,
    renderDistance: cfg.render_distance,
    simulationDistance: 8,
    maxFps: 180,
    inactivityFpsLimit: '"minimized"',
    enableVsync: false,
    fov: ((fov - 70) / 40).toFixed(3),
    fovEffectScale: 0,
    gamma: 0.5,
    guiScale: 2,
    chatVisibility: 2,
    pauseOnLostFocus: false,
    autoJump: false,
    fullscreen: false,
    bobView: false,
    graphicsMode: 1,
    renderClouds: '"true"',
    particles: 0,
    entityShadows: true,
    showSubtitles: false,
    attackIndicator: 0,
    soundCategory_master: 1.0,
    soundCategory_music: 0.0,
    resourcePacks: '["vanilla","file/mcmovie"]' // capture/work/resourcepacks/mcmovie: a transparent crosshair
  }
  fs.mkdirSync(WORK, { recursive: true })
  fs.writeFileSync(path.join(WORK, 'options.txt'), Object.entries(opts).map(([k, v]) => `${k}:${v}`).join('\n') + '\n')
  fs.writeFileSync(path.join(WORK, 'alsoft.conf'), `[general]\ndrivers = wave\nchannels = stereo\nfrequency = 48000\n[wave]\nfile = ${WAV}\n`)
}

async function stop () {
  const st = readState()
  if (!st) return false
  for (const pid of [st.launcher, st.xvfb]) {
    if (!pid || !alive(pid)) continue
    try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
  }
  for (let i = 0; i < 40 && [st.launcher, st.xvfb].some(p => p && alive(p)); i++) await U.sleep(250)
  for (const pid of [st.launcher, st.xvfb]) if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  try { fs.unlinkSync(STATE) } catch {}
  try { fs.unlinkSync(WAV) } catch {}
  return true
}

// Start the display and the game, pointed at the set server. Returns once the process is up;
// call waitJoined() to wait for the world.
async function start ({ width, height, host, port, version }) {
  if (!available()) throw new Error('real-client capture is not set up (capture/.venv and capture/vgl are missing); see README "Real client"')
  const cfg = config()
  await stop()
  writeOptions(cfg, width, height)
  const n = cfg.display.replace(':', '')
  for (const f of [`/tmp/.X${n}-lock`]) { try { if (!alive(parseInt(fs.readFileSync(f, 'utf8')))) fs.unlinkSync(f) } catch {} }
  const log = (name) => fs.openSync(path.join(WORK, name), 'w')
  const xvfb = spawn('Xvfb', [cfg.display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { detached: true, stdio: ['ignore', log('xvfb.log'), log('xvfb.err')] })
  xvfb.unref()
  for (let i = 0; i < 50 && !U.exists(`/tmp/.X11-unix/X${n}`); i++) await U.sleep(100)
  const env = {
    ...process.env,
    DISPLAY: cfg.display,
    VGL_DISPLAY: 'egl',
    LD_LIBRARY_PATH: [VGL, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    LD_PRELOAD: `${path.join(VGL, 'libdlfaker.so')}:${path.join(VGL, 'libvglfaker.so')}`,
    ALSOFT_CONF: path.join(WORK, 'alsoft.conf'),
    ALSOFT_DRIVERS: 'wave'
  }
  const args = ['--main-dir', path.join(CAP, 'mc'), '--work-dir', WORK, '--output', 'human', 'start', version || cfg.mc_version,
    '-u', cfg.username, '--server', host, '--server-port', String(port), '--resolution', `${width}x${height}`]
  const launcher = spawn(path.join(CAP, '.venv', 'bin', 'portablemc'), args, { detached: true, env, stdio: ['ignore', log('client.log'), log('client.err')] })
  launcher.unref()
  const st = { launcher: launcher.pid, xvfb: xvfb.pid, display: cfg.display, width, height, username: cfg.username, started: new Date().toISOString() }
  U.writeJson(STATE, st)
  U.log('capture', `client starting on ${cfg.display} (${width}x${height})`)
  return st
}

function key (...names) {
  const st = readState()
  execFileSync(path.join(CAP, '.venv', 'bin', 'python'), [path.join(CAP, 'key.py'), st.display, ...names])
}

// Wait until the director sees the client in the world, give it time to draw the terrain
// and for the join notices to fade. The HUD is not hidden with F1 (that would hide name
// tags too): a spectator has no hotbar, chat is off, and the resource pack blanks the crosshair.
async function waitJoined (director, maxMs = 180000) {
  const st = readState()
  const t0 = Date.now()
  while (!director.bot.players[st.username]) {
    if (!alive(st.launcher)) throw new Error('the Minecraft client exited before joining; see capture/work/client.log')
    if (Date.now() - t0 > maxMs) throw new Error('the Minecraft client did not join the set server in time; see capture/work/client.log')
    await U.sleep(500)
  }
  director.cmd(`/gamemode spectator ${st.username}`)
  await U.sleep(12000)
  U.log('capture', `client joined after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  return st
}

// Where the game's sound file is right now, in seconds from its start.
function wavPosition () {
  if (!U.exists(WAV)) return null
  const fd = fs.openSync(WAV, 'r')
  try {
    const head = Buffer.alloc(64)
    fs.readSync(fd, head, 0, 64, 0)
    const byteRate = head.readUInt32LE(28)
    const dataAt = head.indexOf('data')
    const headerBytes = dataAt > 0 ? dataAt + 8 : 44
    if (!byteRate) return null
    return (fs.fstatSync(fd).size - headerBytes) / byteRate
  } finally { fs.closeSync(fd) }
}

module.exports = { config, available, start, stop, waitJoined, key, wavPosition, readState, WAV, WORK, DEFAULTS }
