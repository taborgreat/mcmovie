'use strict'
const assert = require('assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const client = require('../lib/voice/client')
async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmovie-voice-'))
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ backend: 'mock', voices: [] }))
  })
  try {
    fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify({ lines: [] }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    await assert.rejects(client.castVoices(dir, { url }), /mock backend/)
    await assert.rejects(client.voice(dir, { url }), /mock backend/)
    const oldPrefs = process.env.MCMOVIE_PREFS
    try {
      process.env.MCMOVIE_PREFS = path.join(dir, 'movie-prefs.json')
      fs.writeFileSync(process.env.MCMOVIE_PREFS, JSON.stringify({ players: { id: { name: 'Alex', voice: 'caster' } } }))
      fs.writeFileSync(path.join(dir, 'cast.json'), JSON.stringify({ characters: { Alex: { voice: 'stock:kid', profile_id: 'kid', chosen: true } } }))
      const cast = await client.castVoices(dir, { mock: true })
      assert.strictEqual(cast.characters.Alex.profile_id, 'caster', 'a newer in-game choice replaces an old choice')
    } finally {
      if (oldPrefs === undefined) delete process.env.MCMOVIE_PREFS
      else process.env.MCMOVIE_PREFS = oldPrefs
    }
    console.log('PASS: real voice stages reject a server silently running mock TTS')
    console.log('PASS: changed in-game voice choices override a previously chosen cast voice')
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
