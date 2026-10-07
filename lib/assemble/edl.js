'use strict'
// timeline.json -> edl.json. Deterministic: same timeline in, same EDL out.
// Video: the cut list in order (one clip per cut). Audio: dialogue WAVs at
// their real tick offsets mapped to video time. If the last line of a scene
// runs past the scene's last cut, that clip is held (frozen last frame) so
// the line is never cut off. Lines that would overlap the previous line are
// delayed (audio only) by the minimum amount.
const path = require('path')
const U = require('../util')
const mixLib = require('./mix')
const outroAsset = require('../outro/asset')

function build (dir, opts = {}) {
  const tl = U.readJson(path.join(dir, 'timeline.json'))
  const fps = opts.fps || tl.fps || 30
  const width = opts.width || 1920; const height = opts.height || 1080
  const cards = tl.cards || {}
  const warnings = []
  const video = []
  let cursor = 0 // seconds of video so far

  const mix = mixLib.load()
  if (mix.title_card && cards.title !== false) {
    const sec = cards.title_seconds || 2.5
    video.push({ card: 'title', text: tl.title || 'Untitled', seconds: sec, at_sec: cursor })
    cursor += sec
  }

  // map global tick -> video seconds, built as cuts are laid down
  const segments = [] // { start_tick, end_tick, at_sec, hold_sec }
  const cuts = tl.cuts.slice().sort((a, b) => a.start_tick - b.start_tick)
  const scenesLastCut = new Map()
  for (const c of cuts) scenesLastCut.set(c.scene_id, c)
  const lines = tl.lines.slice().sort((a, b) => (a.actual_tick !== undefined && a.actual_tick !== null ? a.actual_tick : a.tick) - (b.actual_tick !== undefined && b.actual_tick !== null ? b.actual_tick : b.tick))
  const lineTick = (l) => (l.actual_tick !== undefined && l.actual_tick !== null) ? l.actual_tick : l.tick

  // the effects on offer (config/effects.json): a pausing sting freezes the film for its length
  let fxDefs = {}
  try { fxDefs = require('../media').catalogue().filter(m => ['sting', 'insert', 'transition'].includes(m.type)).reduce((o, m) => { o[m.id] = m; return o }, {}) } catch { fxDefs = {} }
  const pauseStings = [] // { seg, at_sec, id, seconds }
  // each cut becomes one piece, or two around a pausing sting (the first piece holds its last frame while the sting plays)
  const pieces = []
  for (const c of cuts) {
    const len = c.source === 'client' && c.frames && c.fps ? c.frames / c.fps : (c.end_tick - c.start_tick) / tl.tick_rate
    const sc = (tl.scenes || []).find(x => x.id === c.scene_id) || {}
    const here = (sc.stings || []).filter(st => fxDefs[st.id] && fxDefs[st.id].pause && c.local_start <= st.tick && c.local_end > st.tick).sort((a, b) => a.tick - b.tick)
    let from = 0
    for (const st of here) {
      const o = Math.min(len - 0.05, (st.tick - c.local_start) / tl.tick_rate)
      if (o <= from + 0.05) continue
      pieces.push({ c, in_sec: from, out_sec: o, last: false, pause: { id: st.id, seconds: fxDefs[st.id].seconds || 8 } })
      from = o
    }
    pieces.push({ c, in_sec: from, out_sec: len, last: true })
  }
  for (const pc of pieces) {
    const c = pc.c
    // a clip filmed live is as long as the take made it (its cut lands on the real camera switch)
    const len = (pc.out_sec - pc.in_sec) * (((tl.shots || []).find(s => s.id === c.shot_id) || {}).slow > 1 ? +(tl.shots || []).find(s => s.id === c.shot_id).slow : 1)
    const startTick = c.start_tick + Math.round(pc.in_sec * tl.tick_rate)
    // a shot marked slow (the celebration's approach to the winner's face) plays at 1/slow speed
    const shotOf = (tl.shots || []).find(s => s.id === c.shot_id)
    const slow = shotOf && shotOf.slow > 1 ? +shotOf.slow : 1
    const seg = { cut: c, clip: c.clip ? path.join(dir, c.clip) : null, source: c.source || null, shot_id: c.shot_id, scene_id: c.scene_id, start_tick: startTick, end_tick: pc.last ? c.end_tick : c.start_tick + Math.round(pc.out_sec * tl.tick_rate), in_sec: pc.in_sec, out_sec: pc.out_sec, slow: slow > 1 ? slow : undefined, at_sec: cursor, hold_sec: 0, fireworks: !!(tl.scenes || []).find(sc => sc.id === c.scene_id && sc.fireworks) }
    if (pc.pause) { seg.hold_sec = +pc.pause.seconds.toFixed(3); seg.pause = pc.pause.id; pauseStings.push({ id: pc.pause.id, at_sec: +(cursor + len).toFixed(3), seconds: pc.pause.seconds, scene_id: c.scene_id }) }
    if (!c.clip && pc.in_sec === 0) warnings.push(`cut ${c.shot_id} has no rendered clip; a placeholder card is used`)
    // hold the last cut of a scene if a line runs past it
    const holdsAllowed = pc.last && (tl.mode !== 'match' || c === cuts[cuts.length - 1])
    if (holdsAllowed && scenesLastCut.get(c.scene_id) === c) {
      const sceneEndSec = cursor + len
      let maxEnd = sceneEndSec
      for (const l of lines) {
        if ((tl.mode !== 'match' && l.scene_id !== c.scene_id) || !l.duration_sec) continue
        const t = lineTick(l)
        if (t < startTick) continue
        const at = cursor + (t - startTick) / tl.tick_rate
        maxEnd = Math.max(maxEnd, at + l.duration_sec + 0.25)
      }
      if (maxEnd > sceneEndSec + 0.01) { seg.hold_sec = +(maxEnd - sceneEndSec).toFixed(3); warnings.push(`held ${c.shot_id} by ${seg.hold_sec}s so dialogue finishes`) }
    }
    // The film's last shot ends on a freeze-frame that is meant: the picture stops, holds, and
    // fades out into the end card. (A bare stop for half a second just looks like the game
    // hanging.) The hold is at least FREEZE seconds, and longer if a line is still being spoken.
    if (pc.last && c === cuts[cuts.length - 1]) { seg.hold_sec = +Math.max(seg.hold_sec, mix.end_freeze_sec !== undefined ? mix.end_freeze_sec : 1.2).toFixed(3); seg.freeze_out = seg.hold_sec > 0 }
    segments.push(seg)
    video.push(seg)
    cursor += len + seg.hold_sec
  }
  const programEnd = cursor
  // Tabor's overlay effects (config/effects.json): a rewind over the cut back after a teaser, a
  // fast-forward over the start of a sped-up segment. Each is a time and a length in the film.
  const effects = []
  if (mix.effects !== false) {
    const sceneOf = seg => (tl.scenes || []).find(sc => sc.id === seg.scene_id) || {}
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]; const sc = sceneOf(seg)
      const firstOfScene = i === 0 || segments[i - 1].scene_id !== seg.scene_id
      const len = seg.out_sec - seg.in_sec
      if (firstOfScene && sc.speed > 1) effects.push({ kind: 'fastforward', at_sec: +seg.at_sec.toFixed(3), seconds: +Math.min(3, len).toFixed(3), why: `${seg.scene_id} runs at ${sc.speed}x` })
      if (firstOfScene && i > 0 && sceneOf(segments[i - 1]).teaser && !sc.teaser) effects.push({ kind: 'rewind', at_sec: +seg.at_sec.toFixed(3), seconds: +Math.min(4, len).toFixed(3), why: `back to the start after the teaser ${segments[i - 1].scene_id}` })
      // a transition the plan asked for: it wipes over the cut into this scene (centred on the cut)
      if (firstOfScene && i > 0 && sc.transition && fxDefs[sc.transition] && fxDefs[sc.transition].type === 'transition') {
        const def = fxDefs[sc.transition]; const secs = def.seconds || 1.5
        effects.push({ kind: sc.transition, at_sec: +Math.max(0, seg.at_sec - secs / 2).toFixed(3), seconds: secs, why: `${seg.scene_id}: transition asked for by the plan` })
      }
      // stings the plan asked for that do not pause the film, each placed in the cut that holds its tick
      for (const st of sc.stings || []) {
        const def = fxDefs[st.id]; if (!def || def.pause) continue
        const tick = st.tick
        if (seg.cut && seg.cut.local_start <= tick && seg.cut.local_end > tick && seg.in_sec <= (tick - seg.cut.local_start) / tl.tick_rate && seg.out_sec > (tick - seg.cut.local_start) / tl.tick_rate) effects.push({ kind: st.id, at_sec: +(seg.at_sec + (tick - seg.cut.local_start) / tl.tick_rate - seg.in_sec).toFixed(3), seconds: def.seconds || 8, why: `${seg.scene_id}: sting asked for by the plan` })
      }
      // the swoosh: on the frame the winner is lifted to the cake tower (the cut that holds that tick)
      if (sc.swoosh_tick !== undefined && seg.cut && seg.cut.local_start <= sc.swoosh_tick && seg.cut.local_end > sc.swoosh_tick && seg.out_sec > (sc.swoosh_tick - seg.cut.local_start) / tl.tick_rate) {
        effects.push({ kind: 'swoosh', at_sec: +(seg.at_sec + (sc.swoosh_tick - seg.cut.local_start) / tl.tick_rate - seg.in_sec).toFixed(3), seconds: 0.7, why: `${seg.scene_id}: the lift to the cake tower` })
      }
    }
    // the subscribe nudge. Tabor: never spam; not in every video, only in certain kinds. So it is
    // a strategy's choice (effects.promo in its knobs, off unless set), and even then only about
    // promo_chance of that strategy's films get one: a promo clip laid low in the frame over a
    // quiet moment, never the teaser, the finale or the celebration, never inside another effect,
    // never in the first or last ten seconds. Seeded by the title so re-assembling agrees.
    try {
      let allow = false
      try { const st = U.readJson(path.join(dir, 'strategy.json')); allow = !!(st && st.knobs && st.knobs.effects && st.knobs.effects.promo) } catch { allow = false }
      const promos = require('../media').catalogue().filter(m => m.type === 'promo' && m.present)
      const chance = mix.promo_chance !== undefined ? mix.promo_chance : 0.5
      if (allow && promos.length && chance > 0) {
        let seed = 0; for (const ch of String(tl.title || dir)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
        if (rnd() < chance) {
          const busy = (a, b) => effects.some(e => a < e.at_sec + e.seconds && b > e.at_sec)
          // the clips that fit a quiet cut of this film, one drawn at random, then a moment in one of those cuts
          const fits = promos.map(promo => { const secs = promo.seconds || 2; const quiet = segments.filter(seg => { const sc = sceneOf(seg); return !sc.teaser && !sc.celebration && !/^finale_/.test(seg.scene_id) && seg.at_sec > 10 && seg.at_sec + (seg.out_sec - seg.in_sec) < programEnd - 10 && (seg.out_sec - seg.in_sec) > secs + 1 && !seg.pause }); return { promo, secs, quiet } }).filter(f => f.quiet.length)
          if (fits.length) {
            const f = fits[Math.floor(rnd() * fits.length)]
            const picks = f.quiet.map(seg => +(seg.at_sec + 0.5 + rnd() * (seg.out_sec - seg.in_sec - f.secs - 1)).toFixed(3)).filter(at => !busy(at, at + f.secs))
            if (picks.length) effects.push({ kind: f.promo.id, at_sec: picks[Math.floor(rnd() * picks.length)], seconds: f.secs, why: 'the subscribe nudge (this strategy allows one; promo_chance)' })
          }
        }
      }
    } catch { /* no media list */ }
    // the pausing stings: the picture is already frozen for them; the clip plays over the freeze
    for (const ps of pauseStings) effects.push({ kind: ps.id, at_sec: ps.at_sec, seconds: ps.seconds, pause: true, why: `${ps.scene_id}: the film pauses for the ${ps.id} sting` })
    effects.sort((a, b) => a.at_sec - b.at_sec)
  }
  // The ending. After the freeze: a flash of text and the outro clip for this shape, with the
  // clip's own sound (the film's music and voices have finished by here). If there is no clip
  // for the shape, or the outro is switched off (mix "outro": false, or cards.outro false for
  // one film), the plain end card as before.
  const endText = cards.end_text || mix.end_text
  const outro = mix.outro !== false && cards.outro !== false ? outroAsset.clipFor(width, height) : null
  if (outro) {
    const flashSec = cards.end_flash_sec !== undefined ? cards.end_flash_sec : mix.end_flash_sec
    // a staged story is not a match, so its card does not say it is one
    const staged = tl.mode !== 'match'
    const flashText = cards.end_flash_text || (staged ? mix.end_flash_text_story : mix.end_flash_text)
    if (flashSec > 0 && flashText) {
      video.push({ card: 'flash', text: flashText, highlight: (staged ? mix.end_flash_highlight_story : mix.end_flash_highlight) || 0, seconds: flashSec, at_sec: cursor })
      cursor += flashSec
    }
    video.push({ outro: outro.shape, clip: outro.file, shot_id: 'outro', in_sec: 0, out_sec: outro.seconds, at_sec: cursor, hold_sec: 0 })
    cursor += outro.seconds
  } else if (endText) {
    const sec = cards.end_seconds || mix.end_seconds || 2.5
    video.push({ card: 'end', text: endText, seconds: sec, at_sec: cursor })
    cursor += sec
  }
  const total = cursor

  const videoTime = (tick) => {
    for (const s of segments) if (tick >= s.start_tick && tick < s.end_tick) return s.at_sec + (tick - s.start_tick) / tl.tick_rate * (s.slow || 1)
    const last = segments[segments.length - 1]
    if (last && tick >= last.end_tick) return last.at_sec + (tick - last.start_tick) / tl.tick_rate
    return segments.length ? segments[0].at_sec : 0
  }

  const audio = []
  let prevEnd = -1; let prevGroup = false
  for (const l of lines) {
    if (!l.wav) { warnings.push(`line ${l.id} has no wav; skipped`); continue }
    let at = videoTime(lineTick(l))
    const group = !!(tl.cast && tl.cast[l.character] && tl.cast[l.character].voice === 'crowd')
    if (!group && !prevGroup && at < prevEnd + 0.08) { warnings.push(`line ${l.id} delayed ${(prevEnd + 0.08 - at).toFixed(2)}s to avoid overlapping the previous line`); at = prevEnd + 0.08 }
    // nobody talks over a pausing sting: a line that would start inside one waits until it is over
    for (const ps of pauseStings) if (at >= ps.at_sec - 0.3 && at < ps.at_sec + ps.seconds) { warnings.push(`line ${l.id} moved ${(ps.at_sec + ps.seconds + 0.1 - at).toFixed(2)}s later, past the ${ps.id} sting`); at = ps.at_sec + ps.seconds + 0.1 }
    audio.push({ line_id: l.id, character: l.character, name: l.character_name || l.character, wav: path.join(dir, l.wav), at_sec: +at.toFixed(3), duration_sec: l.duration_sec, gain_db: +((l.gain_db !== undefined ? l.gain_db : ((tl.cast && tl.cast[l.character] && tl.cast[l.character].gain_db) || 0)) + (l.norm_db || 0) + mix.voice_gain_db).toFixed(1), text: l.text })
    prevEnd = at + (l.duration_sec || 0); prevGroup = group
  }

  // music: one or more cues; consecutive cues crossfade
  const cueList = (tl.music_cues && tl.music_cues.length) ? tl.music_cues : (tl.music ? [{ ...tl.music, start_tick: 0, end_tick: tl.total_ticks || (cuts.length ? cuts[cuts.length - 1].end_tick : 0) }] : [])
  const music = []
  cueList.forEach((c, i) => {
    if (!c.path || !U.exists(c.path)) { warnings.push(`music track not found: ${c.path}`); return }
    const first = i === 0; const last = i === cueList.length - 1
    music.push({
      track: c.path, track_id: c.track_id, title: c.title || c.track_id, credit: c.credit || null,
      at_sec: first ? 0 : +videoTime(c.start_tick).toFixed(3),
      end_sec: last ? +programEnd.toFixed(3) : +videoTime(c.end_tick).toFixed(3),
      in_sec: c.in_sec || 0, out_sec: c.out_sec || null, track_len: c.duration_sec || null,
      gain_db: +((c.gain_db !== undefined ? c.gain_db : -8) + mix.music_gain_db).toFixed(1), loopable: !!c.loopable, hard: !!c.hard, carry: !!c.carry, soft_duck: !!c.soft_duck
    })
  })

  const edl = { fps, width, height, total_sec: +total.toFixed(3), effects, program_end_sec: +programEnd.toFixed(3), title: tl.title, video, audio, music, music_crossfade_sec: 1.6, music_fade_out_sec: 2.5, duck_ratio: mix.duck_ratio, duck_threshold: mix.duck_threshold, captions: mix.captions && opts.captions !== false, warnings }
  U.writeJson(path.join(dir, 'edl.json'), edl)
  return edl
}

module.exports = { build }
