'use strict'
// Stage 5b: turn voice.json lines into WAVs. Talks to the TTS server
// (voice_server/) over HTTP with an OpenAI-style /v1/audio/speech endpoint.
// --mock renders placeholder audio locally (espeak-ng if installed, else a
// tone pattern) so the whole pipeline can be exercised without the GPU.
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const { spawnSync, execFileSync } = require('child_process')
const U = require('../util')
const S = require('../speeds')

const DEFAULT_URL = process.env.MCMOVIE_TTS_URL || 'http://127.0.0.1:8880'

// Stock voice ids known to voice_server/bank.json. Used to auto-cast when
// cast.json has no entry for a character.
const STOCK = Object.keys(require('../../voice_server/bank.json').voices)

function request (method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null
    const req = lib.request(u, { method, headers: { 'content-type': 'application/json', ...headers, ...(data ? { 'content-length': data.length } : {}) }, timeout: 600000 }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    if (data) req.write(data)
    req.end()
  })
}

// Gain that brings a line's average level to a common target, so one voice is not
// quieter than another in the mix. Bounded: silence must not be boosted into noise.
const TARGET_MEAN_DB = -21
function levelGain (file) {
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
    const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr || '')
    if (!m) return 0
    return Math.round(Math.max(-12, Math.min(12, TARGET_MEAN_DB - parseFloat(m[1]))) * 10) / 10
  } catch { return 0 }
}

function wavDuration (file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim()
  return parseFloat(out)
}

function autoVoice (line) {
  if (line.group || line.voice.voice === 'crowd') return 'crowd'
  const d = String((line.voice && line.voice.voice_desc) || '').toLowerCase()
  if (/narrat/.test(d)) return 'narrator'
  if (/(child|kid|boy|girl|young)/.test(d)) return 'kid'
  if (/(old|elder|ancient|grand)/.test(d)) return /(woman|female|she|lady)/.test(d) ? 'elderly_female' : 'elderly_male'
  if (/(gruff|villain|growl|menac|gravel)/.test(d)) return 'gruff'
  if (/(woman|female|she|lady|girl)/.test(d)) return 'adult_female'
  return 'adult_male'
}

// Resolve the voice profile id for a line from cast.json / defaults.
function profileFor (line) {
  const v = line.voice || {}
  if (v.profile_id) return v.profile_id
  const spec = v.voice || 'auto'
  if (spec.startsWith('stock:')) return spec.slice(6)
  if (spec === 'crowd') return 'crowd'
  if (spec === 'design' || spec.startsWith('clone:')) return 'char_' + line.character.toLowerCase()
  return autoVoice(line)
}

// --- mock backend -----------------------------------------------------------
function hasEspeak () { return spawnSync('which', ['espeak-ng']).status === 0 }

function mockLine (line, file) {
  const sec = S.estimateLineSeconds(line.text)
  if (hasEspeak()) {
    const pid = profileFor(line)
    const voice = /female|kid/.test(pid) ? 'en+f3' : (/elderly|gruff/.test(pid) ? 'en+m5' : 'en+m3')
    const pitch = /kid/.test(pid) ? 70 : (/elderly|gruff/.test(pid) ? 30 : 50)
    const speed = /elderly/.test(pid) ? 140 : 165
    const r = spawnSync('espeak-ng', ['-v', voice, '-p', String(pitch), '-s', String(speed), '-w', file, line.text])
    if (r.status === 0) return
  }
  // tone pattern: one short beep per word, pitch by voice, so timing is audible
  const pid = profileFor(line)
  let freq = /female/.test(pid) ? 520 : (/kid/.test(pid) ? 700 : (/elderly|gruff/.test(pid) ? 180 : 260))
  if (/^(player_|char_)/.test(pid)) { let h = 0; for (const ch of pid) h = (h * 31 + ch.charCodeAt(0)) >>> 0; freq = 200 + (h % 9) * 45 }
  const words = Math.max(1, line.text.trim().split(/\s+/).length)
  const per = sec / words
  const expr = `0.25*sin(2*PI*${freq}*t)*lt(mod(t,${per.toFixed(3)}),${(per * 0.6).toFixed(3)})`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=24000:d=${sec.toFixed(2)}`, '-ac', '1', file])
}

// --- real backend -----------------------------------------------------------
async function ttsLine (url, line, file, names = []) {
  const body = {
    model: 'default',
    input: require('./pronounce').speakable(line.text, names),
    voice: profileFor(line),
    instructions: [line.emotion, line.delivery].filter(Boolean).join('; '),
    response_format: 'wav',
    speed: (line.voice && line.voice.speed) || 1.0,
    crowd: line.group || profileFor(line) === 'crowd' ? { takes: 6, jitter_ms: 180 } : undefined
  }
  const r = await request('POST', url.replace(/\/$/, '') + '/v1/audio/speech', body)
  if (r.status !== 200) throw new Error(`TTS ${r.status}: ${r.body.toString().slice(0, 300)}`)
  fs.writeFileSync(file, r.body)
}

// Ensure designed/cloned voices exist on the server. Idempotent: a voice that
// is already built is reused, so a character or player sounds the same in
// every film (pass redesign to rebuild it). Works from story.json when there
// is one, otherwise from cast.json alone (match mode).
async function castVoices (dir, opts = {}) {
  const url = opts.url || DEFAULT_URL
  const castFile = path.join(dir, 'cast.json')
  const storyFile = path.join(dir, 'story.json')
  const cast = U.exists(castFile) ? U.readJson(castFile) : { characters: {} }
  const chars = U.exists(storyFile)
    ? U.readJson(storyFile).characters.map(c => ({ id: c.id, group: c.group, voice: c.voice, voice_desc: c.voice_desc }))
    : Object.keys(cast.characters).map(id => ({ id }))
  let built = new Set()
  if (!opts.mock) {
    const r = await request('GET', url + '/v1/voices').catch(() => null)
    if (r && r.status === 200) built = new Set(JSON.parse(r.body.toString()).voices.filter(v => v.built).map(v => v.id))
  }
  const prefsLib = require('../prefs'); const prefs = prefsLib.read()
  const bank = require('../../voice_server/bank.json').voices
  for (const c of chars) {
    const entry = cast.characters[c.id] || (cast.characters[c.id] = { voice: c.group ? 'crowd' : (c.voice || 'auto'), voice_desc: c.voice_desc })
    if (!entry.voice_desc) entry.voice_desc = c.voice_desc
    // a real player who chose a voice in game (/movie voice) is always heard in it
    const chosen = prefsLib.voiceOf(c.id, null, prefs)
    if (chosen && bank[chosen] && !entry.chosen) { entry.voice = 'stock:' + chosen; entry.profile_id = chosen; entry.chosen = true }
    if (opts.mock) { if (!entry.profile_id) entry.profile_id = profileFor({ character: c.id, voice: entry, group: c.group }); continue }
    if (entry.voice === 'design') {
      const id = entry.profile_id || ('char_' + c.id.toLowerCase())
      if (!built.has(id) || opts.redesign) {
        const r = await request('POST', url + '/v1/voices/design', { id, description: entry.voice_desc, language: entry.language || 'en', sample_text: opts.sampleText })
        if (r.status !== 200) throw new Error(`voice design for ${c.id} failed: ${r.body.toString().slice(0, 300)}`)
        const j = JSON.parse(r.body.toString())
        entry.ref_audio = j.ref_audio
        U.log('voice', `designed voice ${id} for ${c.id}`)
      }
      entry.profile_id = id
    } else if (entry.voice.startsWith('clone:')) {
      const id = entry.profile_id || ('char_' + c.id.toLowerCase())
      if (!built.has(id) || opts.redesign) {
        const wav = entry.voice.slice(6)
        const r = await request('POST', url + '/v1/voices/clone?id=' + encodeURIComponent(id) + '&ref_text=' + encodeURIComponent(entry.ref_text || ''), fs.readFileSync(path.resolve(dir, wav)), { 'content-type': 'audio/wav' })
        if (r.status !== 200) throw new Error(`voice clone for ${c.id} failed: ${r.body.toString().slice(0, 300)}`)
        entry.ref_audio = JSON.parse(r.body.toString()).ref_audio
      }
      entry.profile_id = id
    } else if (entry.voice.startsWith('stock:')) entry.profile_id = entry.voice.slice(6)
    else if (entry.voice === 'crowd') entry.profile_id = 'crowd'
    else entry.profile_id = autoVoice({ character: c.id, voice: entry, group: c.group })
  }
  U.writeJson(castFile, cast)
  return cast
}

async function voice (dir, opts = {}) {
  const url = opts.url || DEFAULT_URL
  const vj = U.readJson(path.join(dir, 'voice.json'))
  const wavDir = path.join(dir, 'wav')
  fs.mkdirSync(wavDir, { recursive: true })
  const castFile = path.join(dir, 'cast.json')
  const cast = U.exists(castFile) ? U.readJson(castFile) : { characters: {} }
  if (!opts.mock) {
    const ping = await request('GET', url + '/v1/voices').catch(e => ({ status: 0, body: Buffer.from(e.message) }))
    if (ping.status !== 200) throw new Error(`TTS server not reachable at ${url} (${ping.body.toString().slice(0, 100)}). Start voice_server or use --mock.`)
  }
  const names = require('./pronounce').knownNames(dir)
  // placeholder audio from an earlier --mock run must not be mistaken for real voices
  const prevFile = path.join(dir, 'voice_result.json')
  if (U.exists(prevFile)) { try { if (!!U.readJson(prevFile).mock !== !!opts.mock) opts = { ...opts, force: true } } catch { /* ignore */ } }
  const results = {}
  let done = 0; let failed = 0
  for (const line of vj.lines) {
    const file = path.join(wavDir, line.id.replace(/[^A-Za-z0-9_.-]/g, '_') + '.wav')
    line.voice = (cast.characters || {})[line.character] || line.voice
    if (U.exists(file) && !opts.force) { results[line.id] = { wav: path.relative(dir, file), duration_sec: wavDuration(file), norm_db: levelGain(file), cached: true }; continue }
    let ok = false
    for (let attempt = 1; attempt <= (opts.retries || 3) && !ok; attempt++) {
      try {
        if (opts.mock) mockLine(line, file); else await ttsLine(url, line, file, names)
        ok = true
      } catch (e) {
        U.log('voice', `line ${line.id} attempt ${attempt} failed: ${e.message}`)
        await U.sleep(500 * attempt)
      }
    }
    if (!ok) { failed++; continue }
    results[line.id] = { wav: path.relative(dir, file), duration_sec: wavDuration(file), norm_db: levelGain(file), profile: profileFor(line) }
    done++
  }
  U.writeJson(path.join(dir, 'voice_result.json'), { generated: new Date().toISOString(), mock: !!opts.mock, lines: results })
  const tlFile = path.join(dir, 'timeline.json')
  if (U.exists(tlFile)) {
    const tl = U.readJson(tlFile)
    for (const l of tl.lines) if (results[l.id]) { l.wav = results[l.id].wav; l.duration_sec = results[l.id].duration_sec; l.norm_db = results[l.id].norm_db; l.profile = results[l.id].profile }
    U.writeJson(tlFile, tl)
  }
  U.log('voice', `${done} rendered, ${Object.keys(results).length - done} cached, ${failed} failed`)
  if (failed) throw new Error(`${failed} lines failed`)
  return results
}

module.exports = { voice, castVoices, profileFor, autoVoice, STOCK, DEFAULT_URL, wavDuration }
