'use strict'
// A 20-beats-a-second clock that stays in step with the server's own ticks.
//
// The shoot sends one batch of positions and camera moves per beat, and the server applies
// whatever has arrived at the start of each of its ticks. If our beat drifts onto the server's
// tick boundary, some server ticks get two batches and some get none, and everything on
// screen (camera and actors) stutters for as long as the two stay close. So the clock
// listens for the server's once-a-second time packet, works out where its tick boundary
// falls, and keeps every beat half a tick away from it.
const U = require('../util')

class TickClock {
  constructor (director) {
    this.d = director
    this.t0 = 0
  }

  // where in a 50 ms window the server's tick boundary falls, or null if not known yet
  phase () {
    const ts = (this.d.tickTimes || []).slice(-6)
    if (ts.length < 2) return null
    let sx = 0; let sy = 0
    for (const t of ts) { const a = (t % 50) / 50 * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a) }
    let a = Math.atan2(sy, sx)
    if (a < 0) a += 2 * Math.PI
    return a / (2 * Math.PI) * 50
  }

  start () {
    const now = Date.now()
    const ph = this.phase()
    this.t0 = ph === null ? now : now + ((((ph + 25) % 50) - (now % 50)) + 50) % 50
    this.locked = ph !== null
  }

  // Sleep until beat n (0 is the first). Returns false if that moment has already passed.
  async wait (n) {
    const ph = this.phase()
    if (ph !== null) {
      // drift correction: lean a tenth of the way back toward mid-tick every beat
      let err = ((ph + 25) % 50) - (this.t0 % 50)
      err = ((err + 75) % 50) - 25
      this.t0 += err * 0.1
    }
    const w = this.t0 + n * 50 - Date.now()
    if (w > 0) { await U.sleep(w); return true }
    return false
  }
}

module.exports = { TickClock }
