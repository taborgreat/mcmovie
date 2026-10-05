'use strict'
// What a commentator who knows Hardcore Games would notice, worked out from the
// recording so the planner does not have to guess: who teamed (and whether it
// ended in a betrayal), who drank how many stews and who was hotkeying, who
// towered, and how people died when no player killed them (starved, drowned,
// fell). It also decides which of the game's rules are worth a mention in THIS
// film: the feast only when it happened or was close, the forcefield only when
// somebody went near it, and the things that are true of every match (two
// minutes of invincibility, dead is dead) only now and then, so the narrator
// does not say them every single time.
const { sampleAt } = require('./recording')

const TEAM_DIST = 12 // blocks: closer than this, for long, without fighting = together
const TEAM_MIN_SEC = 90
const BORDER = 500
const FEAST_MIN = 20 // the feast lands about this many minutes in
const ENDGAME_MIN = 60

const CAUSES = {
  starvation: ['starved to death', 'A Cultivator grows food on the spot; anyone with bread or stew would have lived.'],
  drowning: ['drowned', null],
  fall: ['fell to their death', 'Stompers shrug off fall damage; nobody else does.'],
  lava: ['burned in lava', null],
  fire: ['burned to death', null],
  fire_tick: ['burned to death', null],
  hot_floor: ['burned on magma', null],
  suffocation: ['suffocated inside blocks', null],
  void: ['fell out of the world', null],
  lightning: ['was struck by lightning', 'Lightning in this game usually means a Thor.'],
  contact: ['was pricked to death by a cactus', null],
  freeze: ['froze in powder snow', null],
  block_explosion: ['was blown up', null],
  entity_explosion: ['was blown up', null],
  poison: ['died of poison', null],
  wither: ['withered away', null],
  magic: ['died to a potion or a kit effect', null],
  custom: ['died to the forcefield or a kit effect', null]
}

// small seeded generator so a re-import of the same match makes the same choices
function seeded (str) {
  let h = 2166136261
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function build (rec, opts = {}) {
  const P = rec.players
  const rand = opts.rand || seeded(rec.id || (rec.meta && rec.meta.id) || 'match')
  const name = i => (P[i] ? P[i].name : '?')
  const kit = i => (P[i] ? P[i].kit : '?')
  const sec = t => Math.round(t / 20)
  const total = rec.meta.ticks
  const ev = type => rec.events.filter(e => e.type === type)
  const deaths = ev('death')
  const deathTick = i => { const d = deaths.find(e => e.v === i); return d ? d.t : total }
  const track = i => (rec.tracks && rec.tracks[i]) || []
  const states = ev('state')
  const pvpStart = (states.find(s => s.state === 'ACTIVE') || { t: 2400 }).t
  const feast = states.find(s => s.state === 'FEAST')

  // ---- teaming: two players close together for a long time who are not fighting each other
  const hits = ev('hit').filter(h => h.a !== undefined && h.v !== undefined)
  const teams = []
  const STEP = 40
  for (let a = 0; a < P.length; a++) {
    for (let b = a + 1; b < P.length; b++) {
      const until = Math.min(deathTick(a), deathTick(b))
      let close = 0; let first = null; let last = null
      for (let t = pvpStart; t <= until; t += STEP) {
        const A = sampleAt(track(a), t, 60); const B = sampleAt(track(b), t, 60)
        if (!A || !B) continue
        if (Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z) <= TEAM_DIST) { close += STEP; if (first === null) first = t; last = t }
      }
      if (close < TEAM_MIN_SEC * 20) continue
      const between = hits.filter(h => (h.a === a && h.v === b) || (h.a === b && h.v === a))
      // people who trade a few hits and then travel together still teamed; a long brawl did not
      if (between.length > 6 && between.length > close / 20 / 10) continue
      const betrayal = deaths.find(d => (d.k === a && d.v === b) || (d.k === b && d.v === a))
      const kills = deaths.filter(d => (d.k === a || d.k === b) && d.v !== a && d.v !== b && d.t >= first && d.t <= last + 200).length
      teams.push({
        players: [name(a), name(b)], kits: [kit(a), kit(b)], together_sec: sec(close), from_sec: sec(first), to_sec: sec(last),
        began: first - pvpStart < 1200 ? 'from the start' : (first > total * 0.5 ? 'late in the match' : 'partway through'),
        kills_together: kills,
        betrayal: betrayal ? { killer: name(betrayal.k), victim: name(betrayal.v), at_sec: sec(betrayal.t) } : null
      })
    }
  }
  teams.sort((x, y) => y.together_sec - x.together_sec)

  // ---- stews: totals, the fastest burst (hotkeying), and who drank what going into each kill
  const stewEvents = ev('stew')
  const stews = []
  for (let i = 0; i < P.length; i++) {
    const mine = stewEvents.filter(s => s.p === i).map(s => s.t)
    if (!mine.length) continue
    let burst = 0; let burstAt = 0
    for (let j = 0; j < mine.length; j++) {
      let k = j; while (k < mine.length && mine[k] - mine[j] <= 100) k++
      if (k - j > burst) { burst = k - j; burstAt = mine[j] }
    }
    stews.push({ player: name(i), total: mine.length, best_5s: burst, best_at_sec: sec(burstAt), hotkeying: burst >= 5 })
  }
  stews.sort((x, y) => y.total - x.total)
  const fightStews = deaths.filter(d => d.k !== undefined).map(d => {
    const n = i => stewEvents.filter(s => s.p === i && s.t >= d.t - 600 && s.t <= d.t).length
    return { at_sec: sec(d.t), killer: name(d.k), victim: name(d.v), killer_stews: n(d.k), victim_stews: n(d.v) }
  }).filter(f => f.killer_stews + f.victim_stews > 0)

  // ---- towering: a thin column built straight up
  const towers = []
  const placed = ev('block').filter(b => b.p !== undefined && b.to && !/air$/.test(b.to))
  for (let i = 0; i < P.length; i++) {
    const cols = new Map()
    for (const b of placed.filter(b => b.p === i)) { const k = b.x + ',' + b.z; if (!cols.has(k)) cols.set(k, []); cols.get(k).push(b) }
    for (const col of cols.values()) {
      const ys = [...new Set(col.map(b => b.y))].sort((x, y) => x - y)
      const height = ys.length ? ys[ys.length - 1] - ys[0] + 1 : 0
      if (ys.length < 12 || ys.length < height * 0.7) continue
      const d = deaths.find(e => e.v === i)
      towers.push({ player: name(i), kit: kit(i), height, top_y: ys[ys.length - 1], from_sec: sec(Math.min(...col.map(b => b.t))), to_sec: sec(Math.max(...col.map(b => b.t))), where: [col[0].x, col[0].z], later: d ? `died at ${sec(d.t)}s` : 'survived' })
    }
  }
  towers.sort((x, y) => y.height - x.height)

  // ---- deaths nobody caused
  const quiet = deaths.filter(d => d.k === undefined && !d.mob).map(d => {
    const c = CAUSES[d.cause] || [d.cause ? `died (${String(d.cause).replace(/_/g, ' ')})` : 'died', null]
    return { player: name(d.v), kit: kit(d.v), at_sec: sec(d.t), how: c[0], note: c[1] }
  })

  // ---- /highlight: moments a player marked themselves, with their words on why.
  // One player spending all their highlights while nobody else uses any is one request, not three.
  let highlights = ev('highlight').map(h => {
    const kill = deaths.find(d => (d.k === h.p || d.v === h.p) && Math.abs(d.t - h.t) <= 400)
    return { player: name(h.p), kit: kit(h.p), at_sec: sec(h.t), text: String(h.text || '').trim(), near_kill: kill ? `${name(kill.k !== undefined ? kill.k : kill.v)} ${kill.k !== undefined ? 'kills ' + name(kill.v) : 'dies'} at ${sec(kill.t)}s` : null }
  })
  if (highlights.length > 1 && new Set(highlights.map(h => h.player)).size === 1) highlights = [highlights.find(h => h.near_kill) || highlights[0]]

  // ---- in plain words: the raw numbers of each player's match, said the way a caster would
  const heartsWords = hp => {
    const h = Math.max(0, hp) / 2
    if (h <= 0.5) return 'half a heart'
    if (h <= 1) return 'a single heart'
    if (h <= 1.5) return 'a heart and a half'
    const names = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    return `${names[Math.floor(h)]}${h % 1 ? ' and a half' : ''} hearts`
  }
  const plain = []
  for (let i = 0; i < P.length; i++) {
    const tr = track(i)
    if (!tr.length) continue
    const bits = []
    // how far out they went, as a place
    let far = 0; let edge = BORDER; let span = 0
    for (const s of tr) { far = Math.max(far, Math.hypot(s.x, s.z)); edge = Math.min(edge, BORDER - Math.max(Math.abs(s.x), Math.abs(s.z))) }
    span = Math.hypot(tr[tr.length - 1].x - tr[0].x, tr[tr.length - 1].z - tr[0].z)
    let path = 0
    for (let j = 1; j < tr.length; j++) { const d = Math.hypot(tr[j].x - tr[j - 1].x, tr[j].z - tr[j - 1].z); if (d < 30) path += d }
    if (edge < 30) bits.push('went all the way out to the edge of the forcefield')
    else if (far > BORDER * 0.6) bits.push('roamed far out toward the edge of the map')
    else if (far < 90) bits.push('never left the middle of the map')
    else bits.push('stayed in the inner half of the map')
    if (path > 1400) bits.push('and was on the move the whole match')
    else if (path < 250 && tr[tr.length - 1].t - tr[0].t > 2400) bits.push('and barely moved, camping one spot')
    // how close they came to dying, and whether stew saved them
    const pvp = tr.filter(s => s.t >= pvpStart && s.hp !== undefined)
    if (pvp.length) {
      const low = pvp.reduce((a, b) => (b.hp < a.hp ? b : a))
      const drank = stewEvents.filter(s => s.p === i).length
      const died = deaths.find(d => d.v === i)
      if (low.hp <= 6 && (!died || died.t - low.t > 100)) bits.push(`; was down to ${heartsWords(low.hp)} around ${Math.floor(sec(low.t) / 60)}:${String(sec(low.t) % 60).padStart(2, '0')} and survived it${drank ? ', drinking stew to get back up' : ''}`)
      else if (low.hp >= 16 && !died) bits.push('; was never in real danger')
      const last = tr[tr.length - 1]
      if (!died && last.hp !== undefined) bits.push(`; finished on ${heartsWords(last.hp)}`)
      if (drank >= 8) bits.push(`; lived on stew (${drank} bowls)`)
      else if (drank === 0 && died && died.k !== undefined) bits.push('; never drank a single stew')
    }
    plain.push({ player: name(i), kit: kit(i), words: bits.join(' ').replace(/ ;/g, ';') })
  }

  // ---- which rules are worth saying in this film
  const facts = []
  if (feast) facts.push(`The feast landed at ${sec(feast.t)}s: chests of the best gear near the middle of the map, there to drag everyone left into one place. Say what it did to this match.`)
  else if (total / 1200 >= FEAST_MIN - 4) facts.push(`The feast (chests of the best gear, about ${FEAST_MIN} minutes in) was only ${Math.max(1, Math.round(FEAST_MIN - total / 1200))} minutes away when this match ended. Worth a line if the ending felt rushed.`)
  if (total / 1200 >= ENDGAME_MIN - 5) facts.push(`This match ran long enough to reach the endgame (about ${ENDGAME_MIN} minutes in).`)
  let nearest = null
  for (let i = 0; i < P.length; i++) {
    for (const s of track(i)) {
      const edge = BORDER - Math.max(Math.abs(s.x), Math.abs(s.z))
      if (edge < 30 && (!nearest || edge < nearest.edge)) nearest = { edge, player: name(i), t: s.t, invincible: s.t < pvpStart }
    }
  }
  if (nearest) facts.push(`${nearest.player} went ${nearest.edge <= 0 ? 'into' : `within ${Math.round(nearest.edge)} blocks of`} the forcefield at ${sec(nearest.t)}s${nearest.invincible ? ', during invincibility' : ''}. The map ends at +-${BORDER}; past it the forcefield burns you down.`)
  else if (rand() < 0.2) facts.push(`The map is a square out to +-${BORDER} with a forcefield at the edge. Nobody went near it this match; mention it only if it helps.`)
  if (rand() < 0.3) {
    let far = null
    for (let i = 0; i < P.length; i++) {
      const a = sampleAt(track(i), 0, 200); const b = sampleAt(track(i), pvpStart, 200)
      if (a && b) { const dist = Math.hypot(b.x - a.x, b.z - a.z); if (!far || dist > far.dist) far = { dist, player: name(i) } }
    }
    facts.push(`Every match opens with ${Math.round(pvpStart / 1200)} minutes of invincibility: nobody can be hurt, so it is all running and gathering.${far ? ` ${far.player} used it to get ${Math.round(far.dist)} blocks from the drop.` : ''} You may open on it this time.`)
  }
  if (rand() < 0.25) facts.push('There are no respawns here. Once you are dead you are out of the match for good. You may lean on that once.')

  return { plain, highlights, teams, stews, fight_stews: fightStews, towers, quiet_deaths: quiet, facts }
}

function toMarkdown (ins) {
  const L = []
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  if (ins.highlights.length) {
    L.push('## Player highlights', '', 'Players marked these moments themselves (/highlight), in their own words. Give each one special consideration: look at the 20 seconds before it and use it if there is anything there. You may quote the words as a chat line.', '')
    for (const h of ins.highlights) L.push(`- ${mmss(h.at_sec)} (${h.at_sec}s) **${h.player}** (${h.kit}): "${h.text}"${h.near_kill ? ` [near: ${h.near_kill}]` : ''}`)
    L.push('')
  }
  if (ins.teams.length) {
    L.push('## Teaming', '', 'Pairs that stayed together without fighting each other (teaming). Call it what it is.', '')
    for (const t of ins.teams.slice(0, 6)) L.push(`- **${t.players[0]}** (${t.kits[0]}) and **${t.players[1]}** (${t.kits[1]}): together ${mmss(t.together_sec)} in total, ${t.began}, ${mmss(t.from_sec)}-${mmss(t.to_sec)}; ${t.kills_together} kill${t.kills_together === 1 ? '' : 's'} between them in that time.${t.betrayal ? ` It ended with ${t.betrayal.killer} killing ${t.betrayal.victim} at ${mmss(t.betrayal.at_sec)}.` : ''}`)
    L.push('')
  }
  if (ins.stews.length) {
    L.push('## Stews', '', 'Mushroom stew heals instantly, so fights are won by who drinks faster. Five or more inside five seconds is hotkeying (number keys, no menu).', '')
    for (const s of ins.stews.slice(0, 8)) L.push(`- **${s.player}**: ${s.total} stew${s.total === 1 ? '' : 's'}; fastest run ${s.best_5s} in 5 s at ${mmss(s.best_at_sec)}${s.hotkeying ? ' (hotkeying)' : ''}`)
    for (const f of ins.fight_stews.slice(0, 10)) L.push(`- kill at ${mmss(f.at_sec)}: ${f.killer} drank ${f.killer_stews}, ${f.victim} drank ${f.victim_stews} in the 30 s before it`)
    L.push('')
  }
  if (ins.towers.length) {
    L.push('## Towering', '', 'A one-block pillar straight up to camp on top of (usually a Stomper or a Fisherman, little armour, snowballs).', '')
    for (const t of ins.towers.slice(0, 5)) L.push(`- **${t.player}** (${t.kit}) built a ${t.height}-block tower at x ${t.where[0]}, z ${t.where[1]}, ${mmss(t.from_sec)}-${mmss(t.to_sec)}; ${t.later}`)
    L.push('')
  }
  if (ins.quiet_deaths.length) {
    L.push('## Deaths nobody caused', '')
    for (const d of ins.quiet_deaths) L.push(`- ${mmss(d.at_sec)} **${d.player}** (${d.kit}) ${d.how}.${d.note ? ' ' + d.note : ''}`)
    L.push('')
  }
  if (ins.plain && ins.plain.length) {
    L.push('## In plain words', '', 'Each player\'s match with the numbers already turned into what they meant. Narrate from these, not from the raw hp, damage and block counts above.', '')
    for (const p of ins.plain) L.push(`- **${p.player}** (${p.kit}) ${p.words}.`)
    L.push('')
  }
  if (ins.facts.length) {
    L.push('## Rules worth a mention this time', '', 'Only these, and only if they serve the story. Leave out any rule not listed here.', '')
    for (const f of ins.facts) L.push(`- ${f}`)
    L.push('')
  }
  return L.join('\n')
}

module.exports = { build, toMarkdown, CAUSES }
