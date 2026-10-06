'use strict'
// Where the finished outro lives and what the editor needs to know about it.
// (The filming is in make.js; this file has no game in it, so the editor and
// the upload check can ask for the clip without loading a Minecraft bot.)
const path = require('path')
const { execFileSync } = require('child_process')
const U = require('../util')

const DIR = path.join(U.ROOT, 'assets', 'outro')
const FONT = path.join(U.ROOT, 'assets', 'fonts', 'PressStart2P-Regular.ttf') // the site's pixel font (SIL OFL, licence beside it)

// a vertical frame gets the vertical outro, anything else the wide one
function shapeFor (width, height) { return height > width ? 'short' : 'long' }
function file (shape) { return path.join(DIR, `outro_${shape}.mp4`) }
function rawFile (shape) { return path.join(DIR, `raw_${shape}.mp4`) }

// The outro clip for a frame of this size, or null if it has not been made (the film then
// ends on the plain end card).
function clipFor (width, height) {
  const f = file(shapeFor(width, height))
  if (!U.exists(f)) return null
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).toString().trim()
    const seconds = parseFloat(out)
    if (!(seconds > 0.5)) return null
    return { file: f, seconds: +seconds.toFixed(3), shape: shapeFor(width, height) }
  } catch { return null }
}

module.exports = { DIR, FONT, shapeFor, file, rawFile, clipFor }
