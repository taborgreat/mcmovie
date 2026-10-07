'use strict'
// The processing layer between a raw recording and the storyteller.
//
// The LLM never reads tracks or raw events. It gets a hierarchy:
//   digest.md           the SKELETON: who won, the ending, the winner's road
//                       told backwards, the kill tree, every player in one
//                       line, side moments for players off the main road,
//                       and an index of moments with one-line summaries.
//   moments/<id>.md     ZOOM: one file per moment (a fight, a kill, a mob
//                       attack, a fall, the drop, the ending) with the blow
//                       by blow, where it happened, who was nearby, what
//                       was said, and a suggested film segment.
// The storyteller reads the skeleton, works backwards from the winner,
// picks a few side moments, and opens only the moment files it will use.
const fs = require('fs')
const path = require('path')
const U = require('../util')
const R = require('./recording')

function mmss (ticks) {
  const s = Math.max(0, Math.round(ticks / 20))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const sec = (ticks) => +(ticks / 20).toFixed(1)
const clean = (n) => String(n).replace(/^\./, '')

function distanceTravelled (track) {
  let d = 0
  for (let i = 1; i < track.length; i++) {
    const step = Math.hypot(track[i].x - track[i - 1].x, track[i].z - track[i - 1].z)
    if (step / Math.max(1, track[i].t - track[i - 1].t) < 1.5) d += step
  }
  return Math.round(d)
}

// Group hits between the same two players into fights (gaps under 10 s).
function findFights (rec) {
  const hits = rec.events.filter(e => e.type === 'hit' && e.a !== undefined)
  const open = new Map(); const fights = []
  for (const h of hits) {
    const key = [Math.min(h.a, h.v), Math.max(h.a, h.v)].join('-')
    let f = open.get(key)
    if (!f || h.t - f.end > 200) {
      f = { a: Math.min(h.a, h.v), b: Math.max(h.a, h.v), start: h.t, end: h.t, hits: {}, dmg: {}, minHp: {}, blows: [] }
      open.set(key, f); fights.push(f)
    }
    f.end = h.t
    f.hits[h.a] = (f.hits[h.a] || 0) + 1
    f.dmg[h.a] = Math.round(((f.dmg[h.a] || 0) + h.dmg) * 10) / 10
    f.minHp[h.v] = Math.min(f.minHp[h.v] === undefined ? 20 : f.minHp[h.v], h.hp)
    f.blows.push(h)
  }
  for (const f of fights) {
    const death = rec.events.find(e => e.type === 'death' && (e.v === f.a || e.v === f.b) && e.t >= f.start && e.t <= f.end + 100)
    f.death = death ? death.v : null
    f.deathEvent = death || null
    const tr = rec.players[f.a].track
    const s = tr.find(x => x.t >= f.start) || tr[tr.length - 1]
    if (s) { f.x = Math.round(s.x); f.y = Math.round(s.y); f.z = Math.round(s.z) }
  }
  return fights
}

function findMobAttacks (rec) {
  const open = new Map(); const out = []
  for (const h of rec.events.filter(e => e.type === 'hit' && e.mob)) {
    const key = h.v + ':' + h.mob
    let m = open.get(key)
    if (!m || h.t - m.end > 200) { m = { v: h.v, mob: h.mob, start: h.t, end: h.t, hits: 0, minHp: 20, blows: [] }; open.set(key, m); out.push(m) }
    m.end = h.t; m.hits++; m.minHp = Math.min(m.minHp, h.hp); m.blows.push(h)
  }
  for (const m of out) {
    const death = rec.events.find(e => e.type === 'death' && e.v === m.v && e.k === undefined && e.t >= m.start && e.t <= m.end + 60)
    m.deathEvent = death || null
  }
  return out
}

// Where a moment happened, in words a narrator can use.
function describePlace (world, x, y, z) {
  const place = { pos: [Math.round(x), Math.round(y), Math.round(z)] }
  if (!world) return place
  try {
    const surface = world.groundY(Math.floor(x), Math.floor(z), 250)
    let cover = 0
    for (let yy = Math.floor(y) + 2; yy <= Math.floor(y) + 24; yy++) { const id = world.stateIdAt(Math.floor(x), yy, Math.floor(z)); if (id && world.isSolid(x, yy, z) && !world.blockName(id).endsWith('leaves')) cover++ }
    place.surface_y = surface
    place.underground = cover > 0 && surface !== null && surface - y > 4
    place.depth = place.underground ? Math.round(surface - y) : 0
    place.under_cover = cover > 0
    place.biome = world.biomeAt(Math.floor(x), Math.floor(y), Math.floor(z))
    const feet = world.blockName(world.stateIdAt(Math.floor(x), Math.floor(y) - 1, Math.floor(z)))
    if (feet && feet !== 'air') place.standing_on = feet
  } catch { /* outside the saved map */ }
  return place
}

function placeWords (p) {
  if (!p) return ''
  const bits = [`${p.pos.join(',')}`]
  if (p.underground) bits.push(`underground, ${p.depth} blocks below the surface (a cave or tunnel)`)
  else if (p.under_cover) bits.push('under an overhang or roof')
  else if (p.surface_y !== undefined) bits.push('open ground')
  if (p.biome) bits.push(`${p.biome.replace(/_/g, ' ')} biome`)
  if (p.standing_on) bits.push(`on ${p.standing_on.replace(/_/g, ' ')}`)
  return bits.join('; ')
}

function build (rec, world) {
  const P = rec.players
  const name = (i) => (P[i] ? P[i].name : '?')
  const kit = (i) => (P[i] ? P[i].kit : '?')
  const total = rec.meta.ticks
  const deaths = rec.events.filter(e => e.type === 'death')
  const eliminated = rec.events.filter(e => e.type === 'eliminated')
  const states = rec.events.filter(e => e.type === 'state')
  const chats = rec.events.filter(e => e.type === 'chat')
  for (const d of deaths) {
    if (d.k === undefined && !d.mob) {
      const lastHit = rec.events.filter(e => e.type === 'hit' && e.v === d.v && e.t <= d.t && e.t > d.t - 60).pop()
      if (lastHit && lastHit.mob) d.mob = lastHit.mob
    }
  }
  const fights = findFights(rec)
  const mobs = findMobAttacks(rec)
  const lastDeath = deaths[deaths.length - 1] || null
  // What this match is, in a few labels, so the strategy chooser and the planner start from the
  // right story. Tabor: a match full of typed dialogue is a dialogue film, not two creeper
  // explosions; mobs are scenery unless one kills somebody.
  const traits = (() => {
    const hits = rec.events.filter(e => e.type === 'hit')
    const pvp = hits.filter(e => e.a !== undefined && e.v !== undefined && !e.mob && e.me === undefined).length
    const mobHits = hits.filter(e => e.mob || e.me !== undefined).length + rec.events.filter(e => e.type === 'mobhit').length
    const chatters = new Set(chats.map(c => c.name)).size
    const fightTicks = fights.reduce((n, f) => n + Math.max(0, f.end - f.start), 0)
    const kills = {}; for (const d of deaths) if (d.k !== undefined) kills[d.k] = (kills[d.k] || 0) + 1
    const streak = Math.max(0, ...Object.values(kills))
    const mobDeaths = deaths.filter(d => d.k === undefined && d.mob).length
    const labels = []
    if (chats.length >= 12 || (chats.length >= 6 && chatters >= 3)) labels.push('chat-heavy')
    // a match that was really a conversation (a roleplay, a picnic, a love story typed out): the
    // film is the dialogue, every exchange shown and heard
    if (chats.length >= 20 && chatters >= 2) labels.push('dialogue')
    if (fights.length <= 2 && P.length <= 4) labels.push('duel')
    if (streak >= 3) labels.push('rampage')
    if (mobHits > pvp * 1.5 && mobHits >= 10) labels.push('mob-heavy')
    if (fightTicks < total * 0.15 && pvp < 12 && !labels.includes('dialogue')) labels.push('quiet')
    if (fights.length >= 4 && P.length >= 6) labels.push('brawl')
    if (mobDeaths >= 2) labels.push('mob-deaths')
    return { chat_lines: chats.length, chatters, pvp_hits: pvp, mob_hits: mobHits, fights: fights.length, fight_share: +(fightTicks / Math.max(1, total)).toFixed(2), biggest_streak: streak, mob_deaths: mobDeaths, labels }
  })()
  const posOf = (i, t) => { const s = P[i] ? R.sampleAt(P[i].track, t, 60) : null; return s || (P[i] && P[i].track.length ? P[i].track[P[i].track.length - 1] : null) }

  // ---- placements
  const order = []
  for (const e of eliminated) if (!order.includes(e.p)) order.push(e.p)
  const placement = new Map()
  order.forEach((p, i) => placement.set(p, P.length - i))
  const winnerIdx = P.findIndex(p => p.name === rec.meta.winner)
  const runnerUpIdx = order.length ? order[order.length - 1] : -1

  // ---- moments
  // A kill made by a kit is the kit's kill, whatever happened to be in the hand: a Stomper who
  // lands on someone holding a ladder stomped them, he did not kill them with a ladder. The
  // plugin's record of the kit firing (and the server's own death message, when recorded) wins.
  for (const d of deaths) {
    if (d.k === undefined) continue
    const fired = rec.events.find(e => e.type === 'ability' && e.p === d.k && e.t >= d.t - 40 && e.t <= d.t + 5)
    const said = d.msg ? String(d.msg).replace(/\s+/g, ' ').trim() : ''
    if (fired) d.weapon = `the ${fired.kit || kit(d.k)} kit${said ? ` ("${said}")` : ` (not the ${String(d.weapon || 'fist').replace(/_/g, ' ')} in hand)`}`
    else if (said && /stomp|lightning|struck|exploded|blew|portal|poison|burn|threw|launched|froze/i.test(said)) d.weapon = `a kit ("${said}")`
  }
  const moments = []
  const add = (m) => { moments.push(m); return m }
  const active = states.find(s => s.state === 'ACTIVE')
  add({ kind: 'drop', start: 0, end: Math.min(total, Math.max(160, Math.min(active ? active.t : 240, 300))), players: P.map((p, i) => i).filter(i => P[i].first !== null && P[i].first < 100), importance: 40, summary: `${P.length} players fall onto the map${active ? `; invincible until ${mmss(active.t)}` : ''}` })
  const deathCovered = new Set()
  for (const f of fights) {
    const A = name(f.a); const B = name(f.b)
    const d = f.deathEvent
    if (d) deathCovered.add(d)
    const killer = d && d.k !== undefined ? d.k : null
    const m = add({ kind: d ? 'kill' : 'fight', start: f.start, end: d ? Math.max(f.end, d.t) : f.end, players: [f.a, f.b], fight: f, death: d,
      importance: d ? 60 + (P[d.v].kills || 0) * 6 + (killer !== null && d.k_hp !== undefined && d.k_hp <= 6 ? 15 : 0) : 25 + Math.min(20, (f.hits[f.a] || 0) + (f.hits[f.b] || 0)),
      summary: d
        ? `${name(killer !== null ? killer : (d.v === f.a ? f.b : f.a))} (${kit(killer !== null ? killer : (d.v === f.a ? f.b : f.a))}) kills ${name(d.v)} (${kit(d.v)})${d.weapon ? ` with ${d.weapon.replace(/_/g, ' ')}` : ''} after a ${Math.max(1, Math.round((f.end - f.start) / 20))}s fight${d.k_hp !== undefined ? `, finishing on ${d.k_hp} hp` : ''}`
        : `${A} (${kit(f.a)}) and ${B} (${kit(f.b)}) fight for ${Math.max(1, Math.round((f.end - f.start) / 20))}s: ${f.hits[f.a] || 0} hits to ${f.hits[f.b] || 0}, both walk away (lowest hp ${A} ${f.minHp[f.a] !== undefined ? f.minHp[f.a] : 20}, ${B} ${f.minHp[f.b] !== undefined ? f.minHp[f.b] : 20})` })
    m.where = [f.x, f.y, f.z]
  }
  for (const a of mobs) {
    const d = a.deathEvent
    if (d) deathCovered.add(d)
    const s = posOf(a.v, a.start)
    add({ kind: d ? 'mob_kill' : 'mob', start: a.start, end: d ? d.t : a.end, players: [a.v], mob: a, death: d, where: s ? [Math.round(s.x), Math.round(s.y), Math.round(s.z)] : null,
      importance: d ? 50 + (P[a.v].kills || 0) * 6 : 6 + Math.min(6, Math.floor(a.hits / 2)), // a creature that only bites is scenery
      summary: d ? `a ${a.mob.replace(/_/g, ' ')} kills ${name(a.v)} (${kit(a.v)}) after ${a.hits} hits over ${Math.max(1, Math.round((a.end - a.start) / 20))}s` : `a ${a.mob.replace(/_/g, ' ')} attacks ${name(a.v)}: ${a.hits} hits, down to ${a.minHp} hp, survives` })
  }
  for (const d of deaths) {
    if (deathCovered.has(d)) continue
    add({ kind: d.k !== undefined ? 'kill' : 'death', start: Math.max(0, d.t - 100), end: d.t, players: d.k !== undefined ? [d.k, d.v] : [d.v], death: d, where: [Math.round(d.x), Math.round(d.y), Math.round(d.z)],
      importance: 45 + (P[d.v].kills || 0) * 6,
      summary: d.k !== undefined ? `${name(d.k)} (${kit(d.k)}) kills ${name(d.v)} (${kit(d.v)})${d.weapon ? ` with ${d.weapon.replace(/_/g, ' ')}` : ''}` : `${name(d.v)} (${kit(d.v)}) dies: ${d.mob ? `killed by a ${d.mob.replace(/_/g, ' ')}` : (d.cause || 'unknown').replace(/_/g, ' ')}` })
  }
  for (const e of eliminated) {
    if (deaths.some(d => d.v === e.p && Math.abs(d.t - e.t) < 60)) continue
    const s = posOf(e.p, e.t)
    add({ kind: 'quit', start: Math.max(0, e.t - 100), end: e.t, players: [e.p], where: s ? [Math.round(s.x), Math.round(s.y), Math.round(s.z)] : null, importance: 15, summary: `${name(e.p)} (${kit(e.p)}) leaves the match without dying (quit, forfeit or combat log); ${e.remaining} remain` })
  }
  // explosions and lightning, clustered
  let cluster = null
  for (const e of rec.events.filter(x => x.type === 'explosion' || x.type === 'lightning')) {
    if (!cluster || e.t - cluster.end > 200 || Math.hypot(e.x - cluster.x, e.z - cluster.z) > 30) cluster = add({ kind: 'event', start: e.t, end: e.t, players: [], x: e.x, z: e.z, where: [Math.round(e.x), Math.round(e.y), Math.round(e.z)], importance: 8, counts: {}, blocks: 0 }) // explosions and bolts are scenery unless they land on someone (+10 below)
    cluster.end = e.t
    cluster.counts[e.type] = (cluster.counts[e.type] || 0) + 1
    cluster.blocks += (e.blocks || []).length
  }
  for (const m of moments.filter(x => x.kind === 'event')) {
    m.players = P.map((p, i) => i).filter(i => { const s = R.sampleAt(P[i].track, m.start, 60); return s && Math.hypot(s.x - m.x, s.z - m.z) < 30 })
    m.summary = `${Object.entries(m.counts).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(' and ')}${m.blocks ? ` breaking ${m.blocks} blocks` : ''}${m.players.length ? ` near ${m.players.map(name).join(', ')}` : ''}`
    if (m.players.length) m.importance += 10
  }
  // the ending: the last death through the ceremony
  if (lastDeath) {
    const finalMoment = moments.filter(m => m.death === lastDeath)[0]
    const from = Math.max(0, Math.min(lastDeath.t - 240, finalMoment ? finalMoment.start - 80 : lastDeath.t - 240))
    const who = [...new Set([winnerIdx, lastDeath.v, lastDeath.k].filter(i => i !== undefined && i >= 0))]
    add({ kind: 'ending', start: from, end: Math.min(total, lastDeath.t + 200), players: who, death: lastDeath, where: [Math.round(lastDeath.x), Math.round(lastDeath.y), Math.round(lastDeath.z)], importance: 100,
      summary: `THE ENDING. ${name(lastDeath.v)} (${kit(lastDeath.v)}) is the last to fall${lastDeath.k !== undefined ? `, killed by ${name(lastDeath.k)} with ${String(lastDeath.weapon).replace(/_/g, ' ')}` : (lastDeath.mob ? `, killed by a ${lastDeath.mob.replace(/_/g, ' ')}` : `, ${(lastDeath.cause || 'died').replace(/_/g, ' ')}`)}; ${rec.meta.winner ? `${rec.meta.winner} (${kit(winnerIdx)}) wins` : 'nobody is left'}` })
  }
  // ---- beats nobody was hurt in, that a story still turns on. Fights and deaths are not the
  // whole match: a kit used on someone, a leap off a tower, a tower going up are moments too,
  // and a planner who is only shown the damage will skip straight past them.
  const before = lastDeath ? lastDeath.t : total
  const pulls = rec.events.filter(e => e.type === 'teleport' && e.x !== undefined && e.t < before)
  const uses = rec.events.filter(e => e.type === 'ability' && e.t < before)
  const bursts = []
  for (const u of uses) { const b = bursts[bursts.length - 1]; if (b && b.p === u.p && u.t - b.to <= 100) b.to = u.t; else bursts.push({ p: u.p, kit: u.kit || kit(u.p), from: u.t, to: u.t, x: u.x, y: u.y, z: u.z }) }
  for (const b of bursts) {
    const moved = pulls.filter(tp => tp.t >= b.from - 5 && tp.t <= b.to + 20)
    if (!moved.length && b.to - b.from > 400) continue // a passive kit ticking away is not a moment
    const what = moved.map(tp => {
      const f = Array.isArray(tp.from) ? tp.from : null
      const flat = f ? Math.hypot(tp.x - f[0], tp.z - f[2]) : 0; const dy = f ? tp.y - f[1] : 0
      return `${name(tp.p)} is ${tp.p === b.p ? 'moved' : 'pulled'}${Math.abs(dy) >= 3 ? ` ${Math.round(Math.abs(dy))} blocks ${dy > 0 ? 'up' : 'down'}` : ''}${flat >= 3 ? ` ${Math.round(flat)} blocks across` : ''}${tp.p === b.p ? '' : ` to ${name(b.p)}`}`
    })
    add({ kind: 'ability', start: Math.max(0, b.from - 180), end: Math.min(total, b.to + 100), players: [...new Set([b.p, ...moved.map(tp => tp.p)])], where: [Math.round(b.x || 0), Math.round(b.y || 0), Math.round(b.z || 0)], importance: moved.length ? 75 : 35, at: b.from,
      summary: `${name(b.p)} (${b.kit}) uses the kit at ${mmss(b.from)}${what.length ? ': ' + what.join('; ') : ''}. The seconds before it (the approach) belong to this moment.` })
  }
  // a long way down in one go: a leap off a tower or a cliff
  P.forEach((p, i) => {
    const tr = (p.track || []).filter(q => q.t > 320 && q.t < before)
    for (let j = 0; j < tr.length - 1; j++) {
      const a = tr[j]
      // how far down are they four seconds later? (samples come ten a second in a fall, so
      // no single step is large)
      let k = j
      while (k + 1 < tr.length && tr[k + 1].t - a.t <= 80 && tr[k + 1].y <= tr[k].y + 0.3) k++
      if (a.y - tr[k].y < 15) continue // a real leap, not a walk down a hillside
      while (k + 1 < tr.length && tr[k + 1].t - tr[k].t <= 40 && tr[k + 1].y < tr[k].y - 0.5) k++
      // the leap starts at the last moment they were still at the top
      let s0 = j; while (s0 + 1 < k && tr[s0 + 1].y >= a.y - 1) s0++
      const top = tr[s0]
      const land = tr[k]; const dropped = Math.round(a.y - land.y)
      const hurt = rec.events.find(e => e.type === 'dmg' && e.v === i && e.cause === 'fall' && Math.abs(e.t - land.t) <= 40)
      const wet = world && world.isLiquid && (world.isLiquid(land.x, land.y, land.z) || world.isLiquid(land.x, land.y - 1, land.z))
      add({ kind: 'fall', start: Math.max(0, top.t - 100), end: Math.min(total, land.t + 70), players: [i], where: [Math.round(land.x), Math.round(land.y), Math.round(land.z)], importance: 30 + Math.min(35, dropped), at: top.t,
        summary: `${name(i)} (${kit(i)}) drops ${dropped} blocks at ${mmss(top.t)}${wet ? ' into water' : ''}${hurt ? `, taking ${hurt.dmg} fall damage` : ', unhurt'}` })
      j = k
    }
  })
  // a tower going up
  P.forEach((p, i) => {
    const cols = new Map()
    for (const e of rec.events) if (e.type === 'block' && e.p === i && e.to && !/air$/.test(e.to) && e.t < before) { const key = e.x + ',' + e.z; if (!cols.has(key)) cols.set(key, []); cols.get(key).push(e) }
    for (const col of cols.values()) {
      const ys = [...new Set(col.map(e => e.y))].sort((x, y) => x - y)
      if (ys.length < 10) continue
      const t0 = Math.min(...col.map(e => e.t)); const t1 = Math.max(...col.map(e => e.t))
      add({ kind: 'tower', start: Math.max(0, t0 - 60), end: Math.min(total, t1 + 80), players: [i], where: [col[0].x, ys[ys.length - 1], col[0].z], importance: 45, at: t0,
        summary: `${name(i)} (${kit(i)}) builds a ${ys[ys.length - 1] - ys[0] + 1}-block tower, ${mmss(t0)}-${mmss(t1)}` })
    }
  })
  // conversations: runs of chat with no minute of silence between lines, four lines or more.
  // Each is a moment with every line in it, so a typed-out story is planned on, not skipped.
  const slotOf = new Map(P.map((p, i) => [p.name, i]))
  let talk = null
  const talks = []
  for (const c of chats) {
    if (!talk || c.t - talk.last > 1200) { talk = { lines: [], first: c.t, last: c.t }; talks.push(talk) }
    talk.lines.push(c); talk.last = c.t
  }
  for (const tk of talks.filter(x => x.lines.length >= 4)) {
    const who = [...new Set(tk.lines.map(c => slotOf.get(c.name)).filter(i => i !== undefined))]
    const s0 = who.length ? posOf(who[0], tk.first) : null
    add({ kind: 'talk', start: Math.max(0, tk.first - 40), end: Math.min(total, tk.last + 40), players: who, where: s0 ? [Math.round(s0.x), Math.round(s0.y), Math.round(s0.z)] : null, importance: 40 + Math.min(35, tk.lines.length * 2), lines: tk.lines,
      summary: `a conversation: ${tk.lines.length} lines between ${who.map(name).join(' and ') || 'players'} over ${Math.round((tk.last - tk.first) / 20)}s, from "${tk.lines[0].text.slice(0, 40)}" to "${tk.lines[tk.lines.length - 1].text.slice(0, 40)}"` })
  }
  moments.sort((a, b) => a.start - b.start || b.importance - a.importance)
  moments.forEach((m, i) => { m.id = 'm' + String(i + 1).padStart(2, '0') })
  for (const m of moments) {
    m.place = m.where ? describePlace(world, m.where[0], m.where[1], m.where[2]) : null
    if (m.place && m.place.underground) m.summary += ` [underground]`
  }

  // ---- roads: a player's moments, latest first
  const road = (i) => moments.filter(m => m.kind !== 'drop' && m.players.includes(i)).sort((a, b) => b.end - a.end)
  const onMainRoad = new Set()
  for (const i of [winnerIdx, runnerUpIdx]) if (i >= 0) for (const m of road(i)) onMainRoad.add(m.id)
  const side = []
  P.forEach((p, i) => {
    if (i === winnerIdx || i === runnerUpIdx) return
    const best = road(i).filter(m => !onMainRoad.has(m.id)).sort((a, b) => b.importance - a.importance)[0]
    if (best) side.push({ player: p.name, moment: best.id, summary: best.summary })
    else side.push({ player: p.name, moment: null, summary: `no moment of their own; travelled ${distanceTravelled(p.track)} blocks` })
  })

  const players = P.map((p, i) => {
    const death = deaths.find(d => d.v === i)
    const out = eliminated.find(e => e.p === i)
    return {
      name: p.name, kit: p.kit, kills: p.kills || 0, bedrock: p.name.startsWith('.'),
      survived_sec: Math.round(((out ? out.t : (p.last !== null ? p.last : total)) || 0) / 20),
      place: i === winnerIdx ? 1 : (placement.get(i) || null),
      death: death ? { at_sec: sec(death.t), killer: death.k !== undefined ? name(death.k) : null, weapon: death.weapon || null, cause: death.mob ? `killed by a ${death.mob.replace(/_/g, ' ')}` : (death.cause || null), mob: death.mob || null, killer_hp: death.k_hp, pos: [Math.round(death.x), Math.round(death.y), Math.round(death.z)] } : (out ? { at_sec: sec(out.t), killer: null, cause: 'left or forfeited' } : null),
      distance_blocks: distanceTravelled(p.track),
      min_hp: p.track.length ? Math.min(...p.track.map(s => s.hp)) : null,
      moments: road(i).map(m => m.id)
    }
  })

  const suggest = (m) => {
    const lead = m.kind === 'drop' ? 0 : (m.kind === 'ending' ? 0 : 160)
    const tail = m.kind === 'ending' ? 0 : (m.death ? 50 : 40)
    const from = Math.max(0, m.start - lead); const to = Math.min(total, m.end + tail)
    const focus = (m.death && m.death.k !== undefined ? [m.death.k, m.death.v] : m.players).slice(0, 3).map(name)
    return { from_sec: sec(from), to_sec: sec(to), focus: focus.length ? focus : P.slice(0, 2).map(p => p.name), key_at_sec: m.death ? +((m.death.t - from) / 20).toFixed(1) : null }
  }

  return {
    id: rec.meta.id, started: rec.meta.started_ms ? new Date(rec.meta.started_ms).toISOString() : null,
    duration_sec: Math.round(total / 20), winner: rec.meta.winner || null, starting_players: rec.meta.starting_players,
    phases: states.map(s => ({ at_sec: sec(s.t), state: s.state })),
    players,
    kill_tree: deaths.map(d => ({ at_sec: sec(d.t), victim: name(d.v), victim_kit: kit(d.v), killer: d.k !== undefined ? name(d.k) : null, killer_kit: d.k !== undefined ? kit(d.k) : null, by: d.k !== undefined ? (d.weapon || 'fist') : (d.mob || d.cause || 'unknown') })),
    winner_road: winnerIdx >= 0 ? road(winnerIdx).map(m => m.id) : [],
    runner_up: runnerUpIdx >= 0 ? name(runnerUpIdx) : null,
    runner_up_road: runnerUpIdx >= 0 ? road(runnerUpIdx).map(m => m.id) : [],
    side_moments: side,
    moments: moments.map(m => ({ id: m.id, kind: m.kind, from_sec: sec(m.start), to_sec: sec(m.end), players: m.players.map(name), importance: m.importance, summary: m.summary, place: m.place, suggested: suggest(m) })),
    chat: chats.map(c => ({ at_sec: sec(c.t), name: c.name, text: c.text })),
    traits,
    // kept for older tooling and tests
    fights: fights.map(f => ({ a: name(f.a), b: name(f.b), from_sec: sec(f.start), to_sec: sec(f.end), hits: { [name(f.a)]: f.hits[f.a] || 0, [name(f.b)]: f.hits[f.b] || 0 }, death: f.death !== null ? name(f.death) : null, pos: [f.x, f.y, f.z] })),
    suggestions: moments.filter(m => m.kind === 'drop' || m.death).map(m => ({ why: m.death === lastDeath && m.kind !== 'ending' ? `${m.summary} (FINAL KILL; required)` : (m.kind === 'ending' ? `${m.summary} (FINAL KILL; required)` : m.summary), ...suggest(m) })),
    _raw: { moments }
  }
}

// ------------------------------------------------------------------ skeleton
function toMarkdown (d, fmt) {
  const L = []
  const M = new Map(d.moments.map(m => [m.id, m]))
  const line = (id) => { const m = M.get(id); return m ? `\`${m.id}\` ${mmss(m.from_sec * 20)}-${mmss(m.to_sec * 20)} ${m.summary}` : id }
  L.push(`# Match ${d.id}: the skeleton`, '')
  if (fmt) L.push(`**Film format: ${fmt.id.toUpperCase()}** (${fmt.label}). Plan ${fmt.min_sec}-${fmt.max_sec} seconds of film.`, '')
  L.push(`Duration ${mmss(d.duration_sec * 20)}. ${d.starting_players} players at the drop. Winner: **${d.winner || 'nobody'}**.`, '')
  L.push('This file is the outline. Every moment has an id; its detail (blow by blow, place, who was nearby, a suggested film segment) is in `moments/<id>.md`. Read only the ones you will use.', '')
  L.push('## The ending, and the roads that led to it (read backwards)', '')
  const ending = d.moments.find(m => m.kind === 'ending')
  if (ending) L.push(`- ${line(ending.id)}`)
  L.push('', `**${d.winner || 'The winner'}'s road, latest first:**`)
  if (d.winner_road.length) for (const id of d.winner_road) L.push(`- ${line(id)}`); else L.push('- (nothing recorded: the winner fought nobody)')
  if (d.runner_up) {
    L.push('', `**Runner-up ${clean(d.runner_up)}'s road, latest first:**`)
    for (const id of d.runner_up_road) L.push(`- ${line(id)}`)
  }
  L.push('', '## Side moments (players off the main road; use some so the film is not only about the winner)', '')
  for (const s of d.side_moments) L.push(`- ${clean(s.player)}: ${s.moment ? line(s.moment) : s.summary}`)
  if (d.traits) {
    const t = d.traits
    const say = { dialogue: 'this match was a conversation: the players typed a story (a roleplay, a date, a feud). The film IS that dialogue: a segment for every conversation moment (`talk` in the index), at real speed, every line quoted as a chat line in the speaker\'s voice at the second it was said, nothing skipped; the narrator only connects the scenes. It may run the full length a Short allows', 'chat-heavy': 'the players typed a lot: the dialogue is the story, quote it and build the film around what they said to each other', duel: 'a small match with few fights: the matchup and the last duel carry it, make that one fight epic', rampage: 'one player went on a streak: the film is their run and who finally stops it', 'mob-heavy': 'more creature fights than player fights: creatures are scenery here, never the story unless one kills somebody; find the player story underneath', quiet: 'long quiet stretches: cut them, do not narrate them; the few events get the time', brawl: 'many fights among many players: pick one thread and follow it', 'mob-deaths': 'creatures killed players: those deaths are fair moments, the bites that did not kill are not' }
    L.push('', '## What this match is', '', `${t.chat_lines} chat lines from ${t.chatters} players, ${t.pvp_hits} player-on-player hits, ${t.mob_hits} creature hits, ${t.fights} fights over ${Math.round(t.fight_share * 100)}% of the match, longest kill streak ${t.biggest_streak}.`, '')
    for (const l of t.labels) L.push(`- **${l}**: ${say[l] || ''}`)
    if (!t.labels.length) L.push('- an ordinary match: the winner\'s road and one side story')
  }
  L.push('', '## Players', '', '| player | kit | place | kills | survived | walked | how it ended |', '|---|---|---|---|---|---|---|')
  for (const p of d.players.slice().sort((a, b) => (a.place || 99) - (b.place || 99))) {
    const end = p.place === 1 ? 'won' : (p.death ? (p.death.killer ? `killed by ${p.death.killer} (${String(p.death.weapon).replace(/_/g, ' ')})` : (p.death.cause || 'died')) : 'unknown')
    L.push(`| ${p.name} | ${p.kit} | ${p.place || '-'} | ${p.kills} | ${mmss(p.survived_sec * 20)} | ${p.distance_blocks} blocks | ${end} |`)
  }
  L.push('', '## Kill tree (in order)', '')
  for (const k of d.kill_tree) L.push(`- ${mmss(k.at_sec * 20)} ${k.killer ? `${k.killer} (${k.killer_kit}) -> ${k.victim} (${k.victim_kit}) with ${String(k.by).replace(/_/g, ' ')}` : `${k.victim} (${k.victim_kit}) <- ${String(k.by).replace(/_/g, ' ')}`}`)
  if (!d.kill_tree.length) L.push('- nobody died')
  L.push('', '## Phases', '')
  for (const p of d.phases) L.push(`- ${mmss(p.at_sec * 20)} ${p.state}`)
  L.push('', '## All moments by time', '')
  for (const m of d.moments) L.push(`- ${line(m.id)}`)
  if (d.chat.length) {
    L.push('', '## Chat', '')
    const dialogue = d.traits && d.traits.labels.includes('dialogue')
    for (const c of dialogue ? d.chat : d.chat.slice(0, 25)) L.push(`- ${mmss(c.at_sec * 20)} (${c.at_sec}s) <${c.name}> ${c.text}`)
    if (!dialogue && d.chat.length > 25) L.push(`- ... ${d.chat.length - 25} more lines (see the moment files near the time you care about)`)
  }
  L.push('')
  return L.join('\n')
}

// ------------------------------------------------------------------ zoom
function momentMarkdown (rec, d, m, raw) {
  const P = rec.players
  const name = (i) => (P[i] ? P[i].name : '?')
  const L = []
  L.push(`# ${m.id} (${m.kind}): ${m.summary}`, '')
  L.push(`- match time ${m.from_sec}s to ${m.to_sec}s (${mmss(m.from_sec * 20)}-${mmss(m.to_sec * 20)})`)
  if (m.place) L.push(`- where: ${placeWords(m.place)}`)
  L.push(`- players: ${m.players.map(n => { const p = d.players.find(x => x.name === n); return `${n} (${p ? p.kit : '?'})` }).join(', ') || 'none in particular'}`)
  L.push(`- suggested segment: from_sec ${m.suggested.from_sec}, to_sec ${m.suggested.to_sec}, focus ${JSON.stringify(m.suggested.focus)}${m.suggested.key_at_sec !== null ? `; the death lands ${m.suggested.key_at_sec}s after the segment starts` : ''}`)
  const t0 = raw.start; const t1 = raw.end
  // blow by blow
  const blows = raw.fight ? raw.fight.blows : (raw.mob ? raw.mob.blows : [])
  if (blows.length) {
    L.push('', '## Blow by blow (seconds from the first hit)', '')
    const show = blows.length > 40 ? blows.filter((b, i) => i < 12 || i >= blows.length - 12) : blows
    let skipped = false
    for (const b of blows) {
      if (!show.includes(b)) { if (!skipped) { L.push(`- ... ${blows.length - show.length} more hits ...`); skipped = true } continue }
      L.push(`- +${((b.t - blows[0].t) / 20).toFixed(1)}s ${b.a !== undefined ? name(b.a) : `a ${b.mob.replace(/_/g, ' ')}`} hits ${name(b.v)} for ${b.dmg}${b.via ? ` (${b.via})` : ''}; ${name(b.v)} at ${b.hp} hp`)
    }
  }
  if (raw.death) {
    const dd = raw.death
    L.push('', `**Death:** ${name(dd.v)} at ${sec(dd.t)}s${dd.k !== undefined ? `, killed by ${name(dd.k)} with ${String(dd.weapon).replace(/_/g, ' ')} (killer on ${dd.k_hp} hp)` : (dd.mob ? `, killed by a ${dd.mob.replace(/_/g, ' ')}` : `, ${(dd.cause || '').replace(/_/g, ' ')}`)}.`)
  }
  // approach: where everyone was 10 s before
  if (raw.players.length >= 2) {
    const [a, b] = raw.players
    const pa = R.sampleAt(P[a].track, t0 - 200, 60); const pb = R.sampleAt(P[b].track, t0 - 200, 60)
    const qa = R.sampleAt(P[a].track, t0, 60); const qb = R.sampleAt(P[b].track, t0, 60)
    if (pa && pb && qa && qb) {
      const before = Math.hypot(pa.x - pb.x, pa.z - pb.z); const moveA = Math.hypot(qa.x - pa.x, qa.z - pa.z); const moveB = Math.hypot(qb.x - pb.x, qb.z - pb.z)
      L.push('', '## The approach', '', `- 10 s earlier they were ${before.toFixed(0)} blocks apart. ${name(a)} covered ${moveA.toFixed(0)} blocks to get here, ${name(b)} covered ${moveB.toFixed(0)}${moveA > moveB * 2 ? ` (${name(a)} did the chasing)` : (moveB > moveA * 2 ? ` (${name(b)} did the chasing)` : '')}.`)
    }
  }
  // context
  const ctx = []
  for (const i of raw.players) { const held = R.heldAt(P[i], t1); const s = R.sampleAt(P[i].track, t0, 60); if (s) ctx.push(`- ${name(i)}: ${s.hp} hp going in${held ? `, holding ${held.replace(/_/g, ' ')}` : ', empty hands'}`) }
  const anchor = raw.where || null
  if (anchor) {
    const near = P.map((p, i) => i).filter(i => !raw.players.includes(i)).map(i => { const s = R.sampleAt(P[i].track, (t0 + t1) / 2, 60); return s ? { i, d: Math.hypot(s.x - anchor[0], s.z - anchor[2]) } : null }).filter(x => x && x.d < 48).sort((x, y) => x.d - y.d)
    for (const n of near.slice(0, 4)) ctx.push(`- nearby: ${name(n.i)} is ${n.d.toFixed(0)} blocks away`)
    const boom = rec.events.filter(e => (e.type === 'explosion' || e.type === 'lightning') && e.t >= t0 - 100 && e.t <= t1 + 60 && Math.hypot(e.x - anchor[0], e.z - anchor[2]) < 30)
    if (boom.length) ctx.push(`- ${boom.length} explosion/lightning event(s) within 30 blocks during this moment`)
    const blocks = rec.events.filter(e => e.type === 'block' && e.t >= t0 - 100 && e.t <= t1 + 60 && Math.hypot(e.x - anchor[0], e.z - anchor[2]) < 20)
    if (blocks.length) ctx.push(`- ${blocks.length} blocks placed or broken within 20 blocks (${[...new Set(blocks.map(b => b.how))].join(', ')})`)
  }
  const tp = rec.events.filter(e => e.type === 'teleport' && raw.players.includes(e.p) && e.t >= t0 - 100 && e.t <= t1 + 100)
  for (const e of tp) ctx.push(`- ${name(e.p)} teleports (${e.cause}) at ${sec(e.t)}s`)
  if (ctx.length) L.push('', '## Context', '', ...ctx)
  if (raw.kind === 'talk') { L.push('', '## The conversation, word for word', '', 'Quote these as chat lines (`"chat": true`, the speaker, the exact words, at the second they were said); the film shows the speaker as each line starts.', ''); for (const c of raw.lines) L.push(`- ${sec(c.t)}s <${c.name}> ${c.text}`) } else {
    const said = rec.events.filter(e => e.type === 'chat' && e.t >= t0 - 300 && e.t <= t1 + 300)
    if (said.length) { L.push('', '## Chat around this moment', ''); for (const c of said.slice(0, 12)) L.push(`- ${sec(c.t)}s <${c.name}> ${c.text}`) }
  }
  L.push('')
  return L.join('\n')
}

function write (rec, dir, fmt, opts = {}) {
  let world = null
  try { if (U.exists(rec.regionDir)) world = new (require('./anvil').AnvilWorld)(rec.regionDir) } catch { /* place descriptions are optional */ }
  const d = build(rec, world)
  if (world) world.close()
  if (fmt) d.format = fmt.id
  const raw = d._raw.moments
  delete d._raw
  // what a commentator who knows the game would notice (teaming, stews, towers, highlights...)
  let notes = ''
  try { const insight = require('./insight'); d.insight = insight.build(rec); notes = insight.toMarkdown(d.insight) } catch (e) { U.log('digest', 'insight skipped: ' + e.message) }
  // the slow-motion finale: which seconds it covers, worked out from the song
  // the edit strategy this film is planned under (lib/strategy): chosen from what the match has
  // in it, written beside the digest for the planner and the checker; it also picks the song
  let strategy = null
  try {
    const sel = require('../strategy/select')
    const choice = sel.choose(d, { force: (opts && opts.strategy) || null })
    strategy = sel.write(dir, choice, d)
    d.strategy = { id: strategy.id, name: strategy.name, why: choice.why }
    notes += `\n## Edit strategy\n\nThis film is planned under **${strategy.name}** (\`${strategy.id}\`): ${choice.why}. Read projects/<slug>/strategy.md and follow it; the checker holds the plan to it.\n`
    U.log('digest', `strategy: ${strategy.id} (${choice.why})`)
  } catch (e) { U.log('digest', 'no strategy: ' + e.message) }
  try { const fx = (strategy && strategy.knobs && strategy.knobs.effects) || {}; notes += '\n' + require('../media').stingsMarkdown(fx.register || 'clean', fx.max !== undefined ? fx.max : (fx.register === 'memed' ? 3 : 1)) } catch { /* no media list */ }
  try { const finale = require('./finale'); d.finale = finale.plan(rec, finale.song(strategy && strategy.knobs && strategy.knobs.music ? strategy.knobs.music.finale_song : null)); if (d.finale && d.finale.song) finale.noteSong(d.finale.song); notes += finale.toMarkdown(d.finale) } catch (e) { U.log('digest', 'finale skipped: ' + e.message) }
  U.writeJson(path.join(dir, 'digest.json'), d)
  fs.writeFileSync(path.join(dir, 'digest.md'), toMarkdown(d, fmt) + (notes ? '\n' + notes : ''))
  const mdir = path.join(dir, 'moments')
  fs.rmSync(mdir, { recursive: true, force: true })
  fs.mkdirSync(mdir, { recursive: true })
  d.moments.forEach((m, i) => fs.writeFileSync(path.join(mdir, m.id + '.md'), momentMarkdown(rec, d, m, raw[i])))
  return d
}

module.exports = { build, toMarkdown, momentMarkdown, write, findFights, findMobAttacks, mmss }
