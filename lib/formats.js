'use strict'
// Output formats shared by both modes. "long" is a regular 16:9 video,
// "short" is a vertical YouTube Short. A project's format lives in
// format.json (match mode: chosen from the match's size and length at import; staged
// mode: story.json "format"), and a --size flag still overrides the pixels.
const path = require('path')
const U = require('./util')

const FORMATS = {
  long: { id: 'long', width: 1920, height: 1080, fps: 30, min_sec: 180, max_sec: 300, label: 'video, 16:9, 3-5 minutes' },
  short: { id: 'short', width: 1080, height: 1920, fps: 30, min_sec: 35, max_sec: 180, label: 'YouTube Short, vertical 9:16, 35 seconds to 3 minutes (as short as the match allows)' }
}

// Short-form does better, so a match becomes a Short unless it really needs the full video:
// only a big match (this many players or more) that also ran long gets 16:9. A Short may run
// up to YouTube's three minutes when the match has that much in it.
const LONG_MIN_PLAYERS = 10
const SHORT_MATCH_MINUTES = 12 // and even a big match under this length stays a Short

function get (id) { return FORMATS[id] || FORMATS.long }

// durationSec: the match's length; players: how many started it (unknown = small).
function forMatch (durationSec, players = 0, { shortMinutes = SHORT_MATCH_MINUTES, longMinPlayers = LONG_MIN_PLAYERS, preferred = 'auto' } = {}) {
  if (preferred === 'short' || preferred === 'long') return get(preferred)
  const big = (players || 0) >= longMinPlayers
  return big && durationSec >= shortMinutes * 60 ? FORMATS.long : FORMATS.short
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

module.exports = { FORMATS, SHORT_MATCH_MINUTES, LONG_MIN_PLAYERS, get, forMatch, ofProject, writeProject, sizeFor }
