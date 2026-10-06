'use strict'
const assert = require('assert')
const packets = []
const bot = { _client: { write: (name, data) => packets.push({ name, data }) } }
const pose = require('../lib/mc/puppet').ownMovement(bot)
bot._client.write('look', { yaw: -30 })
bot._client.write('position_look', { x: -99 }) // the physics timer / delayed respawn response
bot._client.write('flying', {})
pose({ x: 1, yaw: 120 })
bot._client.write('teleport_confirm', { teleportId: 7 })
bot._client.write('keep_alive', { keepAliveId: 9 })
bot._client.write('arm_animation', { hand: 0 })
pose({ x: 2, yaw: 130 })
assert.deepStrictEqual(packets.filter(p => p.name === 'position_look').map(p => p.data), [{ x: 1, yaw: 120 }, { x: 2, yaw: 130 }])
assert.deepStrictEqual(packets.map(p => p.name), ['position_look', 'teleport_confirm', 'keep_alive', 'arm_animation', 'position_look'])
console.log('Replay exclusively owns movement; teleport/keepalive/action packets remain intact')
