'use strict'
// The edit strategies: the recipes a match film is planned under. The live set lives in
// automation/strategies.json (seeded from config/edit_strategies.json the first time, and
// whenever a seed id is missing), mirrored to MongoDB `edit_strategies` when it is reachable.
// Scores are not stored here; lib/strategy/score.js works them out from the films.
const fs = require('fs')
const path = require('path')
const U = require('../util')

const SEEDS = path.join(U.ROOT, 'config', 'edit_strategies.json')
const LIVE = path.join(U.ROOT, 'automation', 'strategies.json')

function seeds () { try { return U.readJson(SEEDS).strategies || [] } catch { return [] } }

function load () {
  let live = { strategies: [] }
  try { if (U.exists(LIVE)) live = U.readJson(LIVE) } catch { live = { strategies: [] } }
  let changed = false
  for (const s of seeds()) {
    if (!live.strategies.some(x => x.id === s.id)) { live.strategies.push({ ...s, created: new Date().toISOString(), seed: true }); changed = true }
  }
  if (changed || !U.exists(LIVE)) save(live)
  return live
}

function save (live) {
  fs.mkdirSync(path.dirname(LIVE), { recursive: true })
  live.updated = new Date().toISOString()
  U.writeJson(LIVE, live)
  mirror(live).catch(() => {})
  return live
}

async function mirror (live) {
  try {
    const mongo = require('../publish/db')
    const client = await mongo.connect({})
    const col = client.db().collection('edit_strategies')
    if (live.strategies.length) await col.bulkWrite(live.strategies.map(s => ({ updateOne: { filter: { _id: s.id }, update: { $set: { ...s, updated: new Date() } }, upsert: true } })), { ordered: false })
    await mongo.close()
    return true
  } catch { return false }
}

function get (id) { return load().strategies.find(s => s.id === id) || null }
function active () { return load().strategies.filter(s => s.status !== 'retired') }

// A new strategy made from an old one by changing something, with the reason kept.
function derive (parentId, changes, { id, name, notes } = {}) {
  const live = load()
  const parent = live.strategies.find(s => s.id === parentId)
  if (!parent) throw new Error(`no strategy ${parentId}`)
  const child = { ...JSON.parse(JSON.stringify(parent)), id: id || `${parentId}-v${(parent.version || 1) + 1}`, name: name || parent.name, parent: parentId, version: (parent.version || 1) + 1, status: 'active', created: new Date().toISOString(), seed: false, notes: notes || '' }
  deepMerge(child, changes)
  live.strategies.push(child)
  save(live)
  record({ at: child.created, by: 'ai', id: child.id, version: child.version, kind: 'derive', note: notes || '', parent: parentId, changes: diff(parent, child).filter(c => !['id', 'name', 'parent', 'version', 'status', 'created', 'seed', 'notes'].includes(c.path)) })
  return child
}
function deepMerge (a, b) { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') deepMerge(a[k], v); else a[k] = v } return a }

function retire (id, why, by = 'ai') { const live = load(); const s = live.strategies.find(x => x.id === id); if (!s) throw new Error(`no strategy ${id}`); s.status = 'retired'; s.retired = { at: new Date().toISOString(), why: why || '' }; save(live); record({ at: s.retired.at, by, id, version: s.version || 1, kind: 'retire', note: why || '', changes: [{ path: 'status', from: 'active', to: 'retired' }] }); return s }

// Every change to a strategy, by Tabor on the admin page or by the planner's own experiments,
// is one entry here: who, when, why, and exactly which fields changed. The same log for both,
// so the record of what was tried reads the same whoever tried it.
const HISTORY = path.join(path.dirname(LIVE), 'strategy_history.json')
function history (id = null) {
  let all = []; try { all = U.readJson(HISTORY).edits || [] } catch { /* none yet */ }
  return id ? all.filter(e => e.id === id) : all
}
function record (entry) {
  const all = history()
  all.push(entry)
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true })
  U.writeJson(HISTORY, { edits: all.slice(-2000) })
  ;(async () => { try { const mongo = require('../publish/db'); const client = await mongo.connect({}); await client.db().collection('strategy_edits').insertOne({ ...entry, stored: new Date() }); await mongo.close() } catch { /* best effort */ } })()
  return entry
}
// the paths whose values differ between two objects, with both values
function diff (a, b, prefix = '') {
  const out = []
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const k of keys) {
    const x = a ? a[k] : undefined; const y = b ? b[k] : undefined
    const p = prefix ? prefix + '.' + k : k
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) out.push(...diff(x, y, p))
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: p, from: x === undefined ? null : x, to: y === undefined ? null : y })
  }
  return out
}
// Replace a strategy with an edited copy: the id stays, the version goes up, the change is logged.
function edit (id, next, { by = 'ai', note = '' } = {}) {
  const live = load()
  const i = live.strategies.findIndex(s => s.id === id)
  if (i < 0) throw new Error(`no strategy ${id}`)
  if (!next || typeof next !== 'object' || !next.knobs || typeof next.knobs !== 'object') throw new Error('a strategy needs a knobs object')
  const before = live.strategies[i]
  const after = { ...JSON.parse(JSON.stringify(next)), id, version: (before.version || 1) + 1, edited: new Date().toISOString(), edited_by: by }
  const changes = diff(before, after).filter(c => !['version', 'edited', 'edited_by'].includes(c.path))
  if (!changes.length) return { strategy: before, changes: [] }
  live.strategies[i] = after
  save(live)
  record({ at: after.edited, by, id, version: after.version, kind: 'edit', note, changes })
  return { strategy: after, changes }
}

module.exports = { SEEDS, LIVE, HISTORY, load, save, get, active, derive, retire, seeds, edit, history, record, diff }
