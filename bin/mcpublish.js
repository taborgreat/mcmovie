#!/usr/bin/env node
'use strict'
// Publishing: YouTube upload + Discord post for a finished project.
const path = require('path')
const http = require('http')
const U = require('../lib/util')
const P = require('../lib/publish/publish')
const youtube = require('../lib/publish/youtube')

const HELP = `mcpublish - upload a finished film and announce it

  auth [--port 8765]            one-time YouTube consent; saves the refresh token
  auth --code <code-or-url>     finish consent by pasting the code (or the whole redirected URL)
  show <slug>                   print the title/description that would be used
  verify <slug>                 check that final.mp4 is complete and sound (publishing refuses otherwise)
  <slug> [--dry-run] [--privacy public|unlisted|private] [--no-discord] [--force]

Credentials: config/publish.json (copy config/publish.example.json). It is gitignored.
`

function parseArgs (argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) args[k] = v; else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[k] = argv[++i]; else args[k] = true } else args._.push(a)
  }
  return args
}

async function auth (args) {
  const cfg = P.config()
  if (!cfg.youtube || !cfg.youtube.client_id || !cfg.youtube.client_secret) throw new Error('put youtube.client_id and youtube.client_secret in config/publish.json first (Google Cloud console -> OAuth client, type "Desktop app")')
  const port = Number(args.port || 8765)
  const redirect = `http://127.0.0.1:${port}/callback`
  const save = async (code) => {
    const tok = await youtube.exchangeCode(cfg.youtube, code, redirect)
    if (!tok.refresh_token) throw new Error('Google returned no refresh token; revoke the app at myaccount.google.com/permissions and try again')
    cfg.youtube.refresh_token = tok.refresh_token
    U.writeJson(P.CONFIG, cfg)
    require('fs').chmodSync(P.CONFIG, 0o600)
    console.log('refresh token saved to config/publish.json')
  }
  if (args.code) {
    let code = String(args.code)
    if (code.includes('code=')) code = new URL(code.startsWith('http') ? code : 'http://x/?' + code).searchParams.get('code')
    return save(code)
  }
  console.log('Open this URL in a browser signed in to the channel:\n\n' + youtube.authUrl(cfg.youtube, redirect) + '\n')
  console.log(`Waiting on ${redirect} ... (if the browser is on another machine, copy the URL it lands on and run: node bin/mcpublish.js auth --code "<that url>")`)
  await new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirect)
      const code = u.searchParams.get('code')
      if (!code) { res.end('no code'); return }
      try { await save(code); res.end('Done. You can close this tab.'); srv.close(); resolve() } catch (e) { res.end('Failed: ' + e.message); srv.close(); reject(e) }
    })
    srv.listen(port, '127.0.0.1')
  })
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (!cmd || cmd === 'help' || args.help) { console.log(HELP); return }
  if (cmd === 'auth') return auth(args)
  if (cmd === 'verify') { const r = require('../lib/publish/verify').verify(U.projectDir(args._[1])); console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1; return }
  if (cmd === 'show') { console.log(JSON.stringify(P.metadata(U.projectDir(args._[1])), null, 2)); return }
  const r = await P.publish(U.projectDir(cmd), { dryRun: !!args['dry-run'], privacy: args.privacy, noDiscord: !!args['no-discord'], force: !!args.force })
  console.log(JSON.stringify(r, null, 2))
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('error: ' + e.message); process.exit(1) })
