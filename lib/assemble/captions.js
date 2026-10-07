'use strict'
// Burned-in captions in the short-video style: a few bold words at a time,
// white with a black outline, low in the frame, popping in as they are
// spoken. A player's line carries their name above it in their own colour so
// viewers can see who is talking; the narrator is plain white with no name.
// Written as an ASS subtitle file and rendered by ffmpeg (libass).
const fs = require('fs')
const path = require('path')

// bright, readable name colours (RGB hex); a name always gets the same one
const NAME_COLORS = ['FFE14D', '4DE8FF', '7CFF6B', 'FF7AD9', 'FFA24D', 'C59BFF', 'FF6B6B', '6BFFD0']

function hash (s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
function assColor (rgb) { return `&H${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&` } // ASS wants BGR
function colorFor (name) { return NAME_COLORS[hash(String(name).toLowerCase()) % NAME_COLORS.length] }
function stamp (sec) {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s - h * 3600 - m * 60
  return `${h}:${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`
}
const clean = (t) => String(t).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()

// Group words into caption chunks of at most maxChars, never orphaning one short word.
function chunks (text, maxChars) {
  const words = clean(text).split(' ').filter(Boolean)
  const out = []
  let cur = []
  for (const w of words) {
    const len = cur.join(' ').length
    if (cur.length && len + 1 + w.length > maxChars) { out.push(cur); cur = [] }
    cur.push(w)
    if (/[.!?]$/.test(w) && cur.join(' ').length >= maxChars * 0.5) { out.push(cur); cur = [] }
  }
  if (cur.length) { if (out.length && cur.join(' ').length < 5) out[out.length - 1].push(...cur); else out.push(cur) }
  return out.map(c => c.join(' '))
}

function isNarrator (line) { return String(line.character).toLowerCase() === 'narrator' }

// edl: the edit decision list (audio entries carry at_sec, duration_sec, text, character, name)
function build (edl, mix = {}) {
  const w = edl.width; const h = edl.height
  const vertical = h > w
  const size = Math.round(vertical ? w * 0.082 : h * 0.062)
  const nameSize = Math.round(size * 0.62)
  const marginV = Math.round(vertical ? h * 0.24 : h * 0.07) // Shorts cover the bottom fifth with their own UI
  const maxChars = vertical ? 16 : 30
  const font = mix.caption_font || 'DejaVu Sans'
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(size * 0.075))},${Math.max(1, Math.round(size * 0.03))},2,${Math.round(w * 0.06)},${Math.round(w * 0.06)},${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const events = []
  const lines = (edl.audio || []).filter(a => a.text && a.duration_sec).slice().sort((a, b) => a.at_sec - b.at_sec)
  // within one film every speaker gets a different colour, in order of first appearance
  const palette = new Map()
  const colourOf = (who) => {
    if (!palette.has(who)) {
      const used = new Set(palette.values())
      const start = hash(who.toLowerCase()) % NAME_COLORS.length
      let pick = NAME_COLORS[start]
      for (let i = 0; i < NAME_COLORS.length && used.has(pick); i++) pick = NAME_COLORS[(start + i + 1) % NAME_COLORS.length]
      palette.set(who, pick)
    }
    return palette.get(who)
  }
  lines.forEach((line, li) => {
    const parts = chunks(line.text, maxChars)
    const total = parts.reduce((n, p) => n + p.length, 0) || 1
    const next = lines[li + 1]
    // hold the last chunk a beat after the voice stops, but never into the next line
    const end = Math.min(line.at_sec + line.duration_sec + 0.25, next ? next.at_sec - 0.02 : Infinity)
    const span = end - line.at_sec
    if (span <= 0) throw new Error(`Caption line has no time on screen: ${line.text}`)
    let t = line.at_sec
    const who = isNarrator(line) ? null : clean(String(line.name || line.character).replace(/^\./, ''))
    for (const part of parts) {
      // Proportional timing preserves every word. A minimum per chunk used to
      // consume the available time early and silently drop the final words.
      const dur = span * part.length / total
      const stop = Math.min(end, t + dur)
      const pop = '{\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)}'
      // a host is a voice, not a player: smaller, in the host's own muted colour (Trina pink, Bob
      // greyed green, Hank greyed brown), so a player's bright line stands apart
      const text = who && line.host
        ? `${pop}{\\fs${Math.round(nameSize * 0.85)}\\c${assColor(line.host_color || '#9a9a9a')}}${who}\\N{\\fs${Math.round(size * 0.78)}\\c${assColor(line.host_color || '#c8c8c8')}}${part}`
        : who
        ? `${pop}{\\fs${nameSize}\\c${assColor(colourOf(who))}}${who}\\N{\\fs${size}\\c&HFFFFFF&}${part}`
        : `${pop}${part}`
      events.push(`Dialogue: 0,${stamp(t)},${stamp(stop)},Cap,,0,0,0,,${text}`)
      t = stop
    }
  })
  return head.concat(events).join('\n') + '\n'
}

function write (dir, edl, mix) {
  const file = path.join(dir, 'captions.ass')
  fs.writeFileSync(file, build(edl, mix))
  return file
}

module.exports = { build, write, chunks, colorFor }
