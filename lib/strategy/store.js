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
  return child
}
function deepMerge (a, b) { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') deepMerge(a[k], v); else a[k] = v } return a }

function retire (id, why) { const live = load(); const s = live.strategies.find(x => x.id === id); if (!s) throw new Error(`no strategy ${id}`); s.status = 'retired'; s.retired = { at: new Date().toISOString(), why: why || '' }; save(live); return s }

module.exports = { SEEDS, LIVE, load, save, get, active, derive, retire, seeds }
