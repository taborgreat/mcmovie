'use strict'
// Real player names and skins. Sources, in order:
//   1. an explicit players.json roster (name, uuid, skin)
//   2. a Minecraft server's usercache.json (e.g. the live hardcore server)
//   3. Mojang's API by username
// Skins are saved as skins/<name>.png (64x64) and used by the renderer for any
// actor whose `skin` (or name) matches. Bedrock (Geyser) players have names
// starting with "." and no Java skin; they get a fallback.
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const U = require('./util')
const prefsLib = require('./prefs')

const SKINS_DIR = path.join(U.ROOT, 'skins')
const ROSTER = path.join(SKINS_DIR, 'players.json')

function get (url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https
    lib.get(url, { headers: { 'User-Agent': 'mcmovie/0.1' } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

async function uuidForName (name) {
  const r = await get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`)
  if (r.status !== 200) return null
  const j = JSON.parse(r.body.toString())
  return j.id
}

async function profile (uuid) {
  const id = String(uuid).replace(/-/g, '')
  const r = await get(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`)
  if (r.status !== 200) return null
  const j = JSON.parse(r.body.toString())
  const tex = (j.properties || []).find(p => p.name === 'textures')
  if (!tex) return { name: j.name, uuid: j.id, skinUrl: null, model: 'classic' }
  const decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString())
  const skin = decoded.textures && decoded.textures.SKIN
  return {
    name: j.name,
    uuid: j.id,
    skinUrl: skin ? skin.url : null,
    model: skin && skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic'
  }
}

function readRoster () {
  return U.exists(ROSTER) ? U.readJson(ROSTER) : { players: [] }
}

function skinPathFor (nameOrSkin) {
  if (!nameOrSkin) return null
  if (nameOrSkin.endsWith('.png')) {
    const p = path.isAbsolute(nameOrSkin) ? nameOrSkin : path.join(SKINS_DIR, nameOrSkin)
    return U.exists(p) ? p : null
  }
  const p = path.join(SKINS_DIR, nameOrSkin + '.png')
  return U.exists(p) ? p : null
}

// names: array of usernames, or entries {name, uuid}. Fetches missing skins.
async function sync (entries, opts = {}) {
  fs.mkdirSync(SKINS_DIR, { recursive: true })
  const roster = readRoster()
  const byName = new Map(roster.players.map(p => [p.name.toLowerCase(), p]))
  const out = []
  const prefs = prefsLib.read()
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e.name
    let uuid = typeof e === 'string' ? null : e.uuid
    if (!name) continue
    if (name.startsWith('.')) { U.log('skins', `skip bedrock player ${name}`); continue }
    if (prefsLib.isAlias(name)) continue
    if (prefsLib.isBlocked(name, uuid, prefs)) {
      // /movie block: no skin on disk, no roster entry
      try { fs.unlinkSync(path.join(SKINS_DIR, name + '.png')) } catch { /* nothing stored */ }
      byName.delete(name.toLowerCase())
      continue
    }
    const file = path.join(SKINS_DIR, name + '.png')
    const known = byName.get(name.toLowerCase())
    if (known && U.exists(file) && !opts.force) { out.push(known); continue }
    try {
      if (!uuid) uuid = await uuidForName(name)
      if (!uuid) { U.log('skins', `no Mojang profile for ${name}`); continue }
      const prof = await profile(uuid)
      if (!prof || !prof.skinUrl) { U.log('skins', `no skin for ${name}`); continue }
      const png = await get(prof.skinUrl)
      if (png.status !== 200) { U.log('skins', `skin download failed for ${name}`); continue }
      fs.writeFileSync(file, png.body)
      const entry = { name: prof.name, uuid: prof.uuid, model: prof.model, skin: path.basename(file), source: opts.source || 'mojang' }
      byName.set(name.toLowerCase(), entry)
      out.push(entry)
      U.log('skins', `saved ${entry.skin} (${prof.model})`)
      await U.sleep(250) // be polite to Mojang's rate limit
    } catch (err) {
      U.log('skins', `error for ${name}: ${err.message}`)
    }
  }
  roster.players = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  roster.updated = new Date().toISOString()
  U.writeJson(ROSTER, roster)
  return out
}

function entriesFromUsercache (file) {
  const list = U.readJson(file)
  return list.map(x => ({ name: x.name, uuid: x.uuid }))
}

module.exports = { SKINS_DIR, ROSTER, sync, readRoster, skinPathFor, entriesFromUsercache, profile, uuidForName }
