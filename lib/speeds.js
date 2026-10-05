'use strict'
// The timing model. The planner never guesses durations: it uses these numbers
// and the shoot controller moves actors at exactly these speeds, so planned
// ticks and real ticks agree.

const TICK_RATE = 20

// blocks per second
const SPEEDS = {
  idle: 0,
  walk: 4.317,
  sprint: 5.612,
  sneak: 1.295,
  crouch: 1.295,
  swim: 2.2,
  climb: 2.35,
  swing: 4.317, // swing while moving: walking speed
  jump: 4.317,
  fly: 10.0, // free movement (camera, creative). planner may use for flying mobs
  knockback: 40, // not a speed: the arc is simulated (knockbackPath); this only bounds the check
  fall: 0 // vertical, handled by gravity; use ticksForFall
}

// Movement modes that persist across a segment vs one-shot actions.
const MOVEMENT_ANIMS = ['idle', 'walk', 'sprint', 'sneak', 'crouch', 'swim', 'climb', 'swing', 'jump', 'fly', 'knockback']

// Being hit, the way it works on hardcorepvp: the server's own knockback settings
// (hardcorekits config.yml, combat.knockback: the 1.8 formula). A hit shoves the victim
// away and lifts them; each knockback level (the enchantment, or a sprint hit = one level)
// adds more along the attacker's facing. Then the game's own physics: gravity 0.08 a tick,
// air drag, and a short slide on landing.
const KNOCKBACK = { horizontal: 0.4, vertical: 0.4, vertical_limit: 0.4, extra_horizontal: 0.5, extra_vertical: 0.1 }

// level: 0 = a plain hit, 1 = a sprint hit or Knockback I, 2 = Knockback II (Grandpa's stick)...
// drop: how far below the launch point the landing is (negative = off a ledge).
// Returns the distance from the launch point and the height above it at every tick.
function knockbackPath (level = 0, drop = 0) {
  let h = KNOCKBACK.horizontal + KNOCKBACK.extra_horizontal * level
  let v = Math.min(KNOCKBACK.vertical, KNOCKBACK.vertical_limit) + KNOCKBACK.extra_vertical * level
  let d = 0; let y = 0
  const pts = [{ d: 0, y: 0 }]
  let airTicks = 0
  for (let i = 0; i < 400; i++) {
    d += h; y += v
    h *= 0.91
    v = (v - 0.08) * 0.98
    if (v < 0 && y <= Math.min(0, drop)) { y = Math.min(0, drop); pts.push({ d, y }); airTicks = pts.length - 1; break }
    pts.push({ d, y })
  }
  if (!airTicks) airTicks = pts.length - 1
  // slide to a stop on the ground
  for (let i = 0; i < 12 && h > 0.02; i++) { h *= 0.546; d += h; pts.push({ d, y }) }
  return { pts, ticks: pts.length - 1, air_ticks: airTicks, distance: d }
}
const ONESHOT_ANIMS = ['hurt', 'death', 'respawn', 'hold', 'drop', 'wear', 'swing_once', 'jump_once']

function speedFor (anim) {
  const base = String(anim || 'walk').split(':')[0]
  return SPEEDS[base] !== undefined ? SPEEDS[base] : SPEEDS.walk
}

function ticksForMove (distanceBlocks, anim) {
  const s = speedFor(anim)
  if (s <= 0) return 0
  return Math.ceil(distanceBlocks / (s / TICK_RATE))
}

function secondsToTicks (sec) { return Math.ceil(sec * TICK_RATE) }
function ticksToSeconds (ticks) { return ticks / TICK_RATE }

// Rough spoken duration of a line. ~2.4 words/sec for acted dialogue plus
// a 0.5 s tail. Punctuation pauses add a little. Validation uses this to warn
// when lines are scheduled too close together; real durations come from TTS.
function estimateLineSeconds (text, opts = {}) {
  const wps = opts.wordsPerSecond || 2.6
  const words = String(text).trim().split(/\s+/).filter(Boolean).length
  const pauses = (String(text).match(/[,.;:!?…]+/g) || []).length
  return Math.max(0.6, words / wps + pauses * 0.12 + 0.35)
}

function estimateLineTicks (text, opts) { return secondsToTicks(estimateLineSeconds(text, opts)) }

module.exports = {
  TICK_RATE, SPEEDS, MOVEMENT_ANIMS, ONESHOT_ANIMS, KNOCKBACK, knockbackPath,
  speedFor, ticksForMove, secondsToTicks, ticksToSeconds, estimateLineSeconds, estimateLineTicks
}
