'use strict'
// edl.json -> ffmpeg filtergraph -> final.mp4 (1080p default, AAC, dialogue
// over a music bed with sidechain ducking, title and end cards).
const path = require('path')
const fs = require('fs')
const { spawn, execFileSync } = require('child_process')
const U = require('../util')
const outroAsset = require('../outro/asset')

function esc (s) {
  // drawtext escaping: backslash, quote, colon, percent, semicolon, comma
  return String(s).replace(/\\/g, '\\\\\\\\').replace(/'/g, "\\\\\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/;/g, '\;').replace(/,/g, '\\,')
}

function cardFilter (textFile, seconds, fps, w, h, label) {
  let chars = 16
  try { chars = Math.max(8, ...fs.readFileSync(textFile, 'utf8').split('\n').map(l => l.length)) } catch { /* keep default */ }
  const size = Math.round(Math.min(Math.min(w, h) / 9, (w * 0.86) / (chars * 0.56)))
  let f = `color=c=0x101010:s=${w}x${h}:d=${seconds}:r=${fps},format=yuv420p,` +
    `drawtext=font=Sans:textfile=${esc(textFile)}:fontcolor=white:fontsize=${size}:line_spacing=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=(h-text_h)/2`
  f += `,fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, seconds - 0.5)}:d=0.5[${label}]`
  return f
}

// The flash before the outro: a few lines in the site's pixel font on black, up for about half
// a second with no fade, so nobody quite reads it the first time. A long line is split in two
// where it balances, so the letters can be big in either shape; one line can be yellow.
function flashFilter (dir, seg, fps, w, h, label) {
  const d = path.join(dir, 'cards')
  fs.mkdirSync(d, { recursive: true })
  const rows = []
  String(seg.text).split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    let parts = [line]
    if (line.length > 18 && line.includes(' ')) {
      // the space nearest the middle
      let at = -1
      for (let k = 0; k < line.length; k++) if (line[k] === ' ' && (at < 0 || Math.abs(k - line.length / 2) < Math.abs(at - line.length / 2))) at = k
      parts = [line.slice(0, at), line.slice(at + 1)]
    }
    parts.forEach((text, k) => rows.push({ text, hot: i + 1 === seg.highlight, first: k === 0 && i > 0 }))
  })
  const chars = Math.max(8, ...rows.map(r => r.text.length))
  const gaps = rows.filter(r => r.first).length
  // whole pixels of the font (it is drawn on an 8 x 8 grid), as big as the frame takes
  const size = Math.max(16, Math.floor(Math.min(w * 0.9 / chars, h * 0.8 / (rows.length * 1.5 + gaps * 0.9)) / 8) * 8)
  const font = U.exists(outroAsset.FONT) ? `fontfile=${esc(outroAsset.FONT)}` : 'font=Sans'
  const total = rows.length * size * 1.5 - size * 0.5 + gaps * size * 0.9
  let y = (h - total) / 2
  const draws = rows.map((r, n) => {
    if (r.first) y += size * 0.9
    const f = path.join(d, `flash_${n}.txt`)
    fs.writeFileSync(f, r.text)
    const s = `drawtext=${font}:textfile=${esc(f)}:fontcolor=${r.hot ? '0xFFFF55' : 'white'}:fontsize=${size}:x=(w-text_w)/2:y=${Math.round(y)}:shadowx=${size / 8}:shadowy=${size / 8}:shadowcolor=${r.hot ? '0x3F3F15' : '0x3F3F3F'}`
    y += size * 1.5
    return s
  })
  return `color=c=black:s=${w}x${h}:d=${seg.seconds}:r=${fps},format=yuv420p,${draws.join(',')}[${label}]`
}

// Card text is wrapped to the frame so it can be drawn large: a vertical frame fits
// about 16 characters a line, a wide one about 34.
function textFile (dir, name, text, w, h) {
  const d = path.join(dir, 'cards')
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, name + '.txt')
  const max = w && h && h > w ? 16 : 34
  const lines = []
  let cur = ''
  for (const word of String(text).split(/\s+/)) {
    if (cur && (cur + ' ' + word).length > max) { lines.push(cur); cur = word } else cur = cur ? cur + ' ' + word : word
  }
  if (cur) lines.push(cur)
  fs.writeFileSync(f, lines.join('\n'))
  return f
}

function run (args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', opts.quiet ? 'ignore' : 'inherit'] })
    p.on('exit', c => c === 0 ? resolve() : reject(new Error('ffmpeg exited ' + c)))
  })
}

function hasAudio (file) {
  try { return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).toString().trim().length > 0 } catch { return false }
}

async function assemble (dir, opts = {}) {
  const edl = U.readJson(path.join(dir, 'edl.json'))
  const { fps, width: w, height: h } = edl
  const out = path.join(dir, opts.output || 'final.mp4')
  const inputs = []
  const filters = []
  const addInput = (file) => { inputs.push(file); return inputs.length - 1 }

  // video segments
  const vlabels = []
  // clips filmed by the real client carry the game's own sound (steps, hits, explosions)
  const glabels = []
  const mix = require('./mix').load()
  let outroSound = null // the outro clip's own sound: mixed in last, never ducked or squeezed with the film's
  let cursor = 0
  edl.video.forEach((seg, i) => {
    const label = `v${i}`
    const segLen = seg.card ? seg.seconds : (seg.out_sec - seg.in_sec) + (seg.hold_sec || 0)
    const at = cursor
    cursor += segLen
    if (seg.card === 'flash') {
      filters.push(flashFilter(dir, seg, fps, w, h, label))
    } else if (seg.card) {
      filters.push(cardFilter(textFile(dir, seg.card, seg.text, w, h), seg.seconds, fps, w, h, label))
    } else if (seg.outro && seg.clip && U.exists(seg.clip)) {
      // the outro: the clip as it is (filled to the frame if the sizes differ), and its sound
      const idx = addInput(seg.clip)
      filters.push(`[${idx}:v]trim=start=0:end=${seg.out_sec},setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1,format=yuv420p[${label}]`)
      if (hasAudio(seg.clip)) {
        const ms = Math.round(at * 1000)
        filters.push(`[${idx}:a]atrim=start=0:end=${seg.out_sec},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${mix.outro_volume_db || 0}dB,adelay=${ms}|${ms}[outro]`)
        outroSound = '[outro]'
      }
    } else if (seg.clip && U.exists(seg.clip)) {
      const idx = addInput(seg.clip)
      if (mix.game_sound !== false && hasAudio(seg.clip)) {
        const ms = Math.round(at * 1000)
        filters.push(`[${idx}:a]atrim=start=${seg.in_sec}:end=${seg.out_sec},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:st=0:d=0.04,volume=${seg.fireworks ? mix.game_fireworks_db : mix.game_volume_db}dB,adelay=${ms}|${ms}[g${i}]`)
        glabels.push(`[g${i}]`)
      }
      let f = `[${idx}:v]trim=start=${seg.in_sec}:end=${seg.out_sec},setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}:flags=lanczos,setsar=1,format=yuv420p`
      if (seg.hold_sec > 0) f += `,tpad=stop_mode=clone:stop_duration=${seg.hold_sec}`
      // the closing freeze: the frozen frame drains of colour a little and fades to black
      if (seg.freeze_out) {
        const len = seg.out_sec - seg.in_sec; const fade = Math.min(0.7, seg.hold_sec * 0.6)
        f += `,hue=s='if(lt(t,${len.toFixed(3)}),1,max(0.35,1-(t-${len.toFixed(3)})*0.9))',fade=t=out:st=${(len + seg.hold_sec - fade).toFixed(3)}:d=${fade.toFixed(2)}`
      }
      filters.push(f + `[${label}]`)
    } else {
      filters.push(cardFilter(textFile(dir, 'missing_' + i, `${seg.shot_id} (not rendered)`), seg.out_sec - seg.in_sec + (seg.hold_sec || 0), fps, w, h, label))
    }
    vlabels.push(`[${label}]`)
  })
  filters.push(`${vlabels.join('')}concat=n=${vlabels.length}:v=1:a=0[vcat]`)
  // the overlay effects: each is a slice of its clip, its black keyed out, laid on the picture at
  // its moment (under the captions); its sound joins the game-sound bus
  let vcur = '[vcat]'
  const takeovers = [] // [from, to] in film seconds where a sting's sound owns the mix: the music drops to a whisper
  const fxDefs = (() => { try { return U.readJson(path.join(U.ROOT, 'config', 'effects.json')).effects || {} } catch { return {} } })()
  ;(edl.effects || []).forEach((fx, i) => {
    const def = fxDefs[fx.kind]
    if (fx.kind === 'swoosh' && !(def && def.file && U.exists(path.isAbsolute(def.file) ? def.file : path.join(U.ROOT, def.file)))) {
      // built in until Tabor finds one he likes: a white flash that dies over a quarter second,
      // and a rush of air, synthesised
      const A = fx.at_sec.toFixed(3)
      filters.push(`${vcur}eq=brightness='if(between(t,${A},${A}+0.28),0.85*(1-(t-${A})/0.28),0)':eval=frame[vfx${i}]`)
      vcur = `[vfx${i}]`
      if (mix.game_sound !== false) {
        const idx = addInput('lavfi:anoisesrc=d=0.7:c=pink:r=48000:a=0.7')
        const ms = Math.round(Math.max(0, fx.at_sec - 0.12) * 1000)
        filters.push(`[${idx}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,bandpass=f=1100:w=900,afade=t=in:st=0:d=0.12,afade=t=out:st=0.2:d=0.5,volume=${(mix.effects_volume_db !== undefined ? mix.effects_volume_db : -4) - 2}dB,adelay=${ms}|${ms}[gfx${i}]`)
        glabels.push(`[gfx${i}]`)
      }
      return
    }
    if (!def) return
    const file = path.isAbsolute(def.file) ? def.file : path.join(U.ROOT, def.file)
    if (!U.exists(file)) return
    const idx = addInput(file)
    const start = def.in || 0
    const end = Math.min(def.out !== undefined ? def.out : 1e9, start + fx.seconds)
    const key = def.key === 'green' ? `chromakey=${def.key_color || '0x3fc900'}:${def.key_similarity || 0.28}:${def.key_blend || 0.06}` : 'colorkey=0x000000:0.3:0.15'
    // layout: the whole frame, or scaled down and centred (a sting is a face, not a filter)
    const fit = def.layout === 'centre' ? `scale=${Math.round(w * (def.scale || 0.55))}:-2:flags=lanczos` : `scale=${w}:${h}:flags=lanczos`
    const place = def.layout === 'centre' ? '(W-w)/2:(H-h)/2' : '0:0'
    filters.push(`[${idx}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS+${fx.at_sec.toFixed(3)}/TB,fps=${fps},${fit},setsar=1,format=yuva420p,${key}[fx${i}]`)
    filters.push(`${vcur}[fx${i}]overlay=${place}:eof_action=pass:format=yuv420:enable='between(t,${fx.at_sec.toFixed(3)},${(fx.at_sec + (end - start)).toFixed(3)})'[vfx${i}]`)
    vcur = `[vfx${i}]`
    if (def.sound !== 'none' && hasAudio(file) && mix.game_sound !== false) {
      const ms = Math.round(fx.at_sec * 1000)
      const gain = def.sound === 'takeover' ? (def.gain_db !== undefined ? def.gain_db : 0) : (mix.effects_volume_db !== undefined ? mix.effects_volume_db : -4)
      filters.push(`[${idx}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${gain}dB,adelay=${ms}|${ms}[gfx${i}]`)
      glabels.push(`[gfx${i}]`)
      if (def.sound === 'takeover') takeovers.push([fx.at_sec, fx.at_sec + (end - start)])
    }
  })
  if (edl.captions && (edl.audio || []).length && opts.captions !== false) {
    const ass = require('./captions').write(dir, edl, require('./mix').load())
    filters.push(`${vcur}subtitles=filename=${esc(ass)}[vout]`)
  } else {
    filters.push(`${vcur}null[vout]`)
  }

  // dialogue
  const alabels = []
  edl.audio.forEach((a, i) => {
    if (!U.exists(a.wav)) return
    const idx = addInput(a.wav)
    const ms = Math.round(a.at_sec * 1000)
    filters.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${a.gain_db || 0}dB,adelay=${ms}|${ms}[a${i}]`)
    alabels.push(`[a${i}]`)
  })
  if (alabels.length) filters.push(`${alabels.join('')}amix=inputs=${alabels.length}:duration=longest:normalize=0,apad=whole_dur=${edl.total_sec}[dialog]`)
  else filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${edl.total_sec}[dialog]`)

  // music bed: every cue is trimmed, looped if it runs out, faded and placed;
  // neighbours overlap by the crossfade. The mix is then ducked under dialogue.
  const cues = (Array.isArray(edl.music) ? edl.music : (edl.music ? [edl.music] : [])).filter(m => U.exists(m.track))
  if (cues.length) {
    const xf = edl.music_crossfade_sec || 1.6
    const mlabels = []
    cues.forEach((m, i) => {
      const idx = addInput(m.track)
      const first = i === 0; const last = i === cues.length - 1
      const end = m.end_sec !== undefined ? m.end_sec : edl.program_end_sec
      // a hard cue (the finale song) starts exactly on its cut so its drop stays in place
      // a carry cue (the celebration after the finale song) swells in under the song's last two
      // seconds and is at full level on the cut
      const start = first ? 0 : (m.hard ? m.at_sec : Math.max(0, m.at_sec - (m.carry ? 2 : xf / 2)))
      // ...and ends on its own last note rather than fading under the next track
      // does the finale song reach its own last note here, or is it cut by the film ending first?
      const natural = m.hard && m.track_len && (end - m.at_sec) >= (m.track_len - (m.in_sec || 0)) - 0.4
      const stop = (last || natural) ? end : Math.min(edl.program_end_sec, end + xf / 2)
      const dur = Math.max(0.5, stop - start)
      const fadeIn = m.hard ? 0.05 : (m.carry ? 2 : (first ? 1 : Math.min(xf, dur / 3)))
      const fadeOut = natural ? 0.25 : (last ? Math.min(edl.music_fade_out_sec || 2.5, dur / 2) : Math.min(xf, dur / 3))
      const avail = (m.out_sec || m.track_len || 0) - (m.in_sec || 0)
      let f = `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${m.in_sec || 0}${m.out_sec ? ':end=' + m.out_sec : ''},asetpts=PTS-STARTPTS`
      if (m.loopable || (avail > 1 && avail < dur)) f += `,aloop=loop=-1:size=${Math.round(48000 * Math.max(1, avail || 600))}`
      f += `,atrim=0:${dur.toFixed(3)},afade=t=in:st=0:d=${fadeIn.toFixed(2)},afade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(2)},volume=${m.gain_db}dB,adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}[m${i}]`
      filters.push(f)
      mlabels.push(`[m${i}]`)
    })
    // two music buses: the usual one ducks under a voice; a feel song (soft_duck) barely does
    const soft = []; const norm = []
    cues.forEach((m, i) => (m.soft_duck ? soft : norm).push(`[m${i}]`))
    const hush = takeovers.length ? ',volume=' + "'" + 'if(' + takeovers.map(([a, b]) => `between(t,${(a - 0.3).toFixed(3)},${(b + 0.4).toFixed(3)})`).join('+') + ',0.12,1)' + "'" + ':eval=frame' : ''
    const bus = (labels, name) => { if (labels.length > 1) filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=whole_dur=${edl.total_sec}${hush}[${name}]`); else filters.push(`${labels[0]}apad=whole_dur=${edl.total_sec}${hush}[${name}]`) }
    const splits = 3 + (soft.length && norm.length ? 1 : 0)
    filters.push(`[dialog]asplit=${splits}[d1][d2][d3]${splits > 3 ? '[d4]' : ''}`)
    if (norm.length) { bus(norm, 'mus'); filters.push(`[mus][d2]sidechaincompress=threshold=${edl.duck_threshold || 0.03}:ratio=${edl.duck_ratio || 4}:attack=25:release=700:level_sc=1.5[ducked]`) }
    if (soft.length) { bus(soft, 'musoft'); filters.push(`[musoft][${norm.length ? 'd4' : 'd2'}]sidechaincompress=threshold=${edl.duck_threshold || 0.03}:ratio=${mix.soft_duck_ratio || 1.6}:attack=40:release=900:level_sc=1.2[duckedsoft]`) }
    if (norm.length && soft.length) filters.push(`[ducked][duckedsoft]amix=inputs=2:duration=longest:normalize=0[duckedall]`)
    filters.push(`[d1][${norm.length && soft.length ? 'duckedall' : norm.length ? 'ducked' : 'duckedsoft'}]amix=inputs=2:duration=first:normalize=0,atrim=0:${edl.total_sec}[amain]`)
  } else {
    filters.push('[dialog]asplit=2[d1][d3]')
    filters.push(`[d1]atrim=0:${edl.total_sec}[amain]`)
  }
  if (glabels.length) {
    filters.push(`${glabels.join('')}amix=inputs=${glabels.length}:duration=longest:normalize=0,acompressor=threshold=0.02:ratio=5:attack=4:release=250:makeup=${mix.game_makeup || 6},alimiter=limit=0.5,apad=whole_dur=${edl.total_sec}[gameraw]`)
    // the game's own sound dips under a voice too, so fireworks and fights never bury a line
    filters.push(`[gameraw][d3]sidechaincompress=threshold=${edl.duck_threshold || 0.03}:ratio=${mix.game_duck_ratio || 5}:attack=15:release=450:level_sc=1.5[game]`)
    filters.push(`[amain][game]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,atrim=0:${edl.total_sec}[afilm]`)
  } else {
    filters.push('[d3]anullsink')
    filters.push('[amain]anull[afilm]')
  }
  // the film's own sound is over by the outro (music faded on the freeze, the last line spoken),
  // so the outro's is simply laid in after it at its own level
  if (outroSound) filters.push(`[afilm]${outroSound}amix=inputs=2:duration=first:normalize=0,atrim=0:${edl.total_sec}[aout]`)
  else filters.push('[afilm]anull[aout]')

  const graphFile = path.join(dir, 'ffmpeg_filter.txt')
  fs.writeFileSync(graphFile, filters.join(';\n'))
  const args = ['-y', '-loglevel', opts.verbose ? 'info' : 'error', '-stats']
  for (const f of inputs) { if (typeof f === 'string' && f.startsWith('lavfi:')) args.push('-f', 'lavfi', '-i', f.slice(6)); else args.push('-i', f) }
  args.push('-filter_complex_script', graphFile, '-map', '[vout]', '-map', '[aout]')
  const tail = ['-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', String(edl.total_sec), out]
  const x264 = ['-c:v', 'libx264', '-preset', opts.preset || 'medium', '-crf', String(opts.crf || 18)]
  // encode on the graphics card when asked (config/mix.json "video_encoder": "h264_nvenc"),
  // which keeps the export off the game server's CPU; fall back to x264 if the card refuses
  const nvenc = ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', String(opts.crf || 19), '-b:v', '0']
  U.log('assemble', `${inputs.length} inputs, ${edl.video.length} video segments, ${edl.audio.length} lines, music ${cues.length ? cues.map(c => c.track_id).join(' > ') : 'none'}${glabels.length ? ', game sound' : ''}${edl.video.some(s => s.outro) ? ', outro' : ''}`)
  if (mix.video_encoder === 'h264_nvenc') {
    try { await run([...args, ...nvenc, ...tail]) } catch (e) { U.log('assemble', 'GPU encode failed, using x264: ' + String(e.message).split('\n')[0]); await run([...args, ...x264, ...tail]) }
  } else await run([...args, ...x264, ...tail])
  U.log('assemble', `wrote ${path.relative(dir, out)} (${edl.total_sec}s)`)
  return out
}

module.exports = { assemble }
