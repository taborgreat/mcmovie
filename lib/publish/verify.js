'use strict'
// The last gate before anything goes public. A film is only uploaded if the
// finished file is provably what the edit asked for: every shot rendered,
// every line voiced, the file decodes end to end, it has the right size,
// length, picture and sound, and it is not mostly black or frozen. Anything
// else is a failed job, never an upload.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const U = require('../util')

function ff (args, timeoutMs = 600000) {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || ''), err: (r.stderr || '') }
}

function verify (dir) {
  const problems = []
  const info = {}
  const file = path.join(dir, 'final.mp4')
  const edlFile = path.join(dir, 'edl.json')
  if (!U.exists(file)) return { ok: false, problems: ['final.mp4 does not exist'], info }
  if (!U.exists(edlFile)) return { ok: false, problems: ['edl.json does not exist; the film was not assembled by this pipeline'], info }
  const edl = U.readJson(edlFile)

  // 1. the edit itself: nothing missing went into it
  for (const seg of edl.video || []) {
    if (seg.card) continue
    if (seg.outro) { if (!seg.clip || !U.exists(seg.clip)) problems.push('the outro clip is missing (assets/outro); a placeholder card is in its place'); continue }
    if (!seg.clip || !U.exists(seg.clip)) problems.push(`shot ${seg.shot_id} was never rendered (a placeholder card is in its place)`)
  }
  // 1b. every shot was filmed in the real game. A film drawn by the offline renderer (a take
  // that failed, --offline) is never uploaded by accident: "allow_offline_render": true in
  // config/mix.json is the only way through.
  {
    const drawn = (edl.video || []).filter(s => !s.card && !s.outro && s.clip && (s.source || (s.cut && s.cut.source)) !== 'client')
    let allowed = false
    try { allowed = !!require('../assemble/mix').load().allow_offline_render } catch { /* no mix config */ }
    info.real_client_shots = (edl.video || []).filter(s => !s.card && !s.outro).length - drawn.length
    if (drawn.length && !allowed) problems.push(`${drawn.length} shot${drawn.length > 1 ? 's were' : ' was'} drawn by the offline renderer, not filmed in the real game (${drawn.slice(0, 3).map(s => s.shot_id).join(', ')}${drawn.length > 3 ? ', ...' : ''}); film it again with the real client`)
  }
  for (const w of edl.warnings || []) if (/has no wav|not found/.test(w)) problems.push(w)
  if (!(edl.video || []).some(s => !s.card && !s.outro)) problems.push('the film has no shots')

  // 2. the container: streams, size, length
  const probe = ff(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,nb_frames', '-of', 'json', file])
  let meta = null
  try { meta = JSON.parse(probe.out) } catch { /* handled below */ }
  if (probe.code !== 0 || !meta || !meta.format) return { ok: false, problems: [...problems, 'final.mp4 cannot be read (ffprobe failed)'], info }
  const v = (meta.streams || []).find(s => s.codec_type === 'video')
  const a = (meta.streams || []).find(s => s.codec_type === 'audio')
  const duration = parseFloat(meta.format.duration)
  info.duration = duration; info.bytes = parseInt(meta.format.size, 10)
  if (!v) problems.push('no video stream')
  if (!a) problems.push('no audio stream')
  if (v && (v.width !== edl.width || v.height !== edl.height)) problems.push(`picture is ${v.width}x${v.height}, expected ${edl.width}x${edl.height}`)
  if (!(duration > 5)) problems.push(`film is only ${duration}s long`)
  if (Math.abs(duration - edl.total_sec) > 1.5) problems.push(`film is ${duration.toFixed(1)}s but the edit is ${edl.total_sec}s (a truncated or partial file)`)
  if (info.bytes < 200000) problems.push(`file is only ${info.bytes} bytes`)

  // 3. it decodes from start to finish
  const decode = ff(['ffmpeg', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'])
  if (decode.code !== 0 || decode.err.trim()) problems.push('the file does not decode cleanly: ' + (decode.err.trim().split('\n')[0] || `ffmpeg exit ${decode.code}`))

  // 4. the picture: not mostly black, not mostly a still frame
  // (cards, and the outro: it opens in the dark and ends on black with only the address lit, by design)
  const outro = (edl.video || []).find(s => s.outro)
  const outroSec = outro ? outro.out_sec - outro.in_sec : 0
  const cards = (edl.video || []).filter(s => s.card).reduce((n, s) => n + (s.seconds || 0), 0) + outroSec
  const program = Math.max(1, duration - cards)
  const pic = ff(['ffmpeg', '-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-55dB:d=5', '-an', '-f', 'null', '-'])
  const black = [...pic.err.matchAll(/black_duration:([\d.]+)/g)].reduce((n, m) => n + parseFloat(m[1]), 0)
  const frozen = [...pic.err.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((n, m) => n + parseFloat(m[1]), 0)
  info.black_sec = +black.toFixed(1); info.frozen_sec = +frozen.toFixed(1)
  if (black - cards > program * 0.2) problems.push(`${(black - cards).toFixed(1)}s of the film is black (a camera inside terrain, or missing world)`)
  if (frozen - cards > program * 0.45) problems.push(`${frozen.toFixed(1)}s of the film is a frozen picture`)

  // 5. the sound: there is some, and it is not clipping silence
  const vol = ff(['ffmpeg', '-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'])
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(vol.err); const max = /max_volume: (-?[\d.]+) dB/.exec(vol.err)
  info.mean_db = mean ? parseFloat(mean[1]) : null; info.max_db = max ? parseFloat(max[1]) : null
  if (!mean || info.mean_db < -50) problems.push(`the soundtrack is silent (mean ${info.mean_db} dB)`)
  if ((edl.audio || []).length === 0 && (edl.music || []).length === 0) problems.push('the film has neither voices nor music')

  // 6. the ending: if the edit ends on the outro, the outro is really there, with its picture and its sound
  if (outro && duration > outroSec + 1) {
    const from = Math.max(0, edl.total_sec - outroSec)
    const tail = ff(['ffmpeg', '-hide_banner', '-nostats', '-ss', from.toFixed(3), '-i', file, '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-', '-af', 'volumedetect', '-f', 'null', '-'])
    const ys = [...tail.out.matchAll(/YAVG=([\d.]+)/g)].map(m => parseFloat(m[1]))
    const loud = /max_volume: (-?[\d.]+) dB/.exec(tail.err)
    info.outro_brightest = ys.length ? +Math.max(...ys).toFixed(1) : null
    info.outro_max_db = loud ? parseFloat(loud[1]) : null
    info.last_frame_luma = ys.length ? +ys[ys.length - 1].toFixed(1) : null
    if (!ys.length || info.outro_brightest < 60) problems.push('the outro is missing from the end of the film (its daylight is not there)')
    if (!loud || info.outro_max_db < -20) problems.push(`the outro has no sound (peak ${info.outro_max_db} dB)`)
    if (ys.length && info.last_frame_luma > 24) problems.push('the film does not end on the outro\'s black')
  }

  return { ok: problems.length === 0, problems, info }
}

module.exports = { verify }
