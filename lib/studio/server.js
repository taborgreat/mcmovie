'use strict'
// The studio server: a private copy of the game the live server runs (same
// Paper build, in studio/, port 25567, offline mode) where a recorded match is
// played back by bots and filmed by the real client. It loads the match's own
// world (the region files the recorder saved), so every hill, tree and trap is
// the real one. It is never the live server and shares nothing with it.
//
// ViaVersion + ViaBackwards let the 1.21.4 bots join the newer server; the
// filming client runs the server's own version and needs neither.
const fs = require('fs')
const net = require('net')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const U = require('../util')

const DIR = path.join(U.ROOT, 'studio')
const DEFAULTS = {
  host: '127.0.0.1',
  port: 25567,
  game_version: '26.2', // the client that films it
  bot_version: '1.21.4', // what mineflayer speaks (through ViaBackwards)
  java: path.join(os.homedir(), '.jdks', 'jdk-25.0.4.1+1', 'bin', 'java'),
  xmx: '3G'
}

function config () {
  const f = path.join(U.ROOT, 'config', 'studio.json')
  let c = { ...DEFAULTS }
  if (U.exists(f)) { try { c = { ...c, ...U.readJson(f) } } catch {} }
  if (!U.exists(c.java)) c.java = bundledJava() || 'java'
  return c
}

// On a machine without that JDK: the game client brings its own Java (the launcher downloads
// Mojang's runtime into capture/mc/jvm), and the newest of those runs this server too.
function bundledJava () {
  const jvm = path.join(U.ROOT, 'capture', 'mc', 'jvm')
  let best = null
  try {
    for (const d of fs.readdirSync(jvm)) {
      const bin = path.join(jvm, d, 'bin', 'java')
      if (!U.exists(bin)) continue
      let major = 0
      try { major = parseInt((fs.readFileSync(path.join(jvm, d, 'release'), 'utf8').match(/JAVA_VERSION="(\d+)/) || [])[1], 10) || 0 } catch { /* no release file */ }
      if (!best || major > best.major) best = { bin, major }
    }
  } catch { /* the client is not set up */ }
  return best ? best.bin : null
}

function available () { return U.exists(path.join(DIR, 'paper.jar')) && U.exists(path.join(DIR, 'plugins', 'ViaBackwards.jar')) }

// The game's own plugin (hardcorekits), if it is installed here. The studio works without it;
// with it, kit abilities are the real thing (lib/studio/perform.js). It must only ever boot
// here in its "studio mode" (kits only: no match, no world rotation, no status server), which
// is what its config.yml says; setup() writes that file before every start.
const KITS_JAR = path.join(DIR, 'plugins', 'HardcoreGames.jar')
const KITS_CONFIG = path.join(DIR, 'plugins', 'HardcoreGames', 'config.yml')
function kits () { return U.exists(KITS_JAR) }

function setup () {
  const c = config()
  fs.mkdirSync(path.join(DIR, 'plugins'), { recursive: true })
  if (kits()) {
    let has = false
    try { has = /^studio:\s*\n\s+enabled:\s*true\s*$/m.test(fs.readFileSync(KITS_CONFIG, 'utf8')) } catch {}
    if (!has) {
      fs.mkdirSync(path.dirname(KITS_CONFIG), { recursive: true })
      fs.writeFileSync(KITS_CONFIG, '# The film studio runs the game plugin for its kits only. Everything not set here comes\n# from the defaults inside the jar.\nstudio:\n  enabled: true\n')
    }
  }
  U.calmSkinLookups(DIR)
  fs.writeFileSync(path.join(DIR, 'eula.txt'), 'eula=true\n')
  fs.writeFileSync(path.join(DIR, 'server.properties'), [
    `server-ip=${c.host}`, `server-port=${c.port}`, 'online-mode=false', 'enforce-secure-profile=false', 'level-name=world',
    'gamemode=creative', 'force-gamemode=false', 'difficulty=easy', 'spawn-protection=0', 'allow-flight=true', 'pvp=true',
    'view-distance=12', 'simulation-distance=8', 'max-players=60', 'motd=mcmovie studio', 'spawn-monsters=false',
    'network-compression-threshold=-1', 'sync-chunk-writes=false', 'enable-command-block=false', 'max-tick-time=-1'
  ].join('\n') + '\n')
  // the director bot "Camera" is op (offline-mode UUID, same as on the set server)
  U.writeJson(path.join(DIR, 'ops.json'), [{ uuid: 'a0649c04-1b3b-37ee-9972-ff17a6e1af19', name: 'Camera', level: 4, bypassesPlayerLimit: true }])
  for (const f of ['spigot.yml', 'bukkit.yml']) {
    const src = path.join(U.ROOT, 'server', f)
    if (U.exists(src) && !U.exists(path.join(DIR, f))) fs.copyFileSync(src, path.join(DIR, f))
  }
}

function isUp (host, port, timeoutMs = 800) {
  return new Promise(resolve => {
    const s = net.connect({ host, port })
    const done = ok => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs); s.once('connect', () => done(true)); s.once('timeout', () => done(false)); s.once('error', () => done(false))
  })
}

// Where this server version keeps the overworld's region files (the layout moved in 26.x).
function regionDir () {
  const candidates = [path.join(DIR, 'world', 'dimensions', 'minecraft', 'overworld', 'region'), path.join(DIR, 'world', 'region')]
  return candidates.find(d => U.exists(d)) || candidates[0]
}

// Replace the studio world with a recorded match's map. Server must be stopped.
function loadWorld (srcRegionDir) {
  const dst = regionDir()
  const base = path.dirname(dst)
  for (const sub of ['region', 'entities', 'poi']) fs.rmSync(path.join(base, sub), { recursive: true, force: true })
  fs.mkdirSync(dst, { recursive: true })
  let n = 0
  for (const f of fs.readdirSync(srcRegionDir)) if (f.endsWith('.mca')) { fs.copyFileSync(path.join(srcRegionDir, f), path.join(dst, f)); n++ }
  return n
}

function start (opts = {}) {
  const c = config()
  if (!available()) throw new Error('the studio server is not set up (studio/paper.jar and plugins); run tools/setup-real-client.sh')
  setup()
  fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true })
  const child = spawn(c.java, ['-Xms1G', `-Xmx${c.xmx}`, '-jar', 'paper.jar', 'nogui'], { cwd: DIR, stdio: ['pipe', 'pipe', 'pipe'] })
  fs.writeFileSync(path.join(DIR, 'server.pid'), String(child.pid))
  const log = fs.createWriteStream(path.join(DIR, 'logs', 'console.log'), { flags: 'a' })
  return new Promise((resolve, reject) => {
    let ready = false
    const timer = setTimeout(() => { if (!ready) { child.kill(); reject(new Error('studio server did not start in 4 minutes; see studio/logs/console.log')) } }, 240000)
    const onData = b => {
      log.write(b)
      if (opts.echo) process.stdout.write(b)
      if (!ready && /Done \(/.test(String(b))) {
        ready = true; clearTimeout(timer)
        resolve({
          cfg: c,
          child,
          cmd: line => child.stdin.write(line + '\n'),
          stop: () => new Promise(res => {
            const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 30000)
            child.once('close', () => { clearTimeout(t); try { fs.unlinkSync(path.join(DIR, 'server.pid')) } catch {} res() })
            try { child.stdin.write('stop\n') } catch { child.kill() }
          })
        })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('close', code => { clearTimeout(timer); if (!ready) reject(new Error(`studio server exited (${code}); see studio/logs/console.log`)) })
  })
}

// A brand-new studio has no world yet. The server must make its own once (level data, world
// settings) before a match's map can be dropped into it; region files in an empty folder
// crash the first start. Does nothing once the world exists.
async function firstBoot () {
  if (U.exists(path.join(DIR, 'world', 'level.dat'))) return false
  fs.rmSync(path.join(DIR, 'world'), { recursive: true, force: true })
  const server = await start()
  await server.stop()
  return true
}

async function stopRunning () {
  const f = path.join(DIR, 'server.pid')
  if (!U.exists(f)) return false
  const pid = parseInt(fs.readFileSync(f, 'utf8'), 10)
  try { process.kill(pid, 'SIGTERM') } catch { try { fs.unlinkSync(f) } catch {} return false }
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await U.sleep(500) }
  try { fs.unlinkSync(f) } catch {}
  return true
}

module.exports = { DIR, config, available, kits, setup, start, firstBoot, stopRunning, isUp, loadWorld, regionDir }
