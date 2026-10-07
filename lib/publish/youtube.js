'use strict'
// YouTube upload with nothing but https: OAuth refresh token -> access token,
// then a resumable upload (init with metadata, PUT the file). Credentials come
// from config/publish.json (gitignored). A Short is just a vertical video up
// to 3 minutes; "#Shorts" in the title/description helps it get classified.
const fs = require('fs')
const https = require('https')
const { URL, URLSearchParams } = require('url')

// upload, plus reading the channel's numbers for the stats panel (lib/publish/stats.js); a login
// made before the stats existed only has the first and needs one more consent
const SCOPE = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'].join(' ')
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

function request (method, url, { headers = {}, body = null, stream = null, length = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const h = { ...headers }
    if (body && !stream) h['content-length'] = Buffer.byteLength(body)
    if (stream && length !== null) h['content-length'] = length
    const req = https.request(u, { method, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (stream) stream.pipe(req)
    else { if (body) req.write(body); req.end() }
  })
}

function authUrl (cfg, redirectUri) {
  const q = new URLSearchParams({ client_id: cfg.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent' })
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString()
}

// Exchange the one-time code from the consent screen for a refresh token.
async function exchangeCode (cfg, code, redirectUri) {
  const body = new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString()
  const r = await request('POST', TOKEN_URL, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (r.status !== 200) throw new Error(`token exchange failed (${r.status}): ${r.body.slice(0, 300)}`)
  return JSON.parse(r.body)
}

async function accessToken (cfg) {
  if (!cfg.client_id || !cfg.client_secret || !cfg.refresh_token) throw new Error('YouTube is not configured: config/publish.json needs youtube.client_id, client_secret and refresh_token (run: node bin/mcpublish.js auth)')
  const body = new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token' }).toString()
  const r = await request('POST', TOKEN_URL, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  if (r.status !== 200) throw new Error(`could not refresh the YouTube token (${r.status}): ${r.body.slice(0, 300)}`)
  return JSON.parse(r.body).access_token
}

// meta: { title, description, tags, short }
// A stream that lets through at most `mbps` megabits a second, so an upload leaves room on
// the home line for the game server (youtube.upload_mbps in the config; 0 or unset = no cap).
function throttled (file, mbps) {
  const src = fs.createReadStream(file, { highWaterMark: 64 * 1024 })
  if (!(mbps > 0)) return src
  const { Transform } = require('stream')
  const bytesPerSec = mbps * 125000
  let windowStart = Date.now(); let sent = 0
  const gate = new Transform({
    transform (chunk, enc, cb) {
      sent += chunk.length
      const due = windowStart + (sent / bytesPerSec) * 1000 // when this byte count is allowed out
      const wait = due - Date.now()
      if (sent > bytesPerSec * 10) { windowStart = Date.now(); sent = 0 } // keep the numbers small
      if (wait > 0) setTimeout(() => cb(null, chunk), wait); else cb(null, chunk)
    }
  })
  return src.pipe(gate)
}

async function upload (cfg, file, meta) {
  const token = await accessToken(cfg)
  const size = fs.statSync(file).size
  const resource = {
    snippet: { title: String(meta.title).slice(0, 100), description: String(meta.description || '').slice(0, 4900), tags: (meta.tags || []).slice(0, 30), categoryId: String(cfg.category_id || '20') },
    status: { privacyStatus: meta.privacy || cfg.privacy || 'unlisted', selfDeclaredMadeForKids: !!cfg.made_for_kids }
  }
  const init = await request('POST', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' },
    body: JSON.stringify(resource)
  })
  if (init.status !== 200 || !init.headers.location) throw new Error(`YouTube upload init failed (${init.status}): ${init.body.slice(0, 400)}`)
  const put = await request('PUT', init.headers.location, { headers: { 'content-type': 'video/mp4' }, stream: throttled(file, Number(cfg.upload_mbps) || 0), length: size })
  if (put.status !== 200 && put.status !== 201) throw new Error(`YouTube upload failed (${put.status}): ${put.body.slice(0, 400)}`)
  const id = JSON.parse(put.body).id
  return { id, url: meta.short ? `https://youtube.com/shorts/${id}` : `https://youtu.be/${id}` }
}

module.exports = { upload, accessToken, authUrl, exchangeCode, throttled, SCOPE }
