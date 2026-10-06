'use strict'
// Publish a finished project: upload final.mp4 to YouTube, post the link to
// Discord, then send a Short on to Instagram Reels and TikTok (lib/publish/social.js). The title and logline the planner wrote are used as they are:
// a story is just its title, a match is "<brand> #<n>: <title>", and the
// description is the logline, a line saying every match is recorded and how
// to be in a video, the server address and the hashtags.
// publish.json in the project overrides any field.
// Writes published.json so a project is never uploaded twice by accident.
const fs = require('fs')
const path = require('path')
const U = require('../util')
const formats = require('../formats')
const youtube = require('./youtube')
const discord = require('./discord')
const { verify } = require('./verify')

const CONFIG = path.join(U.ROOT, 'config', 'publish.json')
const COUNTER = path.join(U.ROOT, 'automation', 'match_number.json')
// the tags people actually browse (YouTube shows the first three above the title, so the
// most-searched ones lead); a version number or a year is not a hashtag
const HASHTAGS = ['minecraft',  'minecraftpvp',  'hungergames',  'minecraftserver',  'minecraftsmp',  'smp',  'minecraftshorts',  'minecraftmemes',  'gaming',  'hardcorepvp']

function config () {
  if (!U.exists(CONFIG)) return { youtube: {}, discord: {}, site: 'hardcorepvp.com' }
  return U.readJson(CONFIG)
}

function when (ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

// Match films are numbered in upload order. A project keeps its number once
// it is uploaded; until then it shows the number it would get.
function matchNumber (dir) {
  const done = path.join(dir, 'published.json')
  if (U.exists(done) && U.readJson(done).number) return U.readJson(done).number
  return (U.exists(COUNTER) ? U.readJson(COUNTER).last || 0 : 0) + 1
}

const INVITE = 'Every match on the server is recorded. Want to be in a video? Play a match at {site}.'

// A hashtag is letters, digits and underscores only: "#26.3" ends at the dot and "#2026" is
// nobody's search, so anything else is cleaned or dropped before it can reach a description.
function hashtags (cfg) {
  const list = (cfg.youtube && cfg.youtube.hashtags) || HASHTAGS
  const tags = list.map(h => String(h).replace(/^#/, '').replace('{year}', new Date().getFullYear()).replace(/[^A-Za-z0-9_]/g, ''))
    .filter(t => t && !/^\d+$/.test(t))
  return [...new Set(tags.map(t => '#' + t))].join(' ')
}

// Build title/description/tags from what the project knows about itself.
function metadata (dir, cfg = config()) {
  const fmt = formats.ofProject(dir)
  const short = fmt.id === 'short'
  const site = cfg.site || 'hardcorepvp.com'
  // one line under the logline: every match is recorded, and how to be in a video (`youtube.invite`
  // in the config replaces it, with {site}; an empty string drops it)
  const invite = (cfg.youtube && cfg.youtube.invite !== undefined ? String(cfg.youtube.invite) : INVITE).replace(/\{site\}/g, site).trim()
  const describe = (logline) => [String(logline || '').trim(), invite, `IP is ${site}`, hashtags(cfg)].filter(Boolean).join('\n\n')
  let meta
  if (U.exists(path.join(dir, 'doc.json'))) {
    const doc = U.readJson(path.join(dir, 'doc.json'))
    const d = U.exists(path.join(dir, 'digest.json')) ? U.readJson(path.join(dir, 'digest.json')) : { players: [] }
    const played = d.started ? when(Date.parse(d.started)) : ''
    const number = matchNumber(dir)
    const title = `${cfg.brand || 'HardcorePvP.com'} #${number}: ${doc.title}`
    meta = {
      kind: 'match', number, title, played,
      logline: String(doc.logline || '').trim(), description: describe(doc.logline),
      discord: `Hardcore Game #${number}`
    }
  } else {
    const story = U.readJson(path.join(dir, 'story.json'))
    meta = {
      kind: 'story', title: story.title, played: '',
      logline: String(story.logline || '').trim(), description: describe(story.logline),
      discord: String(story.logline || story.title || '').trim()
    }
  }
  // the players who appear in it (the same list the website shows on their profiles)
  try { meta.players = require('./films').playersIn(dir) } catch { meta.players = [] }
  if (meta.players.length) meta.description += '\n\nPlayers in this video: ' + meta.players.slice(0, 40).join(', ')
  // attribution for licensed music actually used in this film
  const edlFile = path.join(dir, 'edl.json')
  if (U.exists(edlFile)) {
    const credits = [...new Set((U.readJson(edlFile).music || []).map(m => m.credit).filter(Boolean))]
    if (credits.length) meta.description += '\n\nMusic:\n' + credits.join('\n')
  }
  meta.tags = [...new Set([...(cfg.youtube.tags || ['minecraft', 'hardcore games', 'minecraft pvp', 'machinima']), short ? 'shorts' : 'minecraft movie'])]
  meta.short = short
  const overrideFile = path.join(dir, 'publish.json')
  if (U.exists(overrideFile)) Object.assign(meta, U.readJson(overrideFile))
  return meta
}

async function publish (dir, opts = {}) {
  const cfg = config()
  const file = path.join(dir, 'final.mp4')
  if (!U.exists(file)) throw new Error('no final.mp4 in ' + dir)
  const doneFile = path.join(dir, 'published.json')
  if (U.exists(doneFile) && !opts.force) return { ...U.readJson(doneFile), already: true }
  const meta = metadata(dir, cfg)
  if (opts.privacy) meta.privacy = opts.privacy
  // Nothing unverified goes public: a broken, partial, black or silent file is a failed job.
  const check = verify(dir)
  if (opts.dryRun) return { dry_run: true, meta, bytes: fs.statSync(file).size, verified: check.ok, problems: check.problems, checks: check.info }
  if (!check.ok) throw new Error('not publishing, the film failed verification: ' + check.problems.join('; '))
  const result = { at: new Date().toISOString(), title: meta.title, kind: meta.kind, short: meta.short }
  if (meta.number) result.number = meta.number
  const yt = await youtube.upload(cfg.youtube || {}, file, meta)
  result.youtube_id = yt.id; result.url = yt.url
  U.writeJson(doneFile, result) // record the upload before anything else can fail
  // the newest Short is kept (one file) so it can be sent to a platform by hand from the admin page
  if (meta.short) { try { require('./social').keepLatest(file, meta, result) } catch (e) { result.keep_error = e.message } }
  // who is in it, for the website's player profiles (kept after the project is deleted)
  try { require('./films').record(dir, meta, result, meta.privacy || (cfg.youtube && cfg.youtube.privacy) || 'public') } catch (e) { result.films_error = e.message }
  if (meta.number && !(U.exists(COUNTER) && U.readJson(COUNTER).last >= meta.number)) U.writeJson(COUNTER, { last: meta.number })
  if (cfg.discord && cfg.discord.webhook_url && !opts.noDiscord) {
    try {
      await discord.post(cfg.discord, { content: `${meta.discord}\n${yt.url}` })
      result.discord = true
    } catch (e) { result.discord = false; result.discord_error = e.message }
    U.writeJson(doneFile, result)
  }
  // The same file to Instagram Reels and TikTok, when those are connected. Whatever happens
  // there, the YouTube upload above stands.
  if (!opts.noSocial) {
    try { Object.assign(result, await require('./social').post(file, meta, result, cfg, { log: m => console.error('[social] ' + m) })) } catch (e) { result.social_error = String(e.message).slice(0, 300) }
    U.writeJson(doneFile, result)
  }
  return result
}

module.exports = { publish, metadata, config, CONFIG, COUNTER }
