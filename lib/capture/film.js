'use strict'
// Filming a live scene with the real Minecraft client (lib/capture/client.js).
//
// One invisible camera entity per cut is placed in the world. The client
// spectates the camera of the cut that is on screen, so cuts happen in camera
// while the bots act the scene once. The cameras are item displays moved every
// tick: the game eases them between ticks, and the OnGround flip makes the
// server send the exact position and angle instead of its rounded ones (no
// stepping on slow pans). A pov cut spectates the actor itself.
//
// The whole take is recorded off the virtual display, then split into one clip
// per cut. A "clap" (a hard switch from a slate view to the first camera at a
// known tick) lines the recording up with the tick clock, and each cut is
// snapped to the frame where the picture actually changes.
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { Vec3 } = require('vec3')
const U = require('../util')
const { CameraPath, resolvePoint } = require('../camera')
const client = require('./client')

const CLAP_TICK = -6 // scene tick of the slate -> first camera switch (inside the shoot's preroll)
const LATENCY = 0.1 // seconds from a command to the client showing/hearing it

function notchYaw (yaw) { let d = U.rad2deg(Math.PI - yaw) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d }
function notchPitch (pitch) { return Math.max(-90, Math.min(90, U.rad2deg(-pitch))) }

class Film {
  constructor ({ director, dir, fps, width, height, lift = true }) {
    this.director = director
    this.dir = dir
    this.fps = fps
    this.width = width
    this.height = height
    this.lift = lift // false: leave a dark take dark (the outro's cave)
    this.cfg = client.config()
    this.lens = this.cfg.username
    this.flips = new Map()
  }

  tag (i) { return `mcam_${i}` }

  block (x, y, z) { return this.director.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))) }

  // Is the lens in or touching a solid block? (a camera closer than ~0.3 to a face sees through it)
  solid (x, y, z, margin = 0.3) {
    for (let bx = Math.floor(x - margin); bx <= Math.floor(x + margin); bx++) {
      for (let by = Math.floor(y - margin); by <= Math.floor(y + margin); by++) {
        for (let bz = Math.floor(z - margin); bz <= Math.floor(z + margin); bz++) {
          const b = this.block(bx, by, bz)
          if (!b) return true // unloaded terrain is not a safe camera position
          const shapes = b.shapes || (b.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
          for (const s of shapes) {
            if (x + margin > bx + s[0] && x - margin < bx + s[3] &&
                y + margin > by + s[1] && y - margin < by + s[4] &&
                z + margin > bz + s[2] && z - margin < bz + s[5]) return true
          }
        }
      }
    }
    return false
  }

  plant (x, y, z) {
    const b = this.block(x, y, z)
    return !!b && b.name !== 'air' && b.boundingBox !== 'block' && !/water|lava/.test(b.name)
  }

  // Camera pose for a cut at tick t, placed in the real world.
  //
  // The plan says where the camera wants to be; the world decides where it can be. A camera
  // aimed at a player keeps its line of sight: if a wall, a hill or a canopy comes between
  // them, the camera slides in along that line until it sees them again (quickly), and eases
  // back out when the way is clear (slowly), the way a chase camera does. It never jumps a
  // block at a time, never films the inside of a hill, and never loses its subject behind one.
  pose (c, t, ctx, settle = false) {
    const p = c.cam.evaluate(Math.max(c.local_start, Math.min(t, c.local_end)), ctx)
    if (p.hide) return p
    if (c.cam.cut) { c.state = null; p.cut = true }
    const st = c.state || (c.state = {})
    // settle: the camera is being parked on its mark before its cut, so it takes the answer
    // outright. Once the cut is live nothing is outright any more: every change is eased from
    // where the parked camera already is, so a shot never opens with a lurch.
    const fresh = settle || st.t === undefined || t < st.t || t - st.t > 4
    const pos = { x: p.x, y: p.y, z: p.z }
    // Actors can cross a close-up lens even when the terrain ray is clear.
    // Use the already sampled scene actors, without new game queries.
    const bodies = typeof ctx.actors === 'function' ? ctx.actors() : []
    const inBody = (x, y, z) => bodies.some(a => a && !a.invisible && !a.dying && y > a.y - 0.15 && y < a.y + 2.05 && Math.hypot(x - a.x, z - a.z) < 0.85)
    let aim = c.cam.target
    const targetSpec = c.shot.path && (c.shot.path.look || c.shot.path.target)
    if (!aim && targetSpec && targetSpec !== 'forward' && !(typeof targetSpec === 'object' && 'yaw' in targetSpec)) {
      try { aim = resolvePoint(targetSpec, ctx, t) } catch { /* no live target */ }
    }
    // The vanilla filming client has one fixed lens for the take. Match the
    // planned subject size by adjusting distance for that actual lens; otherwise
    // a planned 55-degree close-up filmed at 92 degrees becomes a wide shot.
    const lens = this.height > this.width ? this.cfg.fov_portrait : this.cfg.fov
    if (aim && p.fov && lens && Math.abs(p.fov - lens) > 0.1) {
      const dx = pos.x - aim.x; const dy = pos.y - aim.y; const dz = pos.z - aim.z
      const distance = Math.hypot(dx, dy, dz)
      const ratio = Math.tan(U.deg2rad(p.fov) / 2) / Math.tan(U.deg2rad(lens) / 2)
      const scale = distance > 0.01 ? Math.max(1.4, distance * ratio) / distance : 1
      pos.x = aim.x + dx * scale; pos.y = aim.y + dy * scale; pos.z = aim.z + dz * scale
    }
    // the point the camera must be able to see: what it is aimed at, or, when that spot is
    // itself inside a block (the middle of two players either side of a wall), one of them
    let tgt = aim
    if (aim && this.opaque(aim.x, aim.y, aim.z)) {
      for (const who of this.subjects(c.shot.path)) {
        const a = ctx.actor(who, t)
        if (a && !this.opaque(a.x, a.y + 1.62, a.z)) { tgt = { x: a.x, y: a.y + 1.62, z: a.z }; break }
      }
    }
    let seen = false
    if (tgt) {
      const dx = pos.x - tgt.x; const dy = pos.y - tgt.y; const dz = pos.z - tgt.z
      const full = Math.hypot(dx, dy, dz)
      if (full > 0.5) {
        // how far the camera can back away from the subject in a direction before something is in the way
        const freeAlong = (vx, vy, vz) => {
          const length = Math.hypot(vx, vy, vz)
          for (let d = 0.4; d <= length + 0.25; d += 0.25) {
            const k = Math.min(1, d / length)
            const x = tgt.x + vx * k; const y = tgt.y + vy * k; const z = tgt.z + vz * k
            // Start outside the subject's own body (including two players in contact).
            if (this.solid(x, y, z) || (d > 1 && inBody(x, y, z))) return Math.max(0, d - 0.65)
          }
          return length
        }
        const turned = (deg, up) => { const r = U.deg2rad(deg); const c2 = Math.cos(r); const s2 = Math.sin(r); return [dx * c2 - dz * s2, dy + up, dx * s2 + dz * c2] }
        // The planned side is best. If a wall is on that side, swing round the subject (and a
        // little higher) to the nearest side with room, rather than squeezing against the wall.
        let want = st.turn || 0; let wantUp = st.up || 0
        const here = freeAlong(...turned(want, wantUp))
        const tight = here < Math.min(full * 0.5, 3)
        const urgent = here < 1.2 || inBody(pos.x, pos.y, pos.z)
        // A trunk or a branch crossing the line for a moment is just something passing the lens:
        // the camera holds still. It only reacts to something that stays in the way.
        st.blocked = urgent ? 99 : (fresh ? (tight ? 99 : 0) : (tight ? (st.blocked || 0) + 1 : 0))
        st.clear = fresh ? 0 : (here >= Math.min(full * 0.9, 3.5) ? (st.clear || 0) + 1 : 0)
        st.hold = fresh || urgent ? 0 : Math.max(0, (st.hold || 0) - 1)
        if (st.blocked >= 12 && st.hold === 0) {
          // swing round to a clear side (or rise), then stay there: no hunting from side to side
          let best = { score: -1e9 }
          for (const up of [0, 2, 4]) {
            for (const deg of [0, 30, -30, 60, -60, 100, -100, 150, -150]) {
              const f = freeAlong(...turned(deg, up))
              const score = Math.min(f, full) - 0.014 * Math.abs(deg - want) - 0.006 * Math.abs(deg) - 0.15 * up
              if (score > best.score) best = { score, deg, up, f }
            }
          }
          if (best.deg !== want || best.up !== wantUp) { want = best.deg; wantUp = best.up; st.hold = 50 }
        } else if ((want !== 0 || wantUp !== 0) && st.hold === 0 && st.clear >= 30 && freeAlong(dx, dy, dz) >= Math.min(full * 0.9, 3.5)) {
          want = 0; wantUp = 0; st.hold = 50 // the planned side has been open for a while: drift back
        }
        st.turn = want; st.up = wantUp
        const turnDelta = ((want - st.ang) % 360 + 540) % 360 - 180
        st.ang = fresh || urgent ? want : st.ang + 0.06 * turnDelta
        st.rise = fresh || urgent ? wantUp : st.rise + 0.06 * (wantUp - st.rise)
        const [vx, vy, vz] = turned(st.ang, st.rise)
        const length = Math.hypot(vx, vy, vz)
        const free = freeAlong(vx, vy, vz)
        // Never ease through a wall. Retreat immediately, then recover slowly.
        if (fresh || urgent) st.dist = free
        else if (free < st.dist) st.dist = free; else st.dist += 0.035 * (free - st.dist)
        if (st.dist > full) st.dist = full
        const k = Math.min(1, st.dist / length)
        pos.x = tgt.x + vx * k; pos.y = tgt.y + vy * k; pos.z = tgt.z + vz * k
        seen = true
      }
    }
    // A camera with nothing to keep in sight (a fixed wide shot planned inside a slope) rises
    // out of the ground, eased. One that is holding a line of sight only needs to not be inside
    // a block: lifting it would take it through a cave roof and lose the subject.
    let lift = 0
    if (!seen) {
      while (lift < 9 && this.solid(pos.x, pos.y + lift, pos.z)) lift += 0.25
      while (lift < 11 && this.plant(pos.x, pos.y + lift, pos.z)) lift += 0.5
    }
    st.lift = fresh ? lift : st.lift + (lift > st.lift ? 0.45 : 0.08) * (lift - st.lift)
    if (!seen) pos.y += st.lift
    // A blocked ray used to collapse to distance zero, putting the lens inside
    // its subject. Keep a safe previous frame, or stop this take for a retry.
    const safe = q => q && !this.solid(q.x, q.y, q.z) && !inBody(q.x, q.y, q.z)
    if (!safe(pos)) {
      if (!fresh && safe(st.safe)) Object.assign(pos, st.safe)
      else throw new Error(`camera ${c.shot.id || 'shot'} has no clear lens position at tick ${t}; choose another angle`)
    }
    if (![pos.x, pos.y, pos.z, p.yaw, p.pitch].every(Number.isFinite)) throw new Error('non-finite camera pose at tick ' + t)
    st.safe = { ...pos }
    st.t = t
    const look = tgt ? U.lookAt(pos, tgt === aim ? aim : { x: (aim.x + tgt.x) / 2, y: (aim.y + tgt.y) / 2, z: (aim.z + tgt.z) / 2 }) : { yaw: p.yaw, pitch: p.pitch }
    return { ...p, ...pos, ...look }
  }

  // the players a shot is about, lead first
  subjects (path) {
    const out = []
    const add = v => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object' && !Array.isArray(v)) { if (v.actor) out.push(v.actor); if (Array.isArray(v.between)) out.push(...v.between) } }
    add(path.actor); add(path.look); add(path.target)
    return [...new Set(out)]
  }

  // does this spot block the view? (any full block, leaves included)
  opaque (x, y, z) { return this.solid(x, y, z, 0) }

  move (i, p, cut = false) {
    // Each camera needs its own toggle. Pre-positioning the next camera must
    // not cancel the current camera's full-precision movement updates.
    const flip = !this.flips.get(i); this.flips.set(i, flip)
    this.director.cmd(`/data merge entity @e[tag=${this.tag(i)},limit=1] {teleport_duration:${cut || p.cut ? 0 : 3},Pos:[${p.x.toFixed(4)}d,${p.y.toFixed(4)}d,${p.z.toFixed(4)}d],Rotation:[${notchYaw(p.yaw).toFixed(3)}f,${notchPitch(p.pitch).toFixed(3)}f],OnGround:${flip ? 1 : 0}b}`)
  }

  // cuts: this scene's cuts from timeline.json. shots: timeline shots by id. ctx: { actor(id, t) }.
  async begin (scene, cuts, shots, ctx, center) {
    const d = this.director
    this.scene = scene
    this.cuts = cuts.slice().sort((a, b) => a.local_start - b.local_start).map((c, i) => {
      const shot = shots.find(s => s.id === c.shot_id)
      return { ...c, i, shot, cam: new CameraPath({ ...shot, start_tick: shot.local_start, end_tick: shot.local_end }) }
    })
    for (let i = 1; i < this.cuts.length; i++) {
      if (this.cuts[i].local_start < this.cuts[i - 1].local_end) U.log('capture', `warning: cuts ${this.cuts[i - 1].shot_id} and ${this.cuts[i].shot_id} overlap; one live take can only show one camera at a time`)
    }
    this.current = null
    this.flips.clear()
    d.cmd('/kill @e[tag=mcam]')
    d.cmd('/team add mcrew'); d.cmd('/team modify mcrew nametagVisibility never'); d.cmd(`/team join mcrew ${d.username}`); d.cmd(`/team join mcrew ${this.lens}`)
    d.cmd(`/gamemode spectator ${this.lens}`)
    d.cmd(`/tp ${this.lens} ${center[0]} ${center[1] + 6} ${center[2]}`)
    await U.sleep(300)
    // slate: straight down from above the set, at an angle no shot uses
    d.cmd(`/summon item_display ${center[0]} ${center[1] + 45} ${center[2]} {Tags:["mcam","mcam_slate"],teleport_duration:3,Rotation:[37f,90f]}`)
    for (const c of this.cuts) {
      c.cam.reset(); c.state = null
      const p = this.pose(c, c.local_start, ctx, true)
      d.cmd(`/summon item_display ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)} {Tags:["mcam","${this.tag(c.i)}"],teleport_duration:3,Rotation:[${notchYaw(p.yaw).toFixed(2)}f,${notchPitch(p.pitch).toFixed(2)}f]}`)
      await U.sleep(40)
    }
    await U.sleep(400)
    d.cmd(`/spectate @e[tag=mcam_slate,limit=1] ${this.lens}`)
    await U.sleep(2500) // terrain around the set draws in

    fs.mkdirSync(path.join(this.dir, 'capture'), { recursive: true })
    this.file = path.join(this.dir, 'capture', `scene_${scene.id}.mkv`)
    const enc = this.cfg.encoder === 'h264_nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'constqp', '-qp', '16']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14']
    this.ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', String(this.fps), '-video_size', `${this.width}x${this.height}`,
      '-i', this.cfg.display, ...enc, '-pix_fmt', 'yuv420p', this.file], { stdio: ['pipe', 'ignore', 'pipe'] })
    this.ffErr = ''
    this.ff.stderr.on('data', b => { this.ffErr += b })
    this.ffDone = new Promise(resolve => {
      this.ff.on('close', resolve)
      this.ff.on('error', e => { this.ffErr += e.message; resolve(1) })
    })
    this.spawnWall = Date.now()
    await U.sleep(1500)
  }

  switchTo (c, ctx, t) {
    c.cam.reset() // a follow camera starts on its mark, not easing in from where it was parked
    const p = this.pose(c, t, ctx, true)
    if (p.hide) this.director.cmd(`/spectate ${p.hide} ${this.lens}`)
    else { this.move(c.i, p, true); this.director.cmd(`/spectate @e[tag=${this.tag(c.i)},limit=1] ${this.lens}`) }
    this.current = c
  }

  // Called once per scene tick, after the actors moved. ctx.actor(id, t) gives live positions.
  tick (t, ctx) {
    if (t < CLAP_TICK) {
      // keep the first camera on its mark while the actors settle
      const c = this.cuts[0]; c.cam.reset(); const p = this.pose(c, c.local_start, ctx, true)
      if (!p.hide) this.move(c.i, p)
      return
    }
    if (t === CLAP_TICK) {
      this.clapWall = Date.now()
      this.clapWav = client.wavPosition()
      this.switchTo(this.cuts[0], ctx, this.cuts[0].local_start)
      return
    }
    let want = this.current
    for (const c of this.cuts) if (t >= c.local_start && c.local_start >= want.local_start) want = c
    if (want !== this.current) { this.switchTo(want, ctx, t); return }
    const c = this.current
    const p = this.pose(c, t, ctx)
    if (!p.hide) this.move(c.i, p)
    // put the next camera on its mark shortly before its cut
    const next = this.cuts[c.i + 1]
    if (next && next.local_start - t <= 10) {
      next.cam.reset()
      const np = this.pose(next, next.local_start, ctx, true)
      if (!np.hide) this.move(next.i, np)
    }
  }

  async end () {
    await U.sleep(400)
    try { this.ff.stdin.write('q') } catch {}
    const code = await this.ffDone
    this.director.cmd(`/spectate @e[tag=mcam_slate,limit=1] ${this.lens}`)
    await U.sleep(200)
    this.director.cmd('/kill @e[tag=mcam]')
    if (code !== 0 || !U.exists(this.file)) throw new Error(`screen capture failed: ${this.ffErr.trim().split('\n').pop() || 'ffmpeg exit ' + code}`)
    // freeze the game sound for this take (the wav keeps growing while the client runs)
    this.wav = null
    if (this.clapWav !== null && this.clapWav !== undefined && U.exists(client.WAV)) {
      this.wav = path.join(this.dir, 'capture', `scene_${this.scene.id}.wav`)
      const from = Math.max(0, this.clapWav - 1)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ignore_length', '1', '-ss', from.toFixed(3), '-i', client.WAV, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', this.wav])
      this.wavClap = this.clapWav - from
    }
  }

  async abort () {
    if (!this.ff || this.ff.exitCode !== null || this.ff.signalCode !== null) return
    try { this.ff.stdin.write('q') } catch {}
    const timer = setTimeout(() => { try { this.ff.kill('SIGKILL') } catch {} }, 3000)
    try { await this.ffDone } finally { clearTimeout(timer) }
  }

  static assertCoverage (frames, start, duration, fps) {
    if (!frames.length || start < frames[0].t - 1 / fps || frames.at(-1).t + 2 / fps < start + duration) {
      throw new Error('capture does not cover the planned cut; refusing to hide missing footage with a frozen frame')
    }
  }

  // How much the picture changes at each frame of the take.
  motion () {
    const out = path.join(this.dir, 'capture', `scene_${this.scene.id}.mafd`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', this.file, '-vf', `scale=320:-2,scdet=t=0:s=0,metadata=mode=print:key=lavfi.scd.mafd:file=${out}`, '-f', 'null', '-'])
    const frames = []
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      const m = line.match(/pts_time:([\d.]+)/)
      if (m) frames.push({ t: parseFloat(m[1]), mafd: 0 })
      const v = line.match(/lavfi\.scd\.mafd=([\d.]+)/)
      if (v && frames.length) frames[frames.length - 1].mafd = parseFloat(v[1])
    }
    fs.unlinkSync(out)
    return frames
  }

  // Frame with the biggest picture change within [t - before, t + after]; null if nothing stands out.
  static snap (frames, t, before, after, minRatio = 3) {
    const win = frames.filter(f => f.t >= t - before && f.t <= t + after)
    if (!win.length) return null
    const best = win.reduce((a, b) => (b.mafd > a.mafd ? b : a))
    const rest = win.filter(f => f !== best).map(f => f.mafd).sort((a, b) => a - b)
    const median = rest.length ? rest[Math.floor(rest.length / 2)] : 0
    return best.mafd >= Math.max(2, median * minRatio) ? best : null
  }

  // Split the take into one clip per cut. Returns [{ cut, clip, frames }].
  async finish () {
    const frames = this.motion()
    if (frames.length < 10) throw new Error(`screen capture of scene ${this.scene.id} is empty`)
    const guess = (this.clapWall - this.spawnWall) / 1000 - 0.3 + LATENCY
    const clap = Film.snap(frames, guess, 1.5, 1.5)
    if (!clap) U.log('capture', `warning: scene ${this.scene.id}: could not see the clap; timing the take from the clock`)
    const clapT = clap ? clap.t : guess
    const videoAt = tick => clapT + (tick - CLAP_TICK) / 20
    const enc = this.cfg.encoder === 'h264_nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17']
    fs.mkdirSync(path.join(this.dir, 'clips'), { recursive: true })
    const outputs = []
    // where each cut really begins in the take: the frame the picture jumps to its camera
    const starts = this.cuts.map((c, i) => {
      const t = videoAt(c.local_start)
      if (i === 0) return t + 2 / this.fps
      const s = Film.snap(frames, t + LATENCY, 0.25, 0.3)
      return s ? s.t : t + LATENCY
    })
    // Cut on the frame the camera actually switched. The switch can land a few frames either
    // side of the plan; rather than freeze a clip's last frame to fill the gap (a visible
    // hitch before the cut) or show a frame of the wrong camera, the edit follows the take:
    // every recorded frame is used once, and a cut moves by at most a few frames. The scene
    // as a whole keeps its planned length.
    const f0 = Math.round(this.cuts[0].local_start / 20 * this.fps)
    const planned = this.cuts.map(c => Math.round(c.local_start / 20 * this.fps) - f0)
    const bounds = this.cuts.map((c, i) => {
      if (i === 0) return 0
      const prev = this.cuts[i - 1]
      const real = Math.round((starts[i] - starts[0]) * this.fps)
      // only where one cut runs straight into the next, and only for small differences
      return prev.local_end === c.local_start && Math.abs(real - planned[i]) <= 8 ? real : planned[i]
    })
    for (const c of this.cuts) {
      const next = this.cuts[c.i + 1]
      const want = Math.max(1, Math.round((c.local_end - c.local_start) / 20 * this.fps))
      const n = next && next.local_start === c.local_end ? Math.max(1, bounds[c.i + 1] - bounds[c.i]) : Math.max(1, Math.round(c.local_end / 20 * this.fps) - f0 - bounds[c.i])
      const dur = n / this.fps
      const start = c.i === 0 ? starts[0] : starts[0] + bounds[c.i] / this.fps
      Film.assertCoverage(frames, start, dur, this.fps)
      const clip = path.join('clips', `${c.shot_id.replace(/[^A-Za-z0-9_.-]/g, '_')}.mp4`)
      // how dark is this stretch of the take? A cave or a night fight gets a gentle lift
      // (gamma only, so blacks stay black); daylight is left exactly as filmed.
      let lift = ''
      if (this.lift) try {
        const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-t', Math.min(dur, 20).toFixed(3), '-i', this.file, '-vf', 'fps=2,scale=160:-2,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { maxBuffer: 4e6 }).toString()
        const ys = [...out.matchAll(/YAVG=([\d.]+)/g)].map(m => parseFloat(m[1]))
        if (ys.length) { const y = ys.reduce((a, b) => a + b, 0) / ys.length; if (y < 62) lift = `,eq=gamma=${U.clamp(1 + (62 - y) / 85, 1.05, 1.4).toFixed(2)}` }
      } catch { /* leave it as filmed */ }
      const args = ['-y', '-loglevel', 'error', '-ss', Math.max(0, start - 0.2 / this.fps).toFixed(4), '-i', this.file]
      if (this.wav) args.push('-ss', Math.max(0, this.wavClap + LATENCY + (start - clapT)).toFixed(4), '-t', dur.toFixed(4), '-i', this.wav)
      else args.push('-f', 'lavfi', '-t', dur.toFixed(4), '-i', 'anullsrc=r=48000:cl=stereo')
      args.push('-filter_complex', `[0:v]fps=${this.fps}${lift},tpad=stop_mode=clone:stop_duration=${Math.ceil(dur) + 2}[v];[1:a]apad[a]`, '-map', '[v]', '-map', '[a]',
        '-frames:v', String(n), '-t', dur.toFixed(4), ...enc, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', path.join(this.dir, clip))
      execFileSync('ffmpeg', args)
      U.log('capture', `cut ${c.shot_id}: ticks ${c.local_start}-${c.local_end} -> ${n} frames from ${start.toFixed(2)}s of the take${n !== want ? ` (cut moved ${n - want > 0 ? '+' : ''}${n - want} frames to the real switch)` : ''}`)
      outputs.push({ cut: c, clip, frames: n })
    }
    if (!this.cfg.keep_capture) { for (const f of [this.file, this.wav]) { try { if (f) fs.unlinkSync(f) } catch {} } }
    return outputs
  }
}

module.exports = { Film, CLAP_TICK }
