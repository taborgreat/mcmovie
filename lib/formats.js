'use strict'
// Output formats shared by both modes. "long" is a regular 16:9 video,
// "short" is a vertical YouTube Short. A project's format lives in
// format.json (match mode: short by default, explicitly overridable; staged
// mode: story.json "format"), and a --size flag still overrides the pixels.
const path = require('path')
const U = require('./util')

const FORMATS = {
  long: { id: 'long', width: 1920, height: 1080, fps: 30, min_sec: 180, max_sec: 300, label: 'video, 16:9, 3-5 minutes' },
  short: { id: 'short', width: 1080, height: 1920, fps: 30, min_sec: 35, max_sec: 90, label: 'YouTube Short, vertical 9:16, 35-90 seconds' }
}

// Legacy duration-based selection, only when match_format is explicitly "auto".
const SHORT_MATCH_MINUTES = 12

function get (id) { return FORMATS[id] || FORMATS.long }

function forMatch (durationSec, shortMinutes = SHORT_MATCH_MINUTES, preferred = 'short') {
  if (preferred !== 'auto') return get(preferred)
  return durationSec < shortMinutes * 60 ? FORMATS.short : FORMATS.long
}

// Resolve a project's format: explicit arg > format.json > doc/story "format" > long.
function ofProject (dir, explicit) {
  if (explicit && FORMATS[explicit]) return FORMATS[explicit]
  const f = path.join(dir, 'format.json')
  if (U.exists(f)) { try { return get(U.readJson(f).format) } catch { /* fall through */ } }
  for (const name of ['doc.json', 'story.json']) {
    const p = path.join(dir, name)
    if (U.exists(p)) { try { const j = U.readJson(p); if (j.format && FORMATS[j.format]) return FORMATS[j.format] } catch { /* ignore */ } }
  }
  return FORMATS.long
}

function writeProject (dir, id, reason) {
  U.writeJson(path.join(dir, 'format.json'), { format: get(id).id, reason: reason || '' })
  return get(id)
}

// Pixel size for a run: --size wins, else the project's format.
function sizeFor (dir, args = {}) {
  const fmt = ofProject(dir, args.format)
  if (args.size) { const [w, h] = String(args.size).split('x').map(Number); return { width: w, height: h, fps: args.fps ? Number(args.fps) : fmt.fps, format: fmt } }
  return { width: fmt.width, height: fmt.height, fps: args.fps ? Number(args.fps) : fmt.fps, format: fmt }
}

module.exports = { FORMATS, SHORT_MATCH_MINUTES, get, forMatch, ofProject, writeProject, sizeFor }
