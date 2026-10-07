'use strict'
// How each strategy is doing, worked out from the films made under it and their numbers.
// One film is noise; a strategy is judged on several (MIN_FILMS in lib/strategy/select.js),
// and on numbers that do not swing with the feed's mood:
//   hold   0.6  how well the film kept viewers: YouTube's relative retention (0-1, against
//               videos of that length across YouTube), else its % watched
//   reach  0.3  views in the first 48 hours, divided by the median first-48-hour views of the
//               ten films before it (so a generous day does not crown a film); squashed to 0-1
//   engage 0.1  likes + shares + saves + comments per view, all platforms, squashed to 0-1
// Missing parts drop out and the rest is re-weighted. Films before strategies existed count
// toward "default". Written to automation/strategy_scores.json and MongoDB edit_strategies.
const fs = require('fs')
const path = require('path')
const U = require('../util')

const FILE = path.join(U.ROOT, 'automation', 'strategy_scores.json')
const W = { hold: 0.6, reach: 0.3, engage: 0.1 }

const sum = s => (s.yt ? s.yt.views : 0) + (s.ig ? s.ig.views : 0) + (s.tt ? s.tt.views : 0)
function at (samples, t) { let b = null; for (const s of samples) if (Date.parse(s.t) <= t) b = s; return b }

// views in the first 48 hours (or so far, if younger), from the hourly samples
function early (v) {
  if (!v.samples || !v.samples.length) return null
  const pub = Date.parse(v.published || v.samples[0].t)
  const s = at(v.samples, pub + 48 * 3600000) || v.samples[v.samples.length - 1]
  return { views: sum(s), hours: Math.min(48, (Date.parse(s.t) - pub) / 3600000) }
}

function filmScore (v, baseline) {
  const last = v.samples && v.samples[v.samples.length - 1]
  if (!last) return null
  const parts = {}
  if (v.retention && typeof v.retention.relative === 'number') parts.hold = Math.max(0, Math.min(1, v.retention.relative))
  else if (last.yt && last.yt.avg_pct) parts.hold = Math.max(0, Math.min(1, last.yt.avg_pct / 100))
  const e = early(v)
  if (e && e.hours >= 6 && baseline > 0) { const r = (e.views / Math.max(1, e.hours / 48)) / baseline; parts.reach = r / (1 + r) }
  const views = sum(last)
  if (views >= 20) {
    const eng = ['yt', 'ig', 'tt'].reduce((n, p) => n + (last[p] ? (last[p].likes || 0) + (last[p].shares || 0) + (last[p].saved || 0) + (last[p].comments || 0) : 0), 0) / views
    parts.engage = Math.min(1, eng * 20)
  }
  const keys = Object.keys(parts)
  if (!keys.length) return null
  const wsum = keys.reduce((n, k) => n + W[k], 0)
  const score = keys.reduce((n, k) => n + parts[k] * W[k], 0) / wsum
  return { score: +score.toFixed(3), parts, early: e ? { views: e.views, hours: Math.round(e.hours) } : null, views }
}

function compute () {
  const stats = require('../publish/stats').read()
  const films = (require('../publish/films').read().films || []).slice().sort((a, b) => String(a.published).localeCompare(String(b.published)))
  const perFilm = {}
  const history = [] // first-48h views of films so far, in upload order, for the rolling median
  for (const f of films) {
    const v = stats.videos[f.id]
    if (!v) continue
    const prev = history.slice(-10)
    const baseline = prev.length >= 3 ? prev.slice().sort((a, b) => a - b)[Math.floor(prev.length / 2)] : 0
    const sc = filmScore({ ...v, published: f.published }, baseline)
    const e = early({ ...v, published: f.published })
    if (e && e.hours >= 24) history.push(e.views)
    const sid = (f.features && f.features.strategy_id) || 'default'
    perFilm[f.id] = { title: f.title, strategy: sid, published: f.published, short: !!f.short, ...(sc || { score: null }) }
  }
  const strategies = {}
  for (const [id, r] of Object.entries(perFilm)) {
    const s = strategies[r.strategy] || (strategies[r.strategy] = { n: 0, scored: 0, films: [], scores: [] })
    s.n++; s.films.push(id)
    if (r.score !== null) { s.scored++; s.scores.push(r.score) }
  }
  for (const s of Object.values(strategies)) {
    if (s.scores.length) {
      s.mean = +(s.scores.reduce((a, b) => a + b, 0) / s.scores.length).toFixed(3)
      const m = s.mean; s.spread = +Math.sqrt(s.scores.reduce((a, b) => a + (b - m) * (b - m), 0) / s.scores.length).toFixed(3)
      s.recent = +(s.scores.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, s.scores.length)).toFixed(3)
    }
    delete s.scores
  }
  const out = { updated: new Date().toISOString(), weights: W, films: perFilm, strategies }
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  U.writeJson(FILE, out)
  return out
}

function load () { try { return U.exists(FILE) ? U.readJson(FILE) : { films: {}, strategies: {} } } catch { return { films: {}, strategies: {} } } }

// the strategy table for performance.md / the admin page
function table (scores = load()) {
  const store = require('./store')
  return store.load().strategies.map(s => { const sc = scores.strategies[s.id] || {}; return { id: s.id, name: s.name, status: s.status || 'active', parent: s.parent || null, films: sc.n || 0, scored: sc.scored || 0, mean: sc.mean !== undefined ? sc.mean : null, recent: sc.recent !== undefined ? sc.recent : null, spread: sc.spread !== undefined ? sc.spread : null, ready: (sc.n || 0) >= require('./select').MIN_FILMS } })
}

async function mirror (scores = load()) {
  try {
    const mongo = require('../publish/db'); const client = await mongo.connect({}); const db = client.db()
    const ops = Object.entries(scores.strategies).map(([id, s]) => ({ updateOne: { filter: { _id: id }, update: { $set: { score: s, scored_at: new Date() } } } }))
    if (ops.length) await db.collection('edit_strategies').bulkWrite(ops, { ordered: false })
    const fops = Object.entries(scores.films).map(([id, r]) => ({ updateOne: { filter: { _id: id }, update: { $set: { score: r.score, score_parts: r.parts || null, strategy_id: r.strategy } } } }))
    if (fops.length) await db.collection('films').bulkWrite(fops, { ordered: false })
    await mongo.close(); return true
  } catch { return false }
}

module.exports = { FILE, W, compute, load, table, mirror, filmScore }
