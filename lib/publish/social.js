'use strict'
// After a Short is up on YouTube, the same file goes to Instagram Reels and TikTok.
// Each platform is on its own: one failing never stops the other, and neither can undo or
// hold up the YouTube upload. What happened is kept per film in automation/social.json
// (ids, links, errors, the captions), a failed platform is tried again while the hosted clip
// still exists (`social tick`, run by the loop), and the links are added to the film's
// record for the website (automation/films.json). The clip is public only while it is
// needed: it comes down the moment every platform has confirmed, or when the retry window
// (48 hours) runs out.
const fs = require('fs')
const path = require('path')
const U = require('../util')
const hosting = require('./hosting')
const instagram = require('./instagram')
const tiktok = require('./tiktok')

const FILE = path.join(U.ROOT, 'automation', 'social.json')
const CONFIG = path.join(U.ROOT, 'config', 'publish.json')
const MAX_TRIES = 4
const PLATFORMS = { instagram, tiktok }

function read () { try { return U.exists(FILE) ? U.readJson(FILE) : { films: {} } } catch { return { films: {} } } }
function write (db) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); U.writeJson(FILE, db) }

// Tokens are renewed as they are used; the new ones go back into config/publish.json.
function saver (platform) {
  return fields => {
    const cfg = U.readJson(CONFIG)
    cfg[platform] = { ...(cfg[platform] || {}), ...fields }
    U.writeJson(CONFIG, cfg)
    try { fs.chmodSync(CONFIG, 0o600) } catch { /* not ours to chmod */ }
  }
}

// The caption is the same words YouTube got: the film's title, then its YouTube description
// (logline, the invitation, the server address, the hashtags, who is in it, music credits).
// Instagram takes it on the Reel; TikTok takes it on a direct post, and for a draft it is shown
// on the admin page to paste in the app (drafts cannot carry a caption through the API).
function captions (meta, cfg) {
  const text = [String(meta.title || '').trim(), String(meta.description || meta.logline || '').trim()].filter(Boolean).join('\n\n').slice(0, 2200)
  return { instagram: text, tiktok: text }
}

function enabled (cfg) { return Object.keys(PLATFORMS).filter(p => PLATFORMS[p].ready(cfg[p])) }

// TikTok limits how much an account may be sent. In inbox mode the documented limit is 5
// drafts waiting within any 24 hours; a direct-posting account gets roughly 15 posts a day.
// A film over the limit is not an error: it waits and goes when there is room again, as long
// as its clip is still hosted. (`tiktok.max_per_day` overrides.) Films are taken first come,
// first served.
function tiktokRoom (cfg, job) {
  const c = cfg.tiktok || {}
  const cap = c.max_per_day !== undefined ? c.max_per_day : (tiktok.mode(c) === 'direct' ? 15 : 5)
  const sent = Object.values(read().films).filter(j => j.id !== job.id && j.tiktok && j.tiktok.ok && Date.now() - Date.parse(j.tiktok.tried || 0) < 86400000).length
  return { ok: sent < cap, cap, sent }
}

// Send one film to one platform. Returns what to remember about it.
async function send (platform, cfg, job, log) {
  const c = cfg[platform]
  if (platform === 'tiktok') {
    const room = tiktokRoom(cfg, job)
    if (!room.ok) return { ok: false, waiting: true, tried: new Date().toISOString(), tries: (job.tiktok && job.tiktok.tries) || 0, error: `TikTok's daily limit is reached (${room.sent} of ${room.cap} in the last 24 hours); it goes when there is room` }
  }
  const base = { tried: new Date().toISOString(), tries: ((job[platform] && job[platform].tries) || 0) + 1 }
  try {
    const up = await hosting.reachable(job.clip_url, U.exists(job.clip) ? fs.statSync(job.clip).size : 0)
    if (!up.ok) throw new Error('the hosted clip is not reachable: ' + up.why)
    if (platform === 'instagram') {
      const r = await instagram.publishReel(c, { video_url: job.clip_url, caption: job.captions.instagram, log }, saver('instagram'))
      return { ...base, ok: true, id: r.id, url: r.url }
    }
    const r = await tiktok.upload(c, { video_url: job.clip_url, caption: job.captions.tiktok, log }, saver('tiktok'))
    return { ...base, ok: true, publish_id: r.publish_id, status: r.status, post_id: r.post_id, url: r.url }
  } catch (e) {
    return { ...base, ok: false, error: String(e.message).slice(0, 400) }
  }
}

function links (job) {
  const out = {}
  for (const p of Object.keys(PLATFORMS)) if (job[p] && job[p].ok && job[p].url) out[p] = job[p].url
  return out
}

// Every platform that is switched on has the clip: it does not need to be public any more.
function settled (cfg, job) { return enabled(cfg).every(p => job[p] && job[p].ok) }
function unhost (cfg, job, log = () => {}) {
  if (!job.clip || !settled(cfg, job)) return false
  if (hosting.remove(job.id)) { log(`"${job.title}": every platform has the clip, it is no longer public`); job.unhosted = new Date().toISOString(); return true }
  return false
}

function remember (job) {
  const db = read()
  db.films[job.id] = job
  db.updated = new Date().toISOString()
  write(db)
  try { require('./films').link(job.id, links(job)) } catch { /* the film record is the website's; the upload stands without it */ }
}

// Called by the publisher right after the YouTube upload. `result` is what YouTube gave
// (youtube_id, url). Returns the per-platform outcome to store in published.json.
async function post (file, meta, result, cfg, opts = {}) {
  const log = opts.log || (() => {})
  const on = enabled(cfg)
  if (!on.length) return {}
  const s = cfg.social || {}
  if (!meta.short && !s.long_too) return { social_skipped: 'not a Short (set social.long_too to send wide videos too)' }
  const privacy = meta.privacy || (cfg.youtube && cfg.youtube.privacy) || 'public'
  if (privacy !== 'public') return { social_skipped: `the YouTube upload is ${privacy}; only public films are cross-posted` }
  const hosted = hosting.host(cfg, file, result.youtube_id)
  const job = { id: result.youtube_id, title: meta.title, short: !!meta.short, at: result.at, youtube: result.url, clip: hosted.file, clip_url: hosted.url, captions: captions(meta, cfg) }
  const out = {}
  for (const p of on) {
    job[p] = await send(p, cfg, job, log)
    out[p] = job[p]
    log(job[p].ok ? `${p}: done${job[p].url ? ' ' + job[p].url : job[p].status === 'inbox' ? ' (in the drafts, waiting to be posted by hand)' : ''}` : job[p].waiting ? `${p}: ${job[p].error}` : `${p}: failed, will be tried again: ${job[p].error}`)
    remember(job)
  }
  if (unhost(cfg, job, log)) remember(job)
  return out
}

// The loop's chore: try failed platforms again while their clip is still hosted, keep the
// Instagram token from running out, and clear hosted clips nobody needs any more.
async function tick (cfg, log = () => {}) {
  const db = read()
  const waiting = new Set()
  const done = []
  for (const job of Object.values(db.films)) {
    for (const p of enabled(cfg)) {
      const st = job[p]
      if (!st || st.ok || st.tries >= MAX_TRIES) continue
      if (!U.exists(job.clip)) continue
      // a film only waiting for room at TikTok keeps its clip hosted for up to a week
      if (st.waiting && Date.now() - Date.parse(job.at || 0) < 7 * 86400000) waiting.add(job.id)
      if (Date.now() - Date.parse(st.tried || 0) < 30 * 60000) { waiting.add(job.id); continue }
      job[p] = await send(p, cfg, job, log)
      if (!(job[p].waiting && !job[p].ok)) log(job[p].ok ? `${p}: "${job.title}" went through on try ${job[p].tries}` : `${p}: "${job.title}" still failing (try ${job[p].tries} of ${MAX_TRIES}): ${job[p].error}`)
      if (!job[p].ok && job[p].tries < MAX_TRIES) waiting.add(job.id)
      remember(job)
      done.push({ id: job.id, platform: p, ok: job[p].ok })
    }
    if (unhost(cfg, job, log)) remember(job)
  }
  if (instagram.ready(cfg.instagram)) { try { await instagram.freshToken(cfg.instagram, saver('instagram')) } catch (e) { log('instagram: ' + e.message) } }
  const pruned = hosting.prune(hosting.KEEP_HOURS, id => waiting.has(id))
  return { retried: done, pruned }
}

// The newest Short, kept as one file next to its facts, for sends by hand (the project folder
// itself is deleted after the upload).
const LATEST = path.join(U.ROOT, 'automation', 'latest_short.mp4')
const LATEST_META = path.join(U.ROOT, 'automation', 'latest_short.json')
function keepLatest (file, meta, result) {
  fs.mkdirSync(path.dirname(LATEST), { recursive: true })
  fs.copyFileSync(file, LATEST)
  U.writeJson(LATEST_META, { youtube_id: result.youtube_id, url: result.url, title: meta.title, logline: meta.logline || '', description: meta.description || '', kind: meta.kind, short: true, at: result.at, privacy: meta.privacy || 'public' })
}
function latest () {
  if (!U.exists(LATEST) || !U.exists(LATEST_META)) return null
  return { ...U.readJson(LATEST_META), file: LATEST }
}

// Send the newest Short to the platforms named (default: every connected one), by hand.
// A platform that already has it is sent again only with `again`.
async function sendLatest (cfg, { platforms = null, again = false, log = () => {} } = {}) {
  const l = latest()
  if (!l) throw new Error('no Short has been uploaded yet, so there is nothing to send')
  const want = (platforms && platforms.length ? platforms : enabled(cfg)).filter(p => PLATFORMS[p])
  const off = want.filter(p => !PLATFORMS[p].ready(cfg[p]))
  if (off.length) throw new Error(`${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} not connected`)
  if (!want.length) throw new Error('no platform is connected')
  const db = read()
  const hosted = hosting.host(cfg, l.file, l.youtube_id)
  const job = db.films[l.youtube_id] || { id: l.youtube_id, title: l.title, short: true, at: l.at, youtube: l.url, captions: captions({ title: l.title, logline: l.logline, description: l.description }, cfg) }
  job.clip = hosted.file; job.clip_url = hosted.url; delete job.unhosted
  job.captions = captions({ title: l.title, logline: l.logline, description: l.description }, cfg)
  const out = {}
  for (const p of want) {
    if (job[p] && job[p].ok && !again) { out[p] = { ...job[p], already: true }; log(`${p}: this clip already went there (${job[p].url || job[p].status}); say again to resend`); continue }
    job[p] = await send(p, cfg, job, log)
    out[p] = job[p]
    log(job[p].ok ? `${p}: done${job[p].url ? ' ' + job[p].url : job[p].status === 'inbox' ? ' (in the drafts, waiting to be posted by hand)' : ''}` : `${p}: ${job[p].error}`)
    remember(job)
  }
  if (unhost(cfg, job, log)) remember(job)
  return { title: l.title, youtube: l.url, ...out }
}

function status (cfg) {
  const db = read()
  return {
    instagram: { set_up: instagram.configured(cfg.instagram), connected: instagram.ready(cfg.instagram), account: (cfg.instagram || {}).username || null, avatar_url: (cfg.instagram || {}).avatar_url || null, token_expires: (cfg.instagram || {}).token_expires || null },
    tiktok: { set_up: tiktok.configured(cfg.tiktok), connected: tiktok.ready(cfg.tiktok), mode: tiktok.mode(cfg.tiktok || {}), account: (cfg.tiktok || {}).display_name || (cfg.tiktok || {}).username || null, username: (cfg.tiktok || {}).username || null, avatar_url: (cfg.tiktok || {}).avatar_url || null, login_expires: (cfg.tiktok || {}).refresh_expires || null },
    latest: (() => { const l = latest(); return l ? { title: l.title, youtube: l.url, at: l.at, id: l.youtube_id, caption: captions({ title: l.title, logline: l.logline, description: l.description }, cfg).tiktok } : null })(),
    clips_url: hosting.urlFor(cfg, '<id>'),
    recent: Object.values(db.films).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8).map(j => ({ title: j.title, youtube: j.youtube, instagram: j.instagram ? (j.instagram.ok ? j.instagram.url || 'posted' : 'failed: ' + j.instagram.error) : '-', tiktok: j.tiktok ? (j.tiktok.ok ? j.tiktok.url || j.tiktok.status : 'failed: ' + j.tiktok.error) : '-' }))
  }
}

module.exports = { FILE, captions, enabled, post, tick, status, read, saver, links, keepLatest, latest, sendLatest }
