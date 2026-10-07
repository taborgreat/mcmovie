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
  end_freeze_sec: 1.2, // the film's last frame freezes this long (colour draining, fading out) before the ending
  // The ending of every film: a flash of text, too short to take in at a glance on purpose (people
  // go back for it), then the outro clip for the film's shape with its own sound
  // (assets/outro/outro_short.mp4 / outro_long.mp4, made by `mcmovie outro:make`). false, or
  // no clip for that shape, = the plain end card above.
  outro: true,
  end_flash_sec: 1.2, // how long the text is up (0 = no card, straight to the outro)
  end_flash_text: 'EVERY VIDEO IS A REAL MATCH\nWANT TO BE IN ONE WITHIN THE HOUR?\nGO TO', // one line per \n; the outro then spells the address
  end_flash_highlight: 2, // which of those lines is yellow (0 = none)
  end_flash_text_story: 'EVERY MATCH IS RECORDED\nWANT TO BE IN A VIDEO WITHIN THE HOUR?\nGO TO', // the same card on a staged story, which is not a match
  end_flash_highlight_story: 2,
  outro_volume_db: 0, // the outro's own sound (it is never ducked or squeezed with the film's)
  effects: true, // Tabor's overlay effects (config/effects.json): rewind after a teaser, fast-forward on sped-up travel
  soft_duck_ratio: 1.6, // how much a feel song (finale_songs.json soft_duck) dips under a voice; the rest use duck_ratio
  promo_chance: 0.5, // of the films whose strategy allows a subscribe nudge (effects.promo), the share that get one; 0 = never
  effects_volume_db: -4, // their own sound, on the game-sound bus (ducked under dialogue like the game)
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
