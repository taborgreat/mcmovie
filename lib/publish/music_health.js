'use strict'
// Which songs are safe to keep using. A copyright claim that only shares revenue is fine;
// a film that gets muted, blocked or taken down is not, and the songs it used must not be used
// again (Tabor's rule). The hourly scan notices a film that was rejected or vanished; a mute is
// invisible to the APIs, so the admin page has a button for Tabor to say "this one was struck".
// Suspended songs are skipped by the finale and by the music picker.
const fs = require('fs')
const path = require('path')
const U = require('../util')

const FILE = path.join(U.ROOT, 'automation', 'music_health.json')

function read () { try { return U.exists(FILE) ? U.readJson(FILE) : { tracks: {} } } catch { return { tracks: {} } } }
function write (db) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); db.updated = new Date().toISOString(); U.writeJson(FILE, db) }

// the music a film used, by id: the library tracks and the finale song
function tracksOf (film) {
  const m = film && film.features && film.features.plan && film.features.plan.music
  if (!m) return []
  const ids = (m.tracks || []).filter(t => t !== 'finale_song')
  if (m.finale) ids.push('finale:' + m.finale)
  return [...new Set(ids)]
}

function free (id) {
  if (id.startsWith('finale:')) return false // the finale songs are all commercial tracks
  try { const t = (U.readJson(path.join(U.ROOT, 'music', 'music_manifest.json')).tracks || []).find(x => x.id === id); return !!(t && /CC|public domain|royalty/i.test(t.license || '')) } catch { return false }
}

// A film was muted, blocked or removed: every commercial track it used is suspended.
function strike (filmId, what = 'struck', by = 'admin') {
  const films = require('./films').read().films || []
  const film = films.find(f => f.id === filmId)
  if (!film) throw new Error(`no film ${filmId}`)
  const db = read()
  const hit = []
  for (const id of tracksOf(film)) {
    const t = db.tracks[id] || (db.tracks[id] = { trouble: [] })
    if (!t.trouble.some(x => x.film === filmId)) t.trouble.push({ film: filmId, title: film.title, what, by, at: new Date().toISOString() })
    if (!free(id)) { t.suspended = true; hit.push(id) }
  }
  write(db)
  return { film: film.title, tracks: tracksOf(film), suspended: hit }
}

function clear (id) { const db = read(); if (db.tracks[id]) { db.tracks[id].suspended = false; db.tracks[id].cleared = new Date().toISOString(); write(db) } }

function suspended () { return new Set(Object.entries(read().tracks).filter(([, t]) => t.suspended).map(([id]) => id)) }

// every track with where it was used and what happened to it
function status () {
  const films = require('./films').read().films || []
  const db = read()
  const out = {}
  for (const f of films) for (const id of tracksOf(f)) { const t = out[id] || (out[id] = { id, films: [], trouble: [], suspended: false, free: free(id) }); t.films.push({ id: f.id, title: f.title }) }
  for (const [id, t] of Object.entries(db.tracks)) { const o = out[id] || (out[id] = { id, films: [], trouble: [], suspended: false, free: free(id) }); o.trouble = t.trouble || []; o.suspended = !!t.suspended }
  return Object.values(out).sort((a, b) => b.films.length - a.films.length)
}

module.exports = { FILE, tracksOf, strike, clear, suspended, status, free }
