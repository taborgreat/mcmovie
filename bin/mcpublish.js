#!/usr/bin/env node
'use strict'
// Publishing: YouTube upload + Discord post for a finished project, then Instagram Reels and
// TikTok for a Short.
const path = require('path')
const http = require('http')
const U = require('../lib/util')
const P = require('../lib/publish/publish')
const youtube = require('../lib/publish/youtube')

const HELP = `mcpublish - upload a finished film and announce it

  auth [--port 8765]            one-time YouTube consent; saves the refresh token
  auth --code <code-or-url>     finish consent by pasting the code (or the whole redirected URL)
  auth instagram|tiktok         print the sign-in link for that account (keys from config/publish.json)
  auth instagram|tiktok --code <code-or-url>
                                finish it: paste the code the site's /oauth page shows (or its whole URL)
  social status                 which accounts are connected, and what happened to the last films
  social connect <platform> [--state s]   the sign-in link, as JSON (what the admin page uses)
  social finish <platform> --code <c>     finish a sign-in, as JSON
  social send [--id <youtube id>] [--to tiktok,instagram] [--again]   send a kept Short by hand (newest if no id)
  social tick                   retry failed Instagram/TikTok posts, renew tokens, clear old hosted clips
  social <slug>                 send an already-uploaded project to Instagram/TikTok now
  stats scan [--force]          ask YouTube, Instagram and TikTok for every film's numbers (the loop does this hourly)
  stats show                    the numbers, as JSON (what the admin page shows)
  stats report                  the plain-words digest (automation/performance.md)
  music status                  every song: which films used it, any trouble, suspended or not
  music strike <youtube id> [--what text]   a film was muted/blocked/removed: suspend the commercial songs it used
  music clear <track id>        allow a suspended song again
  media                         every song, track, overlay and sting the films can use, with its purpose and standing
  show <slug>                   print the title/description that would be used
  verify <slug>                 check that final.mp4 is complete and sound (publishing refuses otherwise)
  <slug> [--dry-run] [--privacy public|unlisted|private] [--no-discord] [--no-social] [--force]

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

// Instagram and TikTok sign-in. Both send the browser back to an https page on the site
// (the redirect_uri in the config, e.g. https://hardcorepvp.com/oauth), which only shows the
// code; pasting it here finishes the job. No secret ever passes through the website.
async function authSocial (platform, args) {
  const fs = require('fs')
  const cfg = P.config()
  const mod = require(`../lib/publish/${platform}`)
  const c = cfg[platform] || {}
  const keys = platform === 'instagram' ? 'instagram.app_id, instagram.app_secret and instagram.redirect_uri' : 'tiktok.client_key, tiktok.client_secret and tiktok.redirect_uri'
  if (!mod.configured(c)) throw new Error(`put ${keys} in config/publish.json first (see config/publish.example.json)`)
  if (!args.code) {
    const state = require('crypto').randomBytes(8).toString('hex')
    console.log(`Open this link in a browser signed in to the ${platform === 'instagram' ? 'Instagram' : 'TikTok'} account:\n\n${mod.authUrl(c, state)}\n`)
    console.log(`After you approve, the site shows a code. Then run:\n  node bin/mcpublish.js auth ${platform} --code "<the code, or the whole address of that page>"`)
    return
  }
  let code = String(args.code)
  if (code.includes('code=')) code = new URL(code.startsWith('http') ? code : 'http://x/?' + code).searchParams.get('code')
  const fields = await mod.exchangeCode(c, code)
  cfg[platform] = { ...c, enabled: c.enabled !== false, ...fields }
  U.writeJson(P.CONFIG, cfg)
  fs.chmodSync(P.CONFIG, 0o600)
  console.log(platform === 'instagram'
    ? `Instagram connected${fields.username ? ' as @' + fields.username : ''}; the token is saved in config/publish.json and renews itself.`
    : `TikTok connected (${require('../lib/publish/tiktok').mode(cfg.tiktok)} mode); the login is saved in config/publish.json and renews itself for a year.`)
}

async function socialCmd (args) {
  const social = require('../lib/publish/social')
  const cfg = P.config()
  const what = args._[1]
  if (!what || what === 'status') { console.log(JSON.stringify(await social.status(cfg), null, 2)); return }
  if (what === 'connect') {
    const platform = args._[2]
    if (platform !== 'instagram' && platform !== 'tiktok') throw new Error('social connect instagram|tiktok')
    const mod = require(`../lib/publish/${platform}`)
    if (!mod.configured(cfg[platform] || {})) { console.log(JSON.stringify({ ok: false, error: `${platform} keys are not in config/publish.json yet` })); process.exitCode = 1; return }
    console.log(JSON.stringify({ ok: true, url: mod.authUrl(cfg[platform], String(args.state || 'mcmovie')) })); return
  }
  if (what === 'finish') {
    const platform = args._[2]
    if (platform !== 'instagram' && platform !== 'tiktok') throw new Error('social finish instagram|tiktok --code <code>')
    if (!args.code) throw new Error('--code is required')
    const mod = require(`../lib/publish/${platform}`)
    const fields = await mod.exchangeCode(cfg[platform] || {}, String(args.code))
    cfg[platform] = { ...(cfg[platform] || {}), enabled: (cfg[platform] || {}).enabled !== false, ...fields }
    U.writeJson(P.CONFIG, cfg); require('fs').chmodSync(P.CONFIG, 0o600)
    console.log(JSON.stringify({ ok: true, platform, account: fields.display_name || fields.username || '', avatar_url: fields.avatar_url || '' })); return
  }
  if (what === 'send') {
    const to = args.to ? String(args.to).split(',').map(x => x.trim()).filter(Boolean) : null
    console.log(JSON.stringify(await social.sendLatest(cfg, { id: args.id ? String(args.id) : null, platforms: to, again: !!args.again, log: m => console.error('[social] ' + m) }), null, 2)); return
  }
  if (what === 'tick') { console.log(JSON.stringify(await social.tick(cfg, m => console.error('[social] ' + m)), null, 2)); return }
  const dir = U.projectDir(what)
  const done = path.join(dir, 'published.json')
  if (!U.exists(done)) throw new Error(`${what} has not been uploaded to YouTube yet (no published.json)`)
  const result = U.readJson(done)
  const out = await social.post(path.join(dir, 'final.mp4'), P.metadata(dir, cfg), result, cfg, { log: m => console.error('[social] ' + m) })
  U.writeJson(done, { ...result, ...out })
  console.log(JSON.stringify(out, null, 2))
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (!cmd || cmd === 'help' || args.help) { console.log(HELP); return }
  if (cmd === 'auth' && (args._[1] === 'instagram' || args._[1] === 'tiktok')) return authSocial(args._[1], args)
  if (cmd === 'auth') return auth(args)
  if (cmd === 'social') return socialCmd(args)
  if (cmd === 'media') { const M = require('../lib/media'); console.log(JSON.stringify(M.catalogue(), null, 2)); return }
  if (cmd === 'music') {
    const mh = require('../lib/publish/music_health')
    const what = args._[1] || 'status'
    if (what === 'strike') { if (!args._[2]) throw new Error('music strike <youtube id>'); console.log(JSON.stringify(mh.strike(String(args._[2]), String(args.what || 'struck'), 'admin'), null, 2)); return }
    if (what === 'clear') { if (!args._[2]) throw new Error('music clear <track id>'); mh.clear(String(args._[2])); console.log('cleared ' + args._[2]); return }
    console.log(JSON.stringify(mh.status(), null, 2)); return
  }
  if (cmd === 'stats') {
    const stats = require('../lib/publish/stats')
    const what = args._[1] || 'show'
    if (what === 'scan') { console.log(JSON.stringify(await stats.scan(P.config(), { force: !!args.force, log: m => console.error('[stats] ' + m) }))); return }
    if (what === 'report') { console.log(stats.report()); return }
    console.log(JSON.stringify(stats.summary())); return
  }
  if (cmd === 'verify') { const r = require('../lib/publish/verify').verify(U.projectDir(args._[1])); console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1; return }
  if (cmd === 'show') { console.log(JSON.stringify(P.metadata(U.projectDir(args._[1])), null, 2)); return }
  const r = await P.publish(U.projectDir(cmd), { dryRun: !!args['dry-run'], privacy: args.privacy, noDiscord: !!args['no-discord'], noSocial: !!args['no-social'], force: !!args.force })
  console.log(JSON.stringify(r, null, 2))
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('error: ' + e.message); process.exit(1) })
