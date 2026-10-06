'use strict'
// One small https helper for the social uploads (Instagram, TikTok): send a form or JSON,
// get the status and the parsed JSON back. Nothing here knows about any platform.
const https = require('https')
const { URL, URLSearchParams } = require('url')

function call (method, url, { query = null, form = null, json = null, headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    const h = { accept: 'application/json', ...headers }
    let body = null
    if (form) { body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString(); h['content-type'] = 'application/x-www-form-urlencoded' }
    if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json; charset=UTF-8' }
    if (body) h['content-length'] = Buffer.byteLength(body)
    const req = https.request(u, { method, headers: h, timeout: timeoutMs }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        // ids longer than 15 digits (TikTok post ids) do not fit a JS number: keep them as strings
        const safe = text.replace(/([[,:]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"')
        try { data = text ? JSON.parse(safe) : null } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, data, text })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${u.host}${u.pathname} timed out`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// A short, safe description of a failed call: the platform's own message, never a token.
function why (r) {
  const d = r.data || {}
  const e = d.error || d
  const msg = (e && (e.error_user_msg || e.message || e.error_description || e.error_message || e.description)) || (typeof d.error === 'string' ? d.error : '') || String(r.text || '').slice(0, 200)
  const code = e && (e.code || e.error_subcode || e.type)
  return `HTTP ${r.status}${code ? ' ' + code : ''}: ${String(msg).replace(/access_token=[^&\s"]+/g, 'access_token=…').slice(0, 300)}`
}

module.exports = { call, why }
