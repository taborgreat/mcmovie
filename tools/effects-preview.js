#!/usr/bin/env node
'use strict'
// Keys every effect in config/effects.json onto a real game frame, with the same filter the
// assembler uses, and tiles the results: one sheet per shape (long 1920x1080, short 1080x1920).
// usage: node tools/effects-preview.js <game frame .png or .mp4> [outdir]
const path = require('path'); const fs = require('fs'); const { execFileSync } = require('child_process')
const U = require('../lib/util'); const { effectFilters } = require('../lib/assemble/ffmpeg')
const src = process.argv[2]; const out = process.argv[3] || path.join(U.ROOT, 'automation', 'effects-preview')
if (!src) { console.error('usage: effects-preview <frame.png|clip.mp4> [outdir]'); process.exit(2) }
fs.mkdirSync(out, { recursive: true })
const fx = U.readJson(path.join(U.ROOT, 'config', 'effects.json')).effects
for (const [shape, w, h] of [['long', 1920, 1080], ['short', 1080, 1920]]) {
  const tiles = []
  for (const [id, def] of Object.entries(fx)) {
    if (!def.file) continue
    const file = path.isAbsolute(def.file) ? def.file : path.join(U.ROOT, def.file)
    if (!fs.existsSync(file)) continue
    const secs = (def.out !== undefined ? def.out : def.seconds_measured || 3) - (def.in || 0)
    const mid = def.preview_sec !== undefined ? def.preview_sec : (def.in || 0) + secs * 0.45 // the clip's fullest frame
    const tile = path.join(out, `${shape}_${id}.png`)
    const lines = effectFilters({ ...def, in: mid }, 1, 0, 0, 0.2, 30, w, h, '[bg]')
    const filter = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,format=yuv420p[bg];` + lines.join(';') + `;[vfx0]select=eq(n\\,2),drawtext=text='${id}':fontcolor=white:fontsize=${Math.round(h / 24)}:box=1:boxcolor=black@0.6:x=20:y=20,scale=${Math.round(w / 4)}:-2[o]`
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', '1', '-i', src, '-i', file, '-filter_complex', filter, '-map', '[o]', '-frames:v', '1', tile], { stdio: ['ignore', 'ignore', 'pipe'] })
      tiles.push(tile)
    } catch (e) { console.error(id, shape, 'failed:', String(e.stderr || e.message).slice(0, 200)) }
  }
  const cols = shape === 'long' ? 4 : 6
  const rows = []
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols))
  const inputs = tiles.flatMap(t => ['-i', t])
  let k = 0; const parts = []; const rl = []
  const tw = Math.round(w / 4)
  for (const r of rows) { const labels = r.map(() => `[${k++}:v]`).join(''); const n = r.length; parts.push((n > 1 ? `${labels}hstack=inputs=${n}` : `${labels}copy`) + `,pad=${tw * cols}:ih:0:0:black[r${rl.length}]`); rl.push(`[r${rl.length}]`) }
  const sheet = path.join(out, `sheet_${shape}.png`)
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', parts.join(';') + `;${rl.join('')}${rl.length > 1 ? `vstack=inputs=${rl.length}` : 'copy'}[s]`, '-map', '[s]', sheet])
  console.log(sheet, tiles.length, 'effects')
}
