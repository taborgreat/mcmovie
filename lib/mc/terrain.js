'use strict'
// Location scouting on the natural-terrain set world. A staged story needs a
// place to stand: this picks a spot, checks it is land and flat enough for
// blocking, and writes terrain.json for the planner (where the stage is, how
// high the ground is, what biome, where the trees are). The stage itself is
// cleared of trees at shoot time; everything around it stays wild.
const path = require('path')
const { Vec3 } = require('vec3')
const U = require('../util')
const server = require('./server')
const { Director } = require('./director')

const STAGE = 28 // blocks square
const STEP = 2

const biomes = require('minecraft-data')(server.MC_VERSION).biomes
function column (bot, x, z) {
  for (let y = 140; y >= 50; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    // water, lava and ice (a frozen sea is flat, but it is not land)
    if (b.name === 'water' || b.name === 'lava' || /ice$/.test(b.name)) return { y, wet: true }
    if (b.boundingBox !== 'block' || b.name === 'snow' || /leaves|log|wood|mushroom_block|bamboo/.test(b.name)) continue
    const biome = b.biome ? (b.biome.name || (biomes[b.biome.id] && biomes[b.biome.id].name) || null) : null
    return { y, block: b.name, biome }
  }
  return null
}

function treesIn (bot, x0, z0, size, groundY) {
  const trees = []
  for (let x = x0; x < x0 + size; x++) {
    for (let z = z0; z < z0 + size; z++) {
      for (let y = groundY + 1; y <= groundY + 3; y++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && /_log$/.test(b.name)) { trees.push([x, z]); break }
      }
    }
  }
  return trees
}

// Survey a square around (cx, cz); returns the best stage in it, or null.
function survey (bot, cx, cz, reach = 44) {
  const n = Math.floor(reach * 2 / STEP) + 1
  const grid = []
  for (let i = 0; i < n; i++) {
    const row = []
    for (let j = 0; j < n; j++) row.push(column(bot, cx - reach + j * STEP, cz - reach + i * STEP))
    grid.push(row)
  }
  const cells = STAGE / STEP
  let best = null
  for (let r = 0; r + cells <= n; r += 2) {
    for (let c = 0; c + cells <= n; c += 2) {
      const vals = []; let bad = false
      for (let i = 0; i < cells && !bad; i++) for (let j = 0; j < cells; j++) { const g = grid[r + i][c + j]; if (!g || g.wet) { bad = true; break } vals.push(g.y) }
      if (bad) continue
      vals.sort((a, b) => a - b)
      const median = vals[Math.floor(vals.length / 2)]
      const spread = vals[vals.length - 1] - vals[0]
      const rough = vals.filter(v => Math.abs(v - median) > 1).length / vals.length
      const score = spread + rough * 10
      if (!best || score < best.score) best = { score, spread, rough, ground: median, x: cx - reach + c * STEP, z: cz - reach + r * STEP, biome: grid[r + Math.floor(cells / 2)][c + Math.floor(cells / 2)].biome, surface: grid[r + Math.floor(cells / 2)][c + Math.floor(cells / 2)].block }
    }
  }
  return best
}

// Find a stage. Tries several places in the world until one is good land.
async function pick (opts = {}) {
  const cfg = { ...server.config(), version: server.MC_VERSION }
  if (cfg.terrain !== 'normal') throw new Error('the set server is a flat world; run: mcmovie server:setup --terrain normal')
  let started = null
  if (!(await server.isUp(cfg.host, cfg.port))) started = await server.start()
  const director = new Director(cfg)
  await director.connect()
  const rand = opts.seed !== undefined ? (() => { let h = opts.seed >>> 0; return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })() : Math.random
  try {
    let found = null
    let fallback = null // the best dry land seen, in case nothing is properly flat
    for (let attempt = 0; attempt < (opts.attempts || 16) && !found; attempt++) {
      const cx = opts.near ? opts.near[0] : Math.round((rand() - 0.5) * 6000 / 16) * 16
      const cz = opts.near ? opts.near[1] : Math.round((rand() - 0.5) * 6000 / 16) * 16
      await director.hover([cx, 110, cz], 30)
      await director.waitForChunks([cx, 0, cz], 4, 60000)
      const s = survey(director.bot, cx, cz)
      U.log('terrain', `candidate ${cx},${cz}: ${s ? `${s.biome}, ground ${s.ground}, spread ${s.spread}, rough ${(s.rough * 100).toFixed(0)}%` : 'water or no data'}`)
      if (s && s.spread <= 5 && s.rough <= 0.25) found = s
      else if (s && s.spread <= 10 && (!fallback || s.score < fallback.score)) fallback = s
      if (opts.near) break
    }
    if (!found && fallback) { found = fallback; U.log('terrain', 'nothing properly flat; using the gentlest slope found') }
    if (!found) throw new Error('no dry land found; try again or pass --near x,z')
    const trees = treesIn(director.bot, found.x, found.z, STAGE, found.ground)
    const center = [found.x + STAGE / 2, found.ground + 1, found.z + STAGE / 2]
    const terrain = {
      world: 'natural terrain', biome: found.biome, surface_block: found.surface,
      ground_y: found.ground, feet_y: found.ground + 1,
      stage: { from: [found.x, found.ground, found.z], to: [found.x + STAGE - 1, found.ground, found.z + STAGE - 1], size: STAGE, height_spread: found.spread },
      origin: center,
      trees_cleared_at_shoot: trees.length,
      notes: [
        `The stage is a ${STAGE}x${STAGE} patch of real ${String(found.biome).replace(/_/g, ' ')} terrain. Its ground block is at y=${found.ground} (varies by up to ${found.spread}); feet stand at y=${found.ground + 1} and actors settle onto the real ground by themselves.`,
        'Trees on the stage are removed before shooting; grass, flowers and everything outside the stage stay. Hills, trees and animals around it are the backdrop: use them.',
        'Do not pave or flatten the stage. Build only the few small things the story needs (a campfire, a fence, a tent, a grave, a chest) on top of the ground.'
      ]
    }
    if (opts.out) U.writeJson(opts.out, terrain)
    return terrain
  } finally {
    await director.disconnect()
    if (started) await started.stop()
  }
}

module.exports = { pick, survey, STAGE }
