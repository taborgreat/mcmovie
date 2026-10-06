'use strict'
// Discrete events are impulses, never states to interpolate across a replay.
function between (events, previous, now) {
  let lo = 0; let hi = events.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid].t <= previous) lo = mid + 1; else hi = mid }
  const out = []
  for (let i = lo; i < events.length && events[i].t <= now; i++) out.push(events[i])
  return out
}
const indexes = new WeakMap()
function pulses (rec, player, previous, now) {
  if (!indexes.has(rec)) {
    const byPlayer = rec.players.map(p => ({ swing: p.track.filter(s => s.flags & 256), hurt: [] }))
    for (const e of rec.events) {
      if (!(e.dmg > 0)) continue
      if ((e.type === 'hit' || e.type === 'mobhit') && byPlayer[e.a]) byPlayer[e.a].swing.push(e)
      if ((e.type === 'hit' || e.type === 'dmg') && byPlayer[e.v]) byPlayer[e.v].hurt.push(e)
    }
    for (const p of byPlayer) { p.swing.sort((a, b) => a.t - b.t); p.hurt.sort((a, b) => a.t - b.t) }
    indexes.set(rec, byPlayer)
  }
  const p = indexes.get(rec)[player]
  return {
    swing: between(p.swing, previous, now).length > 0,
    hurt: between(p.hurt, previous, now).length > 0
  }
}

// Keep source identities separate from transport names and human-readable labels.
function identities (players) {
  const { offlineUUID } = require('../util')
  return players.map((p, i) => ({
    id: p.name, uuid: p.uuid || null, anon: !!p.anon,
    bot: `FilmActor${i + 1}`,
    display: String(p.name).replace(/^\./, ''),
    // An offline test identity is not proof of ownership of a same-named Java
    // account. A skin lookup would either fail or borrow that unrelated skin.
    skin: p.anon || String(p.name).startsWith('.') || String(p.uuid).toLowerCase() === offlineUUID(p.name) ? null : p.name,
    kit: p.kit || 'none'
  }))
}
module.exports = { between, pulses, identities }
