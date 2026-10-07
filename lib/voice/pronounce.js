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
  // long digit runs after a word are noise ("DEMON8672" -> "Demon"); short ones are said as numbers ("Player 2")
  s = s.replace(/^([A-Za-z]{3,})(\d{3,})$/, (all, word, digits) => /^(?:19|20)\d{2}$/.test(digits) ? all : word)
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
  const playerNames = new Set(names.map(n => String(n).replace(/^\./, '').toLowerCase()))
  // Qwen can fuse spaced capitals ("A F K") back into a nonsense word.
  // Spell the *sounds* of the letters at the speech boundary, for narration
  // as well as chat. Do not expand unknown acronyms or protected usernames.
  const initialisms = { afk: 'ay eff kay', gg: 'gee gee', ggs: 'gee gees', pvp: 'pee vee pee', pve: 'pee vee ee', hp: 'aitch pee', xp: 'ex pee', tnt: 'tee en tee', mvp: 'em vee pee', npc: 'en pee see', irl: 'eye ar ell', fps: 'eff pee ess', rng: 'ar en gee' }
  spoken = spoken.replace(/\b(afk|ggs?|pvp|pve|hp|xp|tnt|mvp|npc|irl|fps|rng)\b/gi, w => playerNames.has(w.toLowerCase()) ? w : initialisms[w.toLowerCase()])
  // Chat spelling stays on screen. TTS gets normal contractions and explicit
  // letter names so "im" is not read as a name and AFK is not one made-up word.
  if (opts.chat) {
    const words = { im: "I'm", ive: "I've", dont: "don't", cant: "can't", didnt: "didn't", isnt: "isn't", wasnt: "wasn't", youre: "you're", u: 'you', r: 'are' }
    spoken = spoken.replace(/\b(im|ive|dont|cant|didnt|isnt|wasnt|youre|u|r)\b/gi, w => playerNames.has(w.toLowerCase()) ? w : words[w.toLowerCase()])
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
