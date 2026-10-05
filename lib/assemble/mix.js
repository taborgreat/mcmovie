'use strict'
// One place for how the film sounds and whether it is captioned. Defaults
// here; config/mix.json overrides any of them. Changing these only needs a
// re-assemble, never new voices or a new render.
const path = require('path')
const U = require('../util')

const DEFAULTS = {
  voice_gain_db: -2.5, // applied on top of each line's levelling; lower = quieter voices
  music_gain_db: 4.5, // added to every track's own gain; higher = louder music
  duck_ratio: 4, // how hard the music dips under speech (1 = not at all, 10 = nearly silent)
  duck_threshold: 0.03,
  title_card: false, // films open straight on the action; set true for a title card
  end_text: 'hardcorepvp.com', // end card when the film does not set its own
  end_seconds: 2.5,
  captions: true, // burned-in captions: narrator white with no name, players named in colour
  caption_font: 'DejaVu Sans',
  nametags: true, // match films: name and health bar above each player
  particles: true, // hit sparks, death puffs and loot, explosion debris, lightning
  clouds: true, // clouds and a sun in the sky
  game_sound: true, // films shot by the real client: mix in the game's own sound
  game_volume_db: -4, // the game's own sound, before a compressor that lifts footsteps and holds explosions down
  game_fireworks_db: -9, // the winner's fireworks: loud by nature, so held a little under the rest
  game_duck_ratio: 5, // how hard the game's sound dips under a voice
  game_makeup: 6,
  video_encoder: 'h264_nvenc' // final export on the graphics card; 'libx264' for the CPU
}

function load () {
  const f = path.join(U.ROOT, 'config', 'mix.json')
  if (!U.exists(f)) return { ...DEFAULTS }
  try { return { ...DEFAULTS, ...U.readJson(f) } } catch { return { ...DEFAULTS } }
}

module.exports = { load, DEFAULTS }
