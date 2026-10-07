'use strict'
// How the films are doing, without opening three apps: every hour the loop asks YouTube,
// Instagram and TikTok for each video's numbers and keeps them in automation/stats.json, one
// sample per hour per video, so the admin page can show today's counts, how they moved, and
// what kind of film does well. Nothing here changes anything on any platform.
//
// What each platform gives (and the login it needs):
//   YouTube   views, likes, comments (Data API, youtube.readonly) and lifetime watch time,
//             average view length and percentage, subscribers gained (Analytics API,
//             yt-analytics.readonly). A login made before the stats existed needs one more
//             consent: node bin/mcpublish.js auth
//   Instagram views, reach, likes, comments, shares, saves, total interactions and the
//             average watch time of each Reel (instagram_business_manage_insights)
//   TikTok    views, likes, comments, shares of each video (video.list); followers (user.info.stats)
// The accounts themselves (subscribers/followers, totals) are sampled hourly too (`channels`,
// Mongo `channel_samples`).
const fs = require('fs')
const path = require('path')
const U = require('../util')
const { call, why } = require('./http')
const youtube = require('./youtube')
const instagram = require('./instagram')
const tiktok = require('./tiktok')
const social = require('./social')

const FILE = path.join(U.ROOT, 'automation', 'stats.json')
const REPORT = path.join(U.ROOT, 'automation', 'performance.md')
const MIN_GAP_MIN = 25 // never two samples of one video closer than this (the loop asks every half hour)

function read () { try { return U.exists(FILE) ? U.readJson(FILE) : { videos: {} } } catch { return { videos: {} } } }
function write (db) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); db.updated = new Date().toISOString(); U.writeJson(FILE, db) }

// Every film we have uploaded, with the ids it has on each platform.
function catalogue () {
  const films = require('./films').read().films || []
  const jobs = social.read().films || {}
  return films.filter(f => f && f.id && f.url).map(f => {
    const j = jobs[f.id] || {}
    return {
      id: f.id, title: f.title, kind: f.kind, short: !!f.short, published: f.published, privacy: f.privacy || 'public', players: (f.players || []).length,
      number: (String(f.title).match(/#(\d+):/) || [])[1] ? Number((String(f.title).match(/#(\d+):/) || [])[1]) : null,
      features: f.features || null, strategy_id: (f.features && f.features.strategy_id) || null,
      instagram_id: j.instagram && j.instagram.ok ? j.instagram.id : null,
      tiktok_id: j.tiktok && j.tiktok.ok ? (j.tiktok.post_id || null) : null
    }
  })
}

// ---- the three platforms ------------------------------------------------------------------

async function youtubeCounts (cfg, ids, log) {
  const out = {}
  if (!ids.length || !(cfg.youtube && cfg.youtube.refresh_token)) return out
  let token
  try { token = await youtube.accessToken(cfg.youtube) } catch (e) { log('youtube: ' + e.message); return out }
  const auth = { authorization: 'Bearer ' + token }
  for (let i = 0; i < ids.length; i += 50) {
    const r = await call('GET', 'https://www.googleapis.com/youtube/v3/videos', { headers: auth, query: { part: 'statistics,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: 50 } })
    if (r.status !== 200 || !r.data) { log('youtube: counts refused (' + why(r) + ')' + (r.status === 403 ? '; the YouTube login needs the read scope: node bin/mcpublish.js auth' : '')); break }
    const got = new Set()
    for (const v of r.data.items || []) {
      got.add(v.id)
      const s = v.statistics || {}; const st = v.status || {}; const cd = v.contentDetails || {}
      out[v.id] = { views: +s.viewCount || 0, likes: +s.likeCount || 0, comments: +s.commentCount || 0, seconds: isoSeconds(cd.duration),
        status: { upload: st.uploadStatus || null, privacy: st.privacyStatus || null, rejection: st.rejectionReason || null, blocked_regions: (cd.regionRestriction && cd.regionRestriction.blocked || []).length } }
    }
    for (const id of ids.slice(i, i + 50)) if (!got.has(id)) out[id] = { missing: true }
  }
  // lifetime analytics per video (one call for up to 500 videos)
  try {
    // the whole channel's videos (it is only ours), top 200 by views; filtering by id with more
    // than 200 rows makes the API fail, and the channel will not have 200 films for a long while
    const q = { ids: 'channel==MINE', startDate: '2020-01-01', endDate: new Date().toISOString().slice(0, 10), metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained', dimensions: 'video', sort: '-views', maxResults: 200 }
    const r = await call('GET', 'https://youtubeanalytics.googleapis.com/v2/reports', { headers: auth, query: q })
    if (r.status === 200 && r.data && Array.isArray(r.data.rows)) {
      const cols = (r.data.columnHeaders || []).map(h => h.name)
      for (const row of r.data.rows) {
        const rec = Object.fromEntries(cols.map((c, k) => [c, row[k]]))
        if (!ids.includes(rec.video)) continue
        const o = out[rec.video] || (out[rec.video] = {})
        o.watch_min = Math.round(rec.estimatedMinutesWatched || 0); o.avg_sec = Math.round(rec.averageViewDuration || 0); o.avg_pct = +(rec.averageViewPercentage || 0).toFixed(1); o.subs = rec.subscribersGained || 0
      }
    } else log('youtube: analytics refused (' + why(r) + ')')
  } catch (e) { log('youtube: analytics ' + e.message) }
  return out
}

// Where viewers leave (YouTube only: the share still watching at each 1/100th of the film)
// and where its views come from. Slow to change, so asked once a day per film, for films up to
// 90 days old. relativeRetentionPerformance: 0-1, how this film holds viewers against videos of
// its length across YouTube.
// `since`: the film's upload date; a report over the whole channel history is 40 times slower.
async function youtubeRetention (cfg, id, since, log) {
  let token
  try { token = await youtube.accessToken(cfg.youtube) } catch (e) { log('youtube: ' + e.message); return null }
  const auth = { authorization: 'Bearer ' + token }
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Math.max(Date.parse('2020-01-01'), (Date.parse(since || 0) || 0) - 2 * 86400000)).toISOString().slice(0, 10)
  const out = { t: new Date().toISOString() }
  const r = await call('GET', 'https://youtubeanalytics.googleapis.com/v2/reports', { headers: auth, query: { ids: 'channel==MINE', startDate: start, endDate: end, metrics: 'audienceWatchRatio,relativeRetentionPerformance', dimensions: 'elapsedVideoTimeRatio', filters: 'video==' + id, maxResults: 100 } })
  if (r.status === 200 && r.data && Array.isArray(r.data.rows) && r.data.rows.length) {
    out.curve = r.data.rows.map(row => [+(+row[0]).toFixed(2), +(+row[1]).toFixed(3)])
    const rel = r.data.rows.map(row => +row[2]).filter(x => !isNaN(x))
    if (rel.length) out.relative = +(rel.reduce((a, b) => a + b, 0) / rel.length).toFixed(3)
    // where the drop is steepest after the first second: the moment to look at in the edit
    let worst = null
    for (let i = 1; i < out.curve.length; i++) { const d = out.curve[i - 1][1] - out.curve[i][1]; if (!worst || d > worst.drop) worst = { at: out.curve[i][0], drop: +d.toFixed(3) } }
    out.steepest_drop = worst
    out.half_gone_at = (out.curve.find(p => p[1] <= 0.5) || [null])[0]
  } else if (r.status !== 200) { log('youtube: retention refused (' + why(r) + ')'); return null }
  const t = await call('GET', 'https://youtubeanalytics.googleapis.com/v2/reports', { headers: auth, query: { ids: 'channel==MINE', startDate: start, endDate: end, metrics: 'views', dimensions: 'insightTrafficSourceType', filters: 'video==' + id, sort: '-views', maxResults: 25 } })
  if (t.status === 200 && t.data && Array.isArray(t.data.rows)) out.traffic = Object.fromEntries(t.data.rows.map(row => [row[0], row[1]]))
  return out.curve || out.traffic ? out : null
}

function isoSeconds (iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '')
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null
}

async function instagramCounts (cfg, items, log) {
  const out = {}
  if (!items.length || !instagram.ready(cfg.instagram)) return out
  let token
  try { token = await instagram.freshToken(cfg.instagram, social.saver('instagram')) } catch (e) { log('instagram: ' + e.message); return out }
  const base = cfg.instagram.api_version ? `https://graph.instagram.com/${cfg.instagram.api_version}` : 'https://graph.instagram.com'
  let refused = false
  for (const it of items) {
    const r = await call('GET', `${base}/${it.instagram_id}/insights`, { headers: { authorization: 'Bearer ' + token }, query: { metric: 'views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time' } })
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.data)) {
      if (!refused) log('instagram: insights refused (' + why(r) + '); the Instagram login may need the insights permission: reconnect it from the admin page')
      refused = true; continue
    }
    const o = {}
    for (const m of r.data.data) { const v = m.values && m.values[0] ? m.values[0].value : (m.total_value && m.total_value.value); if (v !== undefined) o[m.name] = v }
    out[it.id] = { views: o.views || 0, reach: o.reach || 0, likes: o.likes || 0, comments: o.comments || 0, shares: o.shares || 0, saved: o.saved || 0, interactions: o.total_interactions || 0, avg_watch_sec: o.ig_reels_avg_watch_time ? +(o.ig_reels_avg_watch_time / 1000).toFixed(1) : null }
  }
  return out
}

async function tiktokCounts (cfg, items, log) {
  const out = {}
  if (!items.length || !tiktok.ready(cfg.tiktok)) return out
  let token
  try { token = await tiktok.freshToken(cfg.tiktok, social.saver('tiktok')) } catch (e) { log('tiktok: ' + e.message); return out }
  const byPost = new Map(items.map(it => [String(it.tiktok_id), it.id]))
  const ids = [...byPost.keys()]
  for (let i = 0; i < ids.length; i += 20) {
    const r = await call('POST', 'https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count,create_time', { headers: { authorization: 'Bearer ' + token }, json: { filters: { video_ids: ids.slice(i, i + 20) } } })
    if (r.status !== 200 || !r.data || !r.data.data || !Array.isArray(r.data.data.videos)) { log('tiktok: counts refused (' + why(r) + '); the TikTok login may need the video.list scope: reconnect it from the admin page'); break }
    for (const v of r.data.data.videos) {
      const id = byPost.get(String(v.id)); if (!id) continue
      out[id] = { views: +v.view_count || 0, likes: +v.like_count || 0, comments: +v.comment_count || 0, shares: +v.share_count || 0 }
    }
  }
  return out
}

// ---- the accounts themselves: subscribers, followers, totals ------------------------------------

async function channelCounts (cfg, log) {
  const out = {}
  if (cfg.youtube && cfg.youtube.refresh_token) {
    try {
      const token = await youtube.accessToken(cfg.youtube)
      const r = await call('GET', 'https://www.googleapis.com/youtube/v3/channels', { headers: { authorization: 'Bearer ' + token }, query: { part: 'statistics', mine: 'true' } })
      const st = r.status === 200 && r.data && r.data.items && r.data.items[0] ? r.data.items[0].statistics : null
      if (st) out.youtube = { followers: +st.subscriberCount || 0, views: +st.viewCount || 0, videos: +st.videoCount || 0 }
      else log('youtube: channel counts refused (' + why(r) + ')')
    } catch (e) { log('youtube: channel ' + e.message) }
  }
  if (instagram.ready(cfg.instagram)) {
    try {
      const token = await instagram.freshToken(cfg.instagram, social.saver('instagram'))
      const base = cfg.instagram.api_version ? `https://graph.instagram.com/${cfg.instagram.api_version}` : 'https://graph.instagram.com'
      const r = await call('GET', `${base}/me`, { headers: { authorization: 'Bearer ' + token }, query: { fields: 'followers_count,follows_count,media_count' } })
      if (r.status === 200 && r.data) out.instagram = { followers: +r.data.followers_count || 0, following: +r.data.follows_count || 0, videos: +r.data.media_count || 0 }
      else log('instagram: account counts refused (' + why(r) + ')')
    } catch (e) { log('instagram: account ' + e.message) }
  }
  if (tiktok.ready(cfg.tiktok)) {
    try {
      const token = await tiktok.freshToken(cfg.tiktok, social.saver('tiktok'))
      const r = await call('GET', 'https://open.tiktokapis.com/v2/user/info/', { headers: { authorization: 'Bearer ' + token }, query: { fields: 'follower_count,following_count,likes_count,video_count' } })
      const u = r.status === 200 && r.data && r.data.data && r.data.data.user ? r.data.data.user : null
      if (u && u.follower_count !== undefined) out.tiktok = { followers: +u.follower_count || 0, following: +u.following_count || 0, likes: +u.likes_count || 0, videos: +u.video_count || 0 }
      else log('tiktok: account counts refused (' + why(r) + '); the TikTok login needs the user.info.stats scope: add it to the app and reconnect')
    } catch (e) { log('tiktok: account ' + e.message) }
  }
  return out
}

// ---- the scan -------------------------------------------------------------------------------

async function scan (cfg, { log = () => {}, force = false } = {}) {
  const db = read()
  const cat = catalogue()
  const now = Date.now()
  const due = cat.filter(f => { const v = db.videos[f.id]; const last = v && v.samples && v.samples.length ? Date.parse(v.samples[v.samples.length - 1].t) : 0; return force || now - last > MIN_GAP_MIN * 60000 })
  if (!due.length) return { sampled: 0, videos: cat.length }
  const yt = await youtubeCounts(cfg, due.map(f => f.id), log)
  const ig = await instagramCounts(cfg, due.filter(f => f.instagram_id), log)
  const tt = await tiktokCounts(cfg, due.filter(f => f.tiktok_id), log)
  // the accounts themselves, once per hour too
  db.channels = db.channels || []
  const lastCh = db.channels.length ? Date.parse(db.channels[db.channels.length - 1].t) : 0
  if (force || now - lastCh > MIN_GAP_MIN * 60000) {
    const ch = await channelCounts(cfg, log)
    if (Object.keys(ch).length) {
      db.channels.push({ t: new Date(now).toISOString(), ...ch })
      const weekAgo = now - 7 * 86400000; const kept = []; let lastDay = ''
      for (const c of db.channels) { if (Date.parse(c.t) > weekAgo) kept.push(c); else { const d = c.t.slice(0, 10); if (d !== lastDay) { kept.push(c); lastDay = d } } }
      db.channels = kept
    }
  }
  // retention and traffic sources: once a day per film, youngest first, at most 15 an hour
  let asked = 0
  for (const f of cat.slice().sort((a, b) => String(b.published).localeCompare(String(a.published)))) {
    if (asked >= 15 || !(cfg.youtube && cfg.youtube.refresh_token)) break
    const v = db.videos[f.id] || (db.videos[f.id] = { samples: [] })
    const age = now - Date.parse(f.published || 0)
    if (age > 90 * 86400000) continue
    if (v.retention && now - Date.parse(v.retention.t) < 20 * 3600000 && !force) continue
    const r = await youtubeRetention(cfg, f.id, f.published, log); asked++
    if (r) { v.retention = r; v.retention_stored = false }
  }
  let n = 0
  for (const f of due) {
    const v = db.videos[f.id] || (db.videos[f.id] = { samples: [] })
    Object.assign(v, { title: f.title, kind: f.kind, short: f.short, published: f.published, privacy: f.privacy, players: f.players, number: f.number, instagram_id: f.instagram_id, tiktok_id: f.tiktok_id, features: f.features || v.features || null })
    if (yt[f.id] && yt[f.id].seconds) v.seconds = yt[f.id].seconds
    const sample = { t: new Date(now).toISOString() }
    // what happened to the upload: a rejection, a block, a vanished video (a mute cannot be seen here)
    const y = yt[f.id]
    if (y) {
      const was = v.trouble || []
      const note = (platform, what) => { if (!was.some(x => x.platform === platform && x.what === what)) { was.push({ platform, what, at: new Date(now).toISOString() }); log(`${platform}: "${f.title}" ${what}`); if (platform === 'youtube' && /copyright|claim|missing|rejected|blocked/i.test(what)) { try { require('./music_health').strike(f.id, what, 'scan') } catch { /* no film record */ } } } }
      if (y.missing) note('youtube', 'missing: the video is gone from YouTube')
      else if (y.status) {
        v.status = y.status
        if (y.status.rejection) note('youtube', `rejected: ${y.status.rejection}`)
        if (y.status.blocked_regions) note('youtube', `blocked in ${y.status.blocked_regions} regions`)
        if (y.status.privacy && y.status.privacy !== (f.privacy || 'public')) note('youtube', `privacy changed to ${y.status.privacy}`)
      }
      if (was.length) v.trouble = was
    }
    if (yt[f.id] && !yt[f.id].missing) { const { seconds, status, ...rest } = yt[f.id]; sample.yt = rest }
    if (ig[f.id]) sample.ig = ig[f.id]
    if (tt[f.id]) sample.tt = tt[f.id]
    if (!sample.yt && !sample.ig && !sample.tt) continue
    v.samples.push(sample); n++
    // hourly for a week, then one a day
    const weekAgo = now - 7 * 86400000
    const kept = []; let lastDay = ''
    for (const s of v.samples) { const t = Date.parse(s.t); if (t > weekAgo) kept.push(s); else { const d = s.t.slice(0, 10); if (d !== lastDay) { kept.push(s); lastDay = d } } }
    v.samples = kept
  }
  write(db)
  // the strategies' scores follow from the films' numbers
  try { const sc = require('../strategy/score'); sc.compute(); await sc.mirror() } catch (e) { log('scores: ' + e.message.slice(0, 120)) }
  try { await require('../media').mirror() } catch { /* best effort */ }
  try { fs.writeFileSync(REPORT, report(db)) } catch { /* the file is a convenience */ }
  // and into the database, with every sample it does not have yet (so a scan while it was down is caught up)
  let stored = false
  try {
    const mongo = require('./db')
    const films = cat.map(f => { const v = db.videos[f.id] || {}; const last = v.samples && v.samples[v.samples.length - 1]; const film = (require('./films').read().films || []).find(x => x.id === f.id) || {}; return { ...f, logline: film.logline || null, links: film.links || null, seconds: v.seconds || null, retention: v.retention ? { ...v.retention, t: new Date(v.retention.t) } : null, latest: last ? { t: new Date(last.t), yt: last.yt || null, ig: last.ig || null, tt: last.tt || null, views: views(last) } : null } })
    const chans = (db.channels || []).filter(c => !c.stored).map(c => ({ ...c, t: new Date(c.t) }))
    if (chans.length) { try { const client = await mongo.connect(cfg); await client.db().collection('channel_samples').insertMany(chans, { ordered: false }); for (const c of db.channels) c.stored = true } catch (e) { if (!/duplicate key/i.test(e.message)) log('mongo: channels ' + e.message.slice(0, 100)) } }
    const samples = []
    for (const [id, v] of Object.entries(db.videos)) for (const sm of v.samples) if (!sm.stored) samples.push({ video_id: id, t: sm.t, yt: sm.yt || null, ig: sm.ig || null, tt: sm.tt || null, views: views(sm) })
    stored = await mongo.record(cfg, films, samples, log)
    if (stored) { for (const v of Object.values(db.videos)) for (const sm of v.samples) sm.stored = true; write(db) }
    await mongo.close()
  } catch (e) { log('mongo: ' + e.message.slice(0, 120)) }
  return { sampled: n, videos: cat.length, stored }
}

// ---- reading it back -------------------------------------------------------------------------

const views = s => (s.yt ? s.yt.views : 0) + (s.ig ? s.ig.views : 0) + (s.tt ? s.tt.views : 0)
function at (samples, msAgo) { // the last sample at or before that moment
  const cut = Date.now() - msAgo
  let best = null
  for (const s of samples) if (Date.parse(s.t) <= cut) best = s
  return best || samples[0]
}

function summary (db = read()) {
  let scores = { films: {} }; try { scores = require('../strategy/score').load() } catch { /* none */ }
  const vids = Object.entries(db.videos).map(([id, v]) => {
    const last = v.samples[v.samples.length - 1]
    if (!last) return null
    const day = at(v.samples, 86400000); const week = at(v.samples, 7 * 86400000)
    const total = views(last)
    const ageH = (Date.now() - Date.parse(v.published || last.t)) / 3600000
    return {
      id, title: v.title, number: v.number, short: v.short, kind: v.kind, published: v.published, players: v.players, seconds: v.seconds || null,
      youtube: last.yt || null, instagram: last.ig || null, tiktok: last.tt || null,
      retention: v.retention ? { relative: v.retention.relative || null, half_gone_at: v.retention.half_gone_at, steepest_drop: v.retention.steepest_drop || null, traffic: v.retention.traffic || null, curve: v.retention.curve || null } : null,
      total, day: total - (day ? views(day) : total), week: total - (week ? views(week) : total),
      hour: total - (v.samples.length > 1 ? views(at(v.samples, 3600000)) : total), hour_since: v.samples.length > 1 ? at(v.samples, 3600000).t : null,
      strategy: (v.features && v.features.strategy_id) || 'default', film_score: (scores.films[id] && scores.films[id].score !== undefined) ? scores.films[id].score : null,
      plan: v.features && v.features.plan ? { voice: v.features.plan.narrator_voice, wpm: v.features.plan.words_per_min, segments: v.features.plan.segments, lines: v.features.plan.lines, player_lines: v.features.plan.player_lines, opening: v.features.plan.hook ? v.features.plan.hook.first_line : null, finale: v.features.plan.music ? v.features.plan.music.finale : null, moods: v.features.plan.music ? v.features.plan.music.moods : [] } : null,
      status: v.status || null, trouble: v.trouble || [],
      per_day: ageH > 1 ? +(total / Math.max(1, ageH / 24)).toFixed(1) : total,
      sampled: last.t, age_hours: Math.round(ageH),
      // a small line: total views at up to 24 points over the last week
      series: v.samples.slice(-168).filter((s, i, a) => a.length <= 24 || i % Math.ceil(a.length / 24) === 0 || i === a.length - 1).map(s => [s.t, views(s)])
    }
  }).filter(Boolean).sort((a, b) => String(b.published).localeCompare(String(a.published)))
  const sum = k => vids.reduce((n, v) => n + (v[k] || 0), 0)
  const plat = { youtube: vids.reduce((n, v) => n + (v.youtube ? v.youtube.views : 0), 0), instagram: vids.reduce((n, v) => n + (v.instagram ? v.instagram.views : 0), 0), tiktok: vids.reduce((n, v) => n + (v.tiktok ? v.tiktok.views : 0), 0) }
  const best = vids.slice().sort((a, b) => b.total - a.total)[0] || null
  const shorts = vids.filter(v => v.short); const longs = vids.filter(v => !v.short)
  const avg = list => list.length ? Math.round(list.reduce((n, v) => n + v.total, 0) / list.length) : 0
  // when counting began: a "last 24 hours" figure can only reach back this far
  const first = Object.values(db.videos).flatMap(v => v.samples.map(x => x.t)).sort()[0] || null
  const chs = db.channels || []
  const chLast = chs[chs.length - 1] || null
  const chAt = ms => { const cut = Date.now() - ms; let b = null; for (const c of chs) if (Date.parse(c.t) <= cut) b = c; return b || chs[0] }
  const channels = {}
  if (chLast) for (const p of ['youtube', 'instagram', 'tiktok']) if (chLast[p]) {
    const d = chAt(86400000); const w = chAt(7 * 86400000)
    channels[p] = { ...chLast[p], followers_day: chLast[p].followers - ((d && d[p]) ? d[p].followers : chLast[p].followers), followers_week: chLast[p].followers - ((w && w[p]) ? w[p].followers : chLast[p].followers) }
  }
  // Channel-wide trends for the overview's cards: the sum over every film at each half-hour step of
  // the last 7 days (a film not yet sampled at a step counts its last known number), the new views
  // in each hour of the last day and in each day of the week, each platform's total, and the
  // followers of each account. Every card that moves gets a line; the static ones do not.
  const trends = (() => {
    const STEP = 30 * 60000; const now = Date.now(); const start = now - 7 * 86400000
    const steps = []; for (let t = Math.ceil(start / STEP) * STEP; t <= now; t += STEP) steps.push(t)
    const per = Object.values(db.videos).map(v => v.samples.map(sm => [Date.parse(sm.t), sm]).filter(x => !isNaN(x[0])).sort((a, b) => a[0] - b[0]))
    const sumAt = (t, pick) => { let n = 0; for (const list of per) { let last = null; for (const x of list) { if (x[0] <= t) last = x[1]; else break } if (last) n += pick(last) } return n }
    const total = steps.map(t => [new Date(t).toISOString(), sumAt(t, views)]).filter((x, i, a) => x[1] > 0 || (i > 0 && a[i - 1][1] > 0))
    const byPlat = {}
    for (const [k, key] of [['youtube', 'yt'], ['instagram', 'ig'], ['tiktok', 'tt']]) byPlat[k] = steps.map(t => [new Date(t).toISOString(), sumAt(t, sm => sm[key] ? sm[key].views : 0)]).filter(x => x[1] > 0)
    // new views in a window: only where counting had begun at both ends (a null is a gap, not a zero)
    const firstT = Math.min(...per.flatMap(l => l.length ? [l[0][0]] : [Infinity]))
    const delta = (t, span) => { const base = t >= firstT ? t : firstT; if (base >= t + span) return null; const a = sumAt(base, views); const b = sumAt(t + span, views); return a > 0 ? Math.max(0, b - a) : null }
    const hourly = []; for (let t = now - 24 * 3600000; t < now; t += 3600000) hourly.push([new Date(t + 3600000).toISOString(), delta(t, 3600000)])
    const daily = []; for (let t = now - 7 * 86400000; t < now; t += 86400000) daily.push([new Date(t + 86400000).toISOString(), delta(t, 86400000)])
    const followers = {}
    for (const p of ['youtube', 'instagram', 'tiktok']) followers[p] = chs.filter(c => c[p] && Date.parse(c.t) > start).map(c => [c.t, c[p].followers])
    return { total, hourly, daily, by_platform: byPlat, followers }
  })()
  let strategies = []
  try { strategies = require('../strategy/score').table() } catch { strategies = [] }
  let music = []
  try { music = require('./music_health').status() } catch { music = [] }
  let media = []
  try { media = require('../media').catalogue() } catch { media = [] }
  return {
    updated: db.updated || null, videos: vids.length, first_sample: first, channels, strategies, music, media, trends,
    counts: { shorts: shorts.length, videos: longs.length },
    totals: { views: sum('total'), hour: sum('hour'), hour_since: vids.map(v => v.hour_since).filter(Boolean).sort()[0] || null, day: sum('day'), week: sum('week'), by_platform: plat, likes: vids.reduce((n, v) => n + (v.youtube ? v.youtube.likes : 0) + (v.instagram ? v.instagram.likes : 0) + (v.tiktok ? v.tiktok.likes : 0), 0) },
    best: best ? { id: best.id, title: best.title, total: best.total } : null,
    average: { all: avg(vids), shorts: avg(shorts), videos: avg(longs) },
    list: vids
  }
}

// A plain-words digest the planner can be given later ("what kind of film does well here"),
// rewritten after every scan: automation/performance.md.
function report (db = read()) {
  const s = summary(db)
  if (!s.videos) return '# How the films are doing\n\nNo numbers yet.\n'
  const lines = [`# How the films are doing (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`, '',
    `${s.videos} films, ${s.totals.views} views in all (YouTube ${s.totals.by_platform.youtube}, Instagram ${s.totals.by_platform.instagram}, TikTok ${s.totals.by_platform.tiktok}); ${s.totals.day} in the last day, ${s.totals.week} in the last week.`,
    `Average per film: ${s.average.all} (Shorts ${s.average.shorts}, full videos ${s.average.videos}).`, '']
  if (s.best) lines.push(`Best so far: "${s.best.title}" with ${s.best.total} views.`, '')
  lines.push('| film | shape | players | length | views | last day | per day | yt avg watched |', '|---|---|---|---|---|---|---|---|')
  for (const v of s.list) lines.push(`| ${v.title} | ${v.short ? 'Short' : 'video'} | ${v.players || '?'} | ${v.seconds ? v.seconds + ' s' : '?'} | ${v.total} | ${v.day} | ${v.per_day} | ${v.youtube && v.youtube.avg_pct ? v.youtube.avg_pct + '%' : '?'} |`)
  // what seems to work: by match size and by length, only once there is enough to compare
  const groups = (key, label) => {
    const g = {}
    for (const v of s.list) { const k = key(v); if (k === null) continue; (g[k] = g[k] || []).push(v.per_day) }
    const rows = Object.entries(g).filter(([, a]) => a.length >= 2).map(([k, a]) => `${label} ${k}: ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)} views a day on average (${a.length} films)`)
    return rows
  }
  const obs = [...groups(v => v.players ? (v.players <= 3 ? '2-3' : v.players <= 9 ? '4-9' : '10+') : null, 'players'), ...groups(v => v.seconds ? (v.seconds <= 60 ? 'under 1 min' : v.seconds <= 120 ? '1-2 min' : v.seconds <= 180 ? '2-3 min' : 'over 3 min') : null, 'length')]
  if (obs.length) lines.push('', '## What seems to work', '', ...obs.map(o => '- ' + o))
  try {
    const tab = require('../strategy/score').table()
    if (tab.length) {
      lines.push('', '## Edit strategies', '', 'Score 0-1: 60% how well the film held viewers, 30% first-48-hour views against the films before it, 10% likes/shares/saves per view. A strategy is only judged on 5+ films.', '', '| strategy | films | score | last 3 | spread | status |', '|---|---|---|---|---|---|')
      for (const t of tab) lines.push(`| ${t.name} (${t.id}) | ${t.films} | ${t.mean !== null ? t.mean.toFixed(2) : '-'} | ${t.recent !== null ? t.recent.toFixed(2) : '-'} | ${t.spread !== null ? t.spread.toFixed(2) : '-'} | ${t.ready ? 'judged' : 'learning'}${t.status === 'retired' ? ', retired' : ''} |`)
    }
  } catch { /* no strategies yet */ }
  return lines.join('\n') + '\n'
}

module.exports = { FILE, REPORT, catalogue, scan, summary, report, read }
