'use strict'
// What players chose in game with /movie (hardcorekits MoviePrefs):
//   /movie block           -> never show this player's name or skin
//   /movie voice <choice>  -> speak their lines in this bank voice
// No entry means: shown, random voice. The file is the plugin's own
// movie-prefs.json, read fresh each time so a choice applies to the next film.
const os = require('os')
const path = require('path')
const U = require('./util')

function file () {
  return process.env.MCMOVIE_PREFS || path.join(os.homedir(), 'hgserver', 'plugins', 'HardcoreGames', 'movie-prefs.json')
}

function read () {
  const f = file()
  if (!U.exists(f)) return { byUuid: new Map(), byName: new Map() }
  let players = {}
  try { players = U.readJson(f).players || {} } catch { /* unreadable: treat as empty */ }
  const byUuid = new Map(); const byName = new Map()
  for (const [uuid, e] of Object.entries(players)) {
    const entry = { uuid, name: e.name || null, blocked: !!e.blocked, voice: e.voice || null }
    byUuid.set(uuid.replace(/-/g, '').toLowerCase(), entry)
    if (e.name) byName.set(String(e.name).toLowerCase(), entry)
  }
  return { byUuid, byName }
}

function lookup (prefs, name, uuid) {
  if (uuid) { const e = prefs.byUuid.get(String(uuid).replace(/-/g, '').toLowerCase()); if (e) return e }
  if (name) { const e = prefs.byName.get(String(name).toLowerCase()); if (e) return e }
  return null
}

function isBlocked (name, uuid, prefs = read()) { const e = lookup(prefs, name, uuid); return !!e && e.blocked }
function voiceOf (name, uuid, prefs = read()) { const e = lookup(prefs, name, uuid); return e ? e.voice : null }

// An anonymous stand-in name for a blocked player in slot i of a match.
function alias (slot) { return 'Tribute' + (slot + 1) }
const isAlias = (name) => /^Tribute\d+$/.test(String(name))

module.exports = { file, read, isBlocked, voiceOf, alias, isAlias }
