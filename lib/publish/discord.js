'use strict'
// Discord webhook post. The webhook URL is a secret in config/publish.json.
const https = require('https')
const { URL } = require('url')

function post (cfg, message) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.webhook_url) return reject(new Error('Discord is not configured: config/publish.json needs discord.webhook_url'))
    const u = new URL(cfg.webhook_url)
    u.searchParams.set('wait', 'true')
    const body = JSON.stringify({ username: cfg.username || undefined, content: message.content, embeds: message.embeds })
    const req = https.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve(true) : reject(new Error(`Discord webhook returned ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`)))
    })
    req.on('error', reject)
    req.write(body); req.end()
  })
}

module.exports = { post }
