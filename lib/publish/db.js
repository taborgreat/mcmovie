'use strict'
// The films' numbers in MongoDB, next to the server's other data, so they outlive this folder
// and the planner can be fed them later. Two collections in `hardcorepvp`:
//   films         one document per uploaded film: title, logline, shape, length, players,
//                 match number, where it is on each platform, and its latest numbers
//   film_samples  one document per video per hour: the counts at that moment
// Where: MCMOVIE_MONGO_URL, else `stats.mongo_url` in config/publish.json, else the local
// server. Everything here is best effort: no database never stops a scan or an upload.
const U = require('../util')

const DEFAULT_URL = 'mongodb://127.0.0.1:27017/hardcorepvp'
let clientPromise = null

function url (cfg = {}) { return process.env.MCMOVIE_MONGO_URL || (cfg.stats && cfg.stats.mongo_url) || DEFAULT_URL }

async function connect (cfg) {
  if (!clientPromise) {
    const { MongoClient } = require('mongodb')
    const c = new MongoClient(url(cfg), { serverSelectionTimeoutMS: 4000, connectTimeoutMS: 4000 })
    clientPromise = c.connect().then(async () => {
      const db = c.db()
      await db.collection('film_samples').createIndex({ video_id: 1, t: 1 }, { unique: true })
      await db.collection('film_samples').createIndex({ t: 1 })
      return c
    }).catch(e => { clientPromise = null; throw e })
  }
  return clientPromise
}

// films: the catalogue with each film's facts; samples: [{ video_id, t, yt, ig, tt }]
async function record (cfg, films, samples, log = () => {}) {
  let client
  try { client = await connect(cfg) } catch (e) { log('mongo: not reachable (' + e.message.slice(0, 80) + '); the numbers are kept in automation/stats.json only'); return false }
  const db = client.db()
  if (films.length) {
    await db.collection('films').bulkWrite(films.map(f => ({ updateOne: { filter: { _id: f.id }, update: { $set: { ...f, updated: new Date() }, $setOnInsert: { first_seen: new Date() } }, upsert: true } })), { ordered: false })
  }
  if (samples.length) {
    try {
      await db.collection('film_samples').insertMany(samples.map(s => ({ ...s, t: new Date(s.t) })), { ordered: false })
    } catch (e) { if (!/duplicate key/i.test(e.message)) throw e } // already stored: fine
  }
  return true
}

async function close () { if (clientPromise) { try { (await clientPromise).close() } catch { /* already closed */ } clientPromise = null } }

module.exports = { url, connect, record, close }
