'use strict'
// Spoken aliases are used only at the TTS boundary. Captions retain the script.
const path = require('path')
const U = require('../util')
const FILE = path.join(U.ROOT, 'config', 'pronunciations.json')
function overrides () { try { return U.readJson(FILE).names || {} } catch { return {} } }
function numberWords (value) {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
  if (value.length > 4 || /^0\d/.test(value)) return [...value].map(d => ones[+d]).join(' ')
  const say = n => n < 20 ? ones[n] : n < 100 ? tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '') : n < 1000 ? ones[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + say(n % 100) : '') : say(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + say(n % 1000) : '')
  return say(+value)
}
function guess (name) {
  let s = String(name).replace(/^\./, '').replace(/_+/g, ' ').trim()
  // Keep meaningful numerical prefixes, years, and numbered roles. A long ID
  // after an ordinary name is usually omitted in conversation (maxc153).
  const numbered = /^(?:player|agent|area|team|squad|unit|route)\s*\d+$/i.test(s)
  if (!numbered) s = s.replace(/^([A-Za-z]{3,})((?:\d){3,})$/, (all, word, digits) => /^(?:19|20)\d{2}$/.test(digits) ? all : word)
  if (!numbered) {
    // Only digits embedded in an alphabetic word are candidates for leetspeak.
    // Leading numbers remain numbers; 2 and 9 are intentionally ambiguous.
    s = s.replace(/([A-Za-z])([0134578])(?=[A-Za-z])/g, (_, before, digit, offset, full) => {
      const next = full[offset + 2]
      const letter = digit === '1' ? (/[aeou]/i.test(next) ? 'l' : 'i') : ({ 0: 'o', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' })[digit]
      return before + letter
    })
    s = s.replace(/([A-Za-z])33(?=[A-Za-z])/g, '$1ee')
    // High-confidence endings only. Gamer3/Player0 stay numbered, not Gamere/Playero.
    s = s.replace(/(Arl|Her|Zer|Ne|Ech|Rob)0$/i, '$1o').replace(/([A-Za-z]{2,}v)3$/i, '$1e')
  }
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2')
  s = s.replace(/\d+/g, numberWords)
  return s.split(/\s+/).map(w => w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w).join(' ').trim() || String(name)
}
function spokenName (name) {
  const o = overrides(); const bare = String(name).replace(/^\./, '')
  const key = Object.keys(o).find(k => k.toLowerCase() === bare.toLowerCase())
  return key ? o[key] : guess(name)
}
function speakable (text, names, opts = {}) {
  let spoken = String(text)
  // Chat spelling stays on screen. TTS gets normal contractions and explicit
  // letter names so "im" is not read as a name and AFK is not one made-up word.
  if (opts.chat) {
    const words = { im: "I'm", ive: "I've", dont: "don't", cant: "can't", didnt: "didn't", isnt: "isn't", wasnt: "wasn't", youre: "you're", u: 'you', r: 'are', afk: 'A F K' }
    const playerNames = new Set(names.map(n => String(n).replace(/^\./, '').toLowerCase()))
    spoken = spoken.replace(/\b(im|ive|dont|cant|didnt|isnt|wasnt|youre|u|r|afk)\b/gi, w => playerNames.has(w.toLowerCase()) ? w : words[w.toLowerCase()])
    spoken = spoken.replace(/\s+(silly|bro|dude)([.!?]?)$/i, ', $1$2')
  }
  // One replacement pass avoids reprocessing an alias as another username.
  const lookup = new Map([...new Set(names)].filter(Boolean).map(n => [String(n).replace(/^\./, '').toLowerCase(), spokenName(n)]))
  if (!lookup.size) return spoken
  const alternatives = [...lookup.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return spoken.replace(new RegExp(`(^|[^A-Za-z0-9_])\\.?(${alternatives})(?![A-Za-z0-9_])`, 'gi'), (_, pre, name) => pre + lookup.get(name.toLowerCase()))
}
function knownNames (dir) {
  const names = new Set()
  try { for (const p of require('../skins').readRoster().players) names.add(p.name) } catch {}
  for (const f of ['digest.json', 'story.json']) {
    try { const j = U.readJson(path.join(dir, f)); for (const x of j.players || j.characters || []) names.add(x.name || x.id) } catch {}
  }
  return [...names]
}
module.exports = { speakable, spokenName, guess, numberWords, knownNames, FILE }
