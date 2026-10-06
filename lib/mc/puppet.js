'use strict'
// Mineflayer still sends movement/look packets on its own 50 ms timer when
// physicsEnabled is false. A replay must have one movement producer, otherwise
// those packets interleave smoothed/stale angles with the recorded pose.
const MOVEMENT = new Set(['position', 'position_look', 'look', 'flying'])
function ownMovement (bot) {
  const client = bot._client
  const write = client.write.bind(client)
  client.write = (name, data) => { if (!MOVEMENT.has(name)) return write(name, data) }
  // Login already completed. Teleport confirmations, keepalives, actions, and
  // respawn requests continue through; the replay explicitly supplies poses.
  return (data) => write('position_look', data)
}
module.exports = { ownMovement }
