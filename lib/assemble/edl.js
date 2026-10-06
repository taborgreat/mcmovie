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

  for (const c of cuts) {
    // a clip filmed live is as long as the take made it (its cut lands on the real camera switch)
    const len = c.source === 'client' && c.frames && c.fps ? c.frames / c.fps : (c.end_tick - c.start_tick) / tl.tick_rate
    const seg = { cut: c, clip: c.clip ? path.join(dir, c.clip) : null, source: c.source || null, shot_id: c.shot_id, scene_id: c.scene_id, start_tick: c.start_tick, end_tick: c.end_tick, in_sec: 0, out_sec: len, at_sec: cursor, hold_sec: 0, fireworks: !!(tl.scenes || []).find(sc => sc.id === c.scene_id && sc.fireworks) }
    if (!c.clip) warnings.push(`cut ${c.shot_id} has no rendered clip; a placeholder card is used`)
    // hold the last cut of a scene if a line runs past it
    const holdsAllowed = tl.mode !== 'match' || c === cuts[cuts.length - 1]
    if (holdsAllowed && scenesLastCut.get(c.scene_id) === c) {
      const sceneEndSec = cursor + len
      let maxEnd = sceneEndSec
      for (const l of lines) {
        if ((tl.mode !== 'match' && l.scene_id !== c.scene_id) || !l.duration_sec) continue
        const t = lineTick(l)
        if (t < c.start_tick) continue
        const at = cursor + (t - c.start_tick) / tl.tick_rate
        maxEnd = Math.max(maxEnd, at + l.duration_sec + 0.25)
      }
      if (maxEnd > sceneEndSec + 0.01) { seg.hold_sec = +(maxEnd - sceneEndSec).toFixed(3); warnings.push(`held ${c.shot_id} by ${seg.hold_sec}s so dialogue finishes`) }
    }
    // The film's last shot ends on a freeze-frame that is meant: the picture stops, holds, and
    // fades out into the end card. (A bare stop for half a second just looks like the game
    // hanging.) The hold is at least FREEZE seconds, and longer if a line is still being spoken.
    if (c === cuts[cuts.length - 1]) { seg.hold_sec = +Math.max(seg.hold_sec, mix.end_freeze_sec !== undefined ? mix.end_freeze_sec : 1.2).toFixed(3); seg.freeze_out = seg.hold_sec > 0 }
    segments.push(seg)
    video.push(seg)
    cursor += len + seg.hold_sec
  }
  const programEnd = cursor
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
    for (const s of segments) if (tick >= s.start_tick && tick < s.end_tick) return s.at_sec + (tick - s.start_tick) / tl.tick_rate
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
      gain_db: +((c.gain_db !== undefined ? c.gain_db : -8) + mix.music_gain_db).toFixed(1), loopable: !!c.loopable, hard: !!c.hard, carry: !!c.carry
    })
  })

  const edl = { fps, width, height, total_sec: +total.toFixed(3), program_end_sec: +programEnd.toFixed(3), title: tl.title, video, audio, music, music_crossfade_sec: 1.6, music_fade_out_sec: 2.5, duck_ratio: mix.duck_ratio, duck_threshold: mix.duck_threshold, captions: mix.captions && opts.captions !== false, warnings }
  U.writeJson(path.join(dir, 'edl.json'), edl)
  return edl
}

module.exports = { build }
