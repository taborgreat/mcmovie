'use strict'
// Every real player gets one made-up voice, kept forever, so they sound the
// same in every film. The registry is config/player_voices.json: edit a
// player's voice_desc there to recast them (then delete the built voice on
// the voice server so it is designed again).
const path = require('path')
const U = require('../util')

const FILE = path.join(U.ROOT, 'config', 'player_voices.json')

// No genders: nothing is known about the person behind a username. Tabor can
// edit a player's entry in config/player_voices.json to recast them.
const DESCRIPTIONS = [
  'young gamer voice, quick and cocky, slight rasp',
  'excitable teenage voice that cracks when shouting',
  'calm low voice, deadpan and unbothered',
  'loud energetic streamer voice',
  'soft-spoken, dry and sarcastic voice',
  'gruff growly voice, short sentences',
  'bright confident voice, fast talker',
  'nasal voice, whiny when losing',
  'smooth relaxed radio voice',
  'high squeaky voice, fearless and loud',
  'tired voice that sighs before speaking',
  'booming theatrical voice that treats everything as drama'
]

function hash (s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }

function read () { return U.exists(FILE) ? U.readJson(FILE) : { players: {} } }

// Voices a player may choose in game are bank voices on the voice server.
function bankHas (id) {
  try { return !!require('../../voice_server/bank.json').voices[id] } catch { return false }
}

// Cast entry for a player. `chosen` is the bank voice they picked with /movie voice
// (or null); without one they get a random made-up voice, created the first time
// they speak and kept from then on.
function voiceFor (name, chosen) {
  if (chosen && bankHas(chosen)) return { voice: 'stock:' + chosen, profile_id: chosen, chosen: true }
  const reg = read()
  const key = String(name)
  if (!reg.players[key]) {
    reg.players[key] = { voice: 'design', voice_desc: DESCRIPTIONS[hash(key.toLowerCase()) % DESCRIPTIONS.length], profile_id: 'player_' + U.slugify(key.replace(/^\./, 'b_')) }
    U.writeJson(FILE, reg)
  }
  return { ...reg.players[key] }
}

module.exports = { voiceFor, read, FILE, DESCRIPTIONS }
