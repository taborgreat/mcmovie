'use strict'
// Instagram and TikTok do not take an uploaded file from us: they fetch the video themselves
// from a public https address. So a finished clip is copied to automation/clips/<id>.mp4,
// which the website serves as https://<site>/clips/<id>.mp4 (hardcorekits http/server.js).
// It is only public while it is needed: taken down as soon as every platform has confirmed it
// has the clip, and after a retry window (KEEP_HOURS) if one of them never does.
const fs = require('fs')
const path = require('path')
const https = require('https')
const U = require('../util')

const DIR = path.join(U.ROOT, 'automation', 'clips')
const KEEP_HOURS = 48

function baseUrl (cfg) {
  const s = cfg.social || {}
  return String(s.clips_url || `https://${cfg.site || 'hardcorepvp.com'}/clips`).replace(/\/+$/, '')
}

function fileFor (id) { return path.join(DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.mp4`) }
function urlFor (cfg, id) { return `${baseUrl(cfg)}/${path.basename(fileFor(id))}` }

// Put the clip where the website serves it. Returns { file, url }.
function host (cfg, src, id) {
  fs.mkdirSync(DIR, { recursive: true })
  const file = fileFor(id)
  if (!U.exists(file) || fs.statSync(file).size !== fs.statSync(src).size) fs.copyFileSync(src, file)
  return { file, url: urlFor(cfg, id) }
}

// Is the clip really reachable from outside, whole, as a video? Asked before a platform is
// told to fetch it, so a missing route or a proxy problem is our error message, not theirs.
function reachable (url, bytes, timeoutMs = 20000) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, res => {
      const len = Number(res.headers['content-length'] || 0)
      const type = String(res.headers['content-type'] || '')
      if (res.statusCode !== 200) return resolve({ ok: false, why: `${url} answered HTTP ${res.statusCode} (redirects are not followed by the platforms)` })
      if (!/video\/mp4/.test(type)) return resolve({ ok: false, why: `${url} is served as "${type}", not video/mp4` })
      if (bytes && len !== bytes) return resolve({ ok: false, why: `${url} is ${len} bytes, the clip is ${bytes}` })
      resolve({ ok: true })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', e => resolve({ ok: false, why: `${url} could not be reached: ${e.message}` }))
    req.end()
  })
}

// Take a clip off the public address (both platforms have it, or nobody will ask again).
function remove (id) { try { fs.unlinkSync(fileFor(id)); return true } catch { return false } }

// Hosted clips older than `hours`, unless `keep(id)` says one is still wanted.
function prune (hours = KEEP_HOURS, keep = () => false) {
  if (!U.exists(DIR)) return 0
  let n = 0
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.mp4')) continue
    const p = path.join(DIR, f)
    if (Date.now() - fs.statSync(p).mtimeMs > hours * 3600000 && !keep(f.slice(0, -4))) { fs.unlinkSync(p); n++ }
  }
  return n
}

module.exports = { DIR, KEEP_HOURS, host, fileFor, urlFor, reachable, remove, prune }
