'use strict'
// Usernames are not words. Before a line goes to the voice model, every known
// player name in it is replaced by something speakable: an override from
// config/pronunciations.json if there is one, else a guess (camelCase split,
// underscores and trailing digits dropped). The written script is untouched.
const path = require('path')
const U = require('../util')

const FILE = path.join(U.ROOT, 'config', 'pronunciations.json')

function overrides () {
  if (!U.exists(FILE)) return {}
  try { return U.readJson(FILE).names || {} } catch { return {} }
}

function guess (name) {
  let s = String(name).replace(/^\./, '')
  s = s.replace(/_+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
  // long digit runs are noise ("DEMON8672" -> "Demon"); short ones are part of the name ("Player 2")
  s = s.split(/\s+/).filter(w => !/^\d{3,}$/.test(w)).join(' ')
  s = s.split(' ').map(w => (w.length > 1 && w === w.toUpperCase()) ? w[0] + w.slice(1).toLowerCase() : w).join(' ')
  return s.trim() || String(name)
}

function spokenName (name) {
  const o = overrides()
  const key = Object.keys(o).find(k => k.toLowerCase() === String(name).toLowerCase())
  return key ? o[key] : guess(name)
}

// Replace whole-word occurrences of each name (longest first) with its spoken form.
function speakable (text, names) {
  let out = String(text)
  for (const n of [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const bare = n.replace(/^\./, '')
    const spoken = spokenName(n)
    if (spoken === bare) continue
    const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'g'), (m, pre) => pre + spoken)
  }
  return out
}

function knownNames (dir) {
  const names = new Set()
  try { for (const p of require('../skins').readRoster().players) names.add(p.name) } catch { /* no roster */ }
  for (const f of ['digest.json', 'story.json']) {
    const p = path.join(dir, f)
    if (!U.exists(p)) continue
    try { const j = U.readJson(p); for (const x of (j.players || j.characters || [])) names.add(x.name || x.id) } catch { /* ignore */ }
  }
  return [...names]
}

module.exports = { speakable, spokenName, guess, knownNames, FILE }
