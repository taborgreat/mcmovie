# mcmovie - operator manual for the LLM

> **Not on Tabor's production box?** If this is Max's copy (or any clone without
> `~/hgserver`, `config/publish.json` and the film loop), read `max.md` first. It
> says what applies there and what to leave alone.

One prompt in, one finished MP4 out. You (Claude Code) are the orchestrator
and the planner. The scripts are deterministic plumbing; you write the plan
files and run the commands. Spec: `instructions.md`. Nothing runs on a timer.

## How a movie gets made

```
mcmovie new <slug> "<prompt>"      -> projects/<slug>/prompt.txt
[you] story.json + world.json       prompts/outline.md   (stage 1)
[you] scene_<id>.json per scene     prompts/scene.md     (stage 2, one agent per scene)
[you] cast.json                     prompts/casting.md   (stage 3)
mcmovie validate <slug>             fix every error, read the warnings
mcmovie make <slug> [--mock-voice]  timeline -> shoot + voice -> render -> assemble
```
`make` is the same as running `timeline`, `shoot`, `voice`, `render`,
`assemble` in order. Run them separately when iterating. Output:
`projects/<slug>/final.mp4`.

When Tabor says "make a movie about X":
1. `node bin/mcmovie.js new <slug> "X"`.
2. Write `story.json` and `world.json` yourself following `prompts/outline.md`.
   If the prompt is about hardcorepvp kits, read `prompts/reference/kits.md`.
   If real players should star, read `skins/players.json` and use their
   usernames as character ids (`node bin/mcmovie.js skins:sync <name>` for
   anyone missing).
3. Spawn one subagent per scene (Agent tool) with: `prompts/scene.md`, the
   full `story.json`, `world.json`, and the scene id. Each writes
   `scene_<id>.json`. Scenes are independent, so run them in parallel.
4. Write `cast.json` (`prompts/casting.md`).
5. `node bin/mcmovie.js validate <slug>`; fix errors (re-run the scene agent
   with the error list if needed).
6. `node bin/mcmovie.js make <slug>`; if the voice server is not running use
   `--mock-voice` and say so. Rendering needs xvfb on Linux:
   `xvfb-run -a -s "-screen 0 1920x1080x24" node bin/mcmovie.js render <slug>`
   (`make` does not wrap itself in xvfb; run `make` under `xvfb-run -a` too).
7. Watch the output: `shoot_log.json` (late ticks should be 0), `edl.json`
   warnings (held shots, delayed lines), then look at frames from `final.mp4`
   with ffmpeg (`-ss 5 -frames:v 1 frame.png`) and describe what you see.
8. Re-render a single shot after fixing its path: `render <slug> --shot sh2`
   then `assemble`. Re-shoot a scene after fixing blocking:
   `shoot <slug> --scene s2`, then render + assemble.

## Real client filming (staged films)

Staged scenes are filmed by the real Minecraft client while the bots act
them, so everything on screen is the actual game: skins, name tags, held
items, armour, hit flashes, deaths, explosions, lightning, particles, and
the game's own sound. `shoot` does it (`lib/capture/`); `render` then has
nothing to do. `--no-film` / `--offline` falls back to the old renderer.

- Everything lives in `capture/` (not system-wide): `capture/.venv`
  (portablemc launcher), `capture/mc` (game files), `capture/vgl` (VirtualGL,
  unpacked from its .deb), `capture/work` (options, logs, resource pack).
  The client runs on a virtual display (Xvfb `:77`), draws on the 3090
  through VirtualGL's EGL backend, and writes game sound to
  `capture/work/game.wav` through OpenAL's wave writer (music is muted).
  Capture and the final export are encoded on the GPU (`h264_nvenc`), so the
  game server's CPU is left alone. Settings: `config/capture.json` over
  `lib/capture/client.js` DEFAULTS; `video_encoder`, `game_sound`,
  `game_volume_db`, `game_fireworks_db` (fireworks scenes keep full level) in `config/mix.json`.
- The client joins the set server as spectator `Lens` (offline name; log in
  with `capture/.venv/bin/portablemc login` to run it on Tabor's account).
  `lib/capture/film.js` summons one invisible camera entity per cut and makes
  `Lens` spectate the one on screen; a pov cut spectates the actor. The take
  is recorded with ffmpeg and split into `clips/<shot>.mp4` (with game
  sound); a clap at tick -6 lines the recording up with the tick clock and
  each cut is snapped to the frame where the picture changes.
- Skins: the set server runs SkinsRestorer; the shoot runs
  `/skin set <cast skin> <actor>`. The director bot waits 80 blocks under the
  set while filming (a spectator would show as a ghost head).
- Knockback in staged scenes is the server's: `knockback:N` on a keyframe
  flies the real arc from hardcorekits' `combat.knockback` settings
  (`lib/speeds.js` KNOCKBACK; keep the two in step if Tabor retunes them).
- Timing: `lib/mc/tickclock.js` keeps the shoot's 20 Hz beat half a tick away
  from the server's tick boundary (from its once-a-second time packet), so no
  server tick gets two batches or none. Cuts land on the frame the camera
  really switched (a few frames either side of the plan; the scene keeps its
  length), never on a frozen or repeated frame. A camera aimed at a player
  eases toward them (`look_smoothing`, 0.18 s) instead of copying each twitch.
- **The camera keeps its subject in sight** (`Film.pose` in
  `lib/capture/film.js`): for any shot aimed at a player, a ray is cast from
  the player to where the plan wants the camera. If something is in the way
  the camera slides in along that line (fast) and eases back out (slow); if
  a wall is close on that side it swings round the player to the nearest
  clear side, eased, instead of squeezing against the wall. It never moves a
  block at a time. Only a fixed shot with nothing to track is lifted out of
  the ground. Follow cameras also keep at least 85% of their planned distance.
- A clip filmed dark (a cave, a night fight) gets a gentle gamma lift when it
  is cut from the take; daylight clips are left as filmed. The client itself
  runs at the game's "bright" setting.
- The lens is lifted out of blocks and plants; tall grass is trimmed from the
  stage. FOV is the client's (70, or 92 for vertical), not per shot.
- **Match films are filmed the same way, in the studio** (`lib/studio/`):
  `studio/` is a private copy of the game the live server runs (Paper 26.2,
  port 25567, offline, ViaVersion + ViaBackwards so the 1.21.4 bots can
  join, SkinsRestorer). `mcmatch finish` / `make` load the match's own
  region files into it, replay every segment with one bot per player
  (positions, held items, armour, swings, hit flashes, real `/kill` deaths,
  block changes by name, lightning, explosions, fireworks) and film it with
  the 26.2 client. A take that fails (a hung login, a client that did not
  come up) is tried again, three times, and then the job fails: there is no
  quiet fallback to the offline renderer, because a film drawn by it must
  never go out by accident (Tabor's rule, after one slipped into a test
  export). `--offline` draws a film with it on purpose, `--offline-fallback`
  allows it after the failed takes, and either way the upload check refuses
  any shot not filmed in the real game unless `"allow_offline_render": true`
  is set in `config/mix.json`. The usual cause of a hung login is
  SkinsRestorer waiting on a rate-limited skin lookup: both private servers
  keep lookups for a month (`U.calmSkinLookups`, applied at every start), and
  the director's join is retried three times. A live take is never frozen mid-way by the match gate.
  Recorded creatures and projectiles are replayed too: each mob the recorder
  followed (golems, zombies, wolves, animals, arrows) is summoned as itself
  with its AI off and walked along its track. When the recording says a
  creature hit a player, its mind is switched on for a moment so it really
  swings (the golem's arms come up); when a player hits a creature it
  flinches, and dies on the blow the recording marks as the last. Older
  recordings without those marks fall back to who is nearest. Also real in
  the studio: a block broken by hand breaks with its crack, bits and dropped
  item (`setblock ... destroy`), a placed block makes its sound, a death
  spills the loot the recorder listed, a thrown item leaves the hand, a stew
  burps, a player's blow sounds like one, a teleport puffs, and a player the
  recording saw as invisible is invisible. Not shown: riding, elytra flight,
  fishing lines, chests opening, and kit effects the recorder does not log.

- **Real kits in the studio** (studio mode): the studio server runs the
  hardcorekits plugin itself with `studio.enabled: true`
  (`studio/plugins/HardcoreGames.jar`, built only in a scratch copy, never in
  the plugin repo). In that mode the plugin starts no match, no stats, no web
  port and no recorder: only the kits, every gate open, and `/studio kit
  <player> <kit>`, `/studio fire <player> [kit] [x y z]`, `/studio clear`,
  `/studio reset`. The recorder logs an `ability` event whenever a kit is
  allowed to fire; `build.js` carries those into the replay with each
  player's kit, and `perform.js` assigns the kits at the start of a scene and
  calls `/studio fire` at each one, so the effect on screen is the plugin's
  own code (26 kits fire this way; passive kits need nothing). The plugin's
  `StudioGuard` keeps the puppets safe: nothing it does can kill or move a
  bot. With the jar absent, films are made exactly as before. The live
  server only gets studio-mode source when someone builds the plugin repo;
  it cannot switch on there (it needs `studio.enabled` and offline mode).

## Match mode (a real match in, a narrated film out)

The opposite direction: instead of planning a story and staging it, a real
hardcorepvp match is recorded by the plugin and you narrate what happened.
Separate CLI and code (`bin/mcmatch.js`, `lib/match/`); it shares the
renderer, voice client and assembler with staged movies.

```
node bin/mcmatch.js list                      recordings waiting
node bin/mcmatch.js import latest             -> projects/match-<id>/digest.md (+ skins synced)
[you] doc.json                                 prompts/match.md, from digest.md only
node bin/mcmatch.js check <slug>
xvfb-run -a -s "-screen 0 1920x1080x24" node bin/mcmatch.js make <slug> [--mock-voice]
```
`make` deletes the recording once final.mp4 exists (Tabor's rule). Use
`--keep-recording` while iterating on doc.json, then `cleanup <slug>`.

- The recorder is `com.hardcorekits.record.MatchRecorder` in ~/github/hardcorekits
  (config block `recording:`). It logs deaths, hits, block changes,
  explosions, projectiles and chat, and samples positions adaptively: a
  point every 2 s while a player only travels, every 0.5 s with another
  player within 24 blocks, 10 per second only in a fight (damage, a player
  within 8 blocks, the drop, the ceremony); a player standing still is not
  rewritten. On the next boot the retired map's region files are moved into
  the recording.
- `lib/match/digest.js` is the layer between the recording and you. You do
  not read tracks or raw events: `digest.md` is the skeleton (ending,
  winner's road backwards, side moments, one line per player, kill tree,
  moment index) and `moments/<id>.md` zooms into one moment. Plan backwards
  from the winner, pick side characters, open only the moments you use.
  Recordings live in `~/hgserver/plugins/HardcoreGames/recordings/<id>/`;
  the plugin keeps at most `keep-max` (3).
- `lib/match/insight.js` adds what a caster who plays the game would notice,
  at the bottom of digest.md: `/highlight` moments players marked (max 3 a
  game each; one player using all of them alone counts once), teaming (pairs
  together 90 s+ without fighting, and betrayals), stews per player and per
  kill with hotkeying, towering, deaths nobody caused (starved, drowned,
  fell), and which rules are worth saying this time (feast and forcefield
  only when relevant; invincibility and no-respawn only now and then).
  Stew and highlight events need the plugin build that logs them. It also
  writes "In plain words": each player's match with the numbers already
  turned into what they meant. The narrator mostly says what the data
  meant (hearts, places, moments) and keeps a raw number now and then for
  colour (Tabor likes a little data, not data after data); `check` only
  rejects two data lines in a row or more than about one line in three.
- **The finale** (`lib/match/finale.js`): every match film shows its last
  fight under Tabor's finale song, at real speed for ordinary combat so it
  stays intense, and in slow motion only for a sudden kill (a stomp, a trap,
  a fall, a blast, a fight over in a blink; `finale.slow` auto/always/never).
  The song is the first audio file at the
  project root or in `music/finale/` (settings under `finale` in
  `config/mix.json`: `drop_sec` 9, `speed` 0.5, `level_db` -19). The cut, as
  Tabor asked for it: `finale_build` is the song's build-up, silent, on the
  two players' faces just before the fight; the drop lands on the first hit
  (`finale_fight`); a long fight skips its middle and cuts to `finale_kill`;
  then the celebration, whose music swells in under the song's last two
  seconds from the loudest part of its track so the ending carries through.
  digest.md ends with the exact segments; `check` enforces them (no words in
  the build-up, the segment before has finished talking). The builder sets
  speed, music and the face shots; when it is slow, the studio lowers the server tick rate so
  the slow motion is the game itself. The song always plays out, over the
  start of the celebration if the fight ends first. The celebration ends when the winner stops doing anything on the
  cake tower or hops off (at least 4 s, at most 12 s; `check` enforces the
  end time digest.md gives), so the end card comes promptly. No song file means no finale.
- **Whoever speaks is on screen.** A line with a player `speaker` (their chat
  or a line in their voice) gets its own camera window in `autoShots`
  (`speech`): the cut goes to that player on the frame the line starts, from
  the front and close, and holds until it is said. A death window nearby
  wins, a speaker who is not in the segment is skipped, and
  `"show_speaker": false` on the line leaves the picture alone.
- **A Stomper's kill is filmed from above** (`stomp` in `finale.plan`,
  `stompShots` in `lib/match/autoshots.js`): when the last kill is a Stomper
  landing on someone from 4 blocks or more, the fight segment opens half a
  second before he leaves the height (not on the hit), is slowed so leap, fall
  and hit take about 5 s on screen, and one camera rides 7.5 blocks over him
  and a little to the side, looking down past him at his victim, on whichever
  side keeps the tower or cliff he jumped from out of the lens.
- `lib/match/anvil.js` reads the 26.2 region files and maps blocks by name
  onto the renderer's 1.21.4; newer blocks become look-alikes or air.
- `lib/match/build.js` cuts each segment out of the recording into a replay,
  rewinding logged block changes so the terrain is right for that moment.
  Between sparse points a walker takes the footing closest to its path and
  ignores leaves, so passing a tree keeps it on the ground.
- `lib/match/autoshots.js` picks cameras against the real terrain.
- Films are 3-5 minutes and must contain the final kill (`check` enforces it).
- Never build hardcorekits in its repo casually: `tools/run-loop.sh` installs
  `build/libs/*.jar` into production at the next match rotation. Building
  there IS deploying. Test builds go in a scratch copy.

## Formats, music moods, voices (both modes)

- **Format**: `long` = 1920x1080, 3-5 minutes. `short` = vertical 1080x1920
  YouTube Short, 35-90 seconds. Staged: `"format"` in story.json. Match:
  chosen at import from the match length (under 12 minutes -> short),
  stored in `format.json`, `--format` to force. `--size WxH` still overrides
  pixels for quick tests. See `lib/formats.js`.
- **Music moods**: films ask for music by mood and can change mood per scene
  (`"music_mood"` on a story scene) or per segment (`"music"` in doc.json).
  The track crossfades when the mood changes. Tracks are matched by
  `mood_tags` in `music/music_manifest.json` (`music:scan` tags from folder
  names like music/sad/x.mp3; `music:mock` makes a synthetic palette).
- **Voices**: narrator and staged characters come from cast.json. In match
  mode a narration line with `"speaker": "<player>"` is spoken in that
  player's permanent made-up voice (`config/player_voices.json`, created on
  first use; edit `voice_desc` to recast). Real chat lines get `"chat": true`.
  Designed voices are built once on the voice server and reused.

- **Captions and mix** (`lib/assemble/captions.js`, `lib/assemble/mix.js`,
  overrides in `config/mix.json`): every film gets burned-in captions, a few
  bold words at a time low in the frame; the narrator is white with no name,
  each other speaker has their name above the words in their own colour.
  Voices sit a little lower and music a little higher than neutral
  (`voice_gain_db`, `music_gain_db`, `duck_ratio`). Films open on the action:
  no title card unless `title_card` is set. Changing any of this only needs
  `assemble`, not a re-render.
- **The ending: flash card + outro** (every film, staged and match, both
  shapes). After the last shot's freeze and fade (`end_freeze_sec`) comes a
  flash of text in the site's pixel font on black, up for `end_flash_sec`
  (1.2 s: Tabor wanted it to hang a little longer than a flash): `end_flash_text` ("EVERY VIDEO IS
  A REAL MATCH / WANT TO BE IN ONE WITHIN THE HOUR? / GO TO", line
  `end_flash_highlight` in yellow); a staged story is not a match, so its card
  is `end_flash_text_story` ("EVERY MATCH IS RECORDED / WANT TO BE IN A VIDEO
  WITHIN THE HOUR? / GO TO"). Then the outro clip for the film's shape,
  `assets/outro/outro_short.mp4` (1080x1920) or `outro_long.mp4` (1920x1080),
  with its own sound at `outro_volume_db` (never ducked; the film's music has
  faded by then). `"outro": false` in `config/mix.json` (or `cards.outro:
  false` in one film's timeline), or a missing clip, gives the old plain end
  card (`end_text`, `end_seconds`). `lib/assemble/edl.js` adds the two
  segments, `lib/assemble/ffmpeg.js` draws the card and lays the clip in,
  `lib/publish/verify.js` checks the outro is really on the end (its daylight,
  its sound, a black last frame). Re-assemble any project with
  `node bin/mcmovie.js assemble <slug>`.
- **The outro clip** (`lib/outro/`, about 6 s): real game footage. The camera
  is in a dark pocket inside a mass of stone; a miner (`noob`, Steve, no name
  tag) breaks three blocks of the wall toward it, the last an iron ore
  ("buda buda, buda": strike then break, never evenly spaced), and
  HARDCORE / PVP / .COM pop on the holes and stay there, trembling. A creeper
  behind him goes off: the stone is gone, he is knocked into a crater. A far
  bolt of lightning sets a cow alight. He looks up at the words, holds it, a
  second bolt lands on him (seen for six frames), and on the cut to black the
  words slam into HARDCOREPVP.COM, branded white-hot and cooling, which fades
  with the thunder. Remake: `node bin/mcmovie.js outro:make` films both shapes
  with the real client on the set server (check `mcauto status` first; it
  refuses while the client or studio is in use) and writes `raw_<shape>.mp4`,
  `outro_<shape>.mp4` and `outro.json` (the measured beats and levels);
  `outro:make --post` redoes only the words and sound from the raw takes.
  Everything is a named setting in `lib/outro/make.js`: `PLAN` (ticks of
  every beat, the spot on the set world, lens), `SHAPES` (word sizes),
  `CHARGE` (the tremble), `STAMP` (hit-stop, slam, heat, glow, sparks, thump,
  levels). The font is Press Start 2P (`assets/fonts/`, SIL OFL). The set
  server now runs with `spawn-monsters=true` so the creeper can be summoned
  (peaceful difficulty and `bukkit.yml` still keep monsters out of stories).
  Tabor approved the clips in `assets/outro/` by eye: do not remake them
  unasked (copies in `keep/outro-approved-0707/`).
- The renderer animates idle life itself (arm sway, small head movement) and
  makes whoever is speaking nod and gesture; plans do not need to ask for it.
  It also draws clouds and a sun, hit sparks, death puffs with scattered
  loot, explosion fireballs with debris and smoke, lightning bolts, armour
  plates by material, held items, and (match films) a name tag with a health
  bar over every player. Switches: `nametags`, `particles`, `clouds` in
  `config/mix.json`.
- Match footage is filled in from sparse data: travel between recorded points
  follows a curve through them, stays on the saved terrain, steps around
  trunks and walls, and sprint-jumps at running speed. The recorder adds a
  point at every sharp turn or 7 blocks, follows the animals near a fight,
  and logs armour. The automatic camera gives every death and every
  explosion or lightning strike its own shot, and never leaves the terrain
  loaded for the segment. The winner's ceremony gets a wide shot of the cake
  tower, and the recorder logs each firework burst so they are drawn.
- **Player choices** (`/movie` in game, stored by the plugin in
  `~/hgserver/plugins/HardcoreGames/movie-prefs.json`, read by `lib/prefs.js`):
  `/movie block` keeps a player's name and skin out of every film. The
  recorder writes them only as `TributeN` with no UUID; anyone who blocks
  after a match is anonymised when the recording is loaded; their skin is
  never fetched and they are never cast in staged stories. Never work around
  this. `/movie voice <name|number>` picks one of the bank voices listed
  under `movie.voices` in the plugin's config.yml; without a choice the
  player keeps a random made-up voice. No block means shown.

## Publishing and the unattended loop

```
node bin/mcpublish.js show <slug>          title/description that would be used
node bin/mcpublish.js <slug> --dry-run     no upload
node bin/mcpublish.js <slug>               YouTube upload + Discord post -> published.json
node bin/mcpublish.js auth                 one-time YouTube consent (saves refresh token)
node bin/mcauto.js status | once | story | run
```
- Credentials live in `config/publish.json` (gitignored; copy
  `config/publish.example.json`). Never print or commit them.
- **Titles and descriptions** are the plan's own `title` and `logline`,
  published as written (Tabor's format, keep it plain): a story is just its
  title; a match is `HardcorePvP.com #<n>: <title>`, numbered in upload order
  (`automation/match_number.json`, edit `last` to renumber). The description
  is the logline, one line saying every match is recorded and to play one at
  the site to be in a video (`youtube.invite` in the config, `{site}` allowed,
  empty to drop it), `IP is hardcorepvp.com`, the hashtags (`youtube.hashtags`
  in the config, defaults in `lib/publish/publish.js`), then credits for
  licensed music. The style is in `prompts/match.md` and `prompts/outline.md`
  ("Title and logline"); `lib/publish/copy.js` is the part `check` and
  `validate` enforce. No `#Shorts` suffix: YouTube classifies by shape.
- **Discord posts are flat text**: a match is just `Hardcore Game #<n>` and the
  link; a story is its description and the link. No bold titles.
- **Who is in each film** (`lib/publish/films.js`): at upload the publisher
  works out the players who appear: everyone the camera caught in a frame of
  any cut (inside the lens and within 64 blocks; walking through the back of
  a shot counts, being nearby but never in the picture does not). In a staged
  film a character counts when a real player plays it; invented stand-ins
  (test dummies, decoys) have nobody to credit, adds a `Players in this video:` line to the description,
  and saves a record in `automation/films.json` (kept forever, like
  `state.json`). The website reads that file (`/api/films?player=`) to list a
  player's videos on their profile; unlisted uploads are not shown. Blocked
  players never appear in it.
- `mcauto run` is the loop Tabor wants running in tmux: every finished match
  recording becomes a film (short match -> Short, long -> video), uploaded
  and announced on Discord with the match date; after `idle_hours` (8) with
  no match it makes a staged story from random recent players and kits, then
  the idle clock restarts. One job at a time, never interrupted; a match that
  ends during a story waits its turn. Settings: `config/auto.json` over the
  defaults in `lib/auto/config.js`. State and logs: `automation/`.
- **What runs when** (`lib/auto/gate.js`): planning (Claude, in the cloud) and
  voices (the 3090) never touch the game server's CPU, so they run at any
  time, including during a live match. The bot shoot, render and export are
  CPU-heavy: they start only while the game server is not in a live match
  (state from `http://127.0.0.1:8085/api/status`), and a render or export
  that is still running when a match goes live is frozen (SIGSTOP) and
  resumed in the next lobby. So a match's film is typically planned and
  spoken during the next match and exported in the lobby after it. If no
  next match starts, nothing waits: it finishes and uploads.
- The loop calls Claude Code headless (`claude -p`) for planning only
  (prompts in `prompts/auto/`): the LLM reads and writes plan files, the
  daemon runs every command and feeds checker errors back for another
  round. Heavy steps run under `nice`.
- A match job that fails `max_attempts` times deletes its recording (disk
  rule). A project is never published twice (`published.json`).
- **Nothing unverified is uploaded.** `lib/publish/verify.js` runs inside the
  publisher: the file must decode end to end, match the edit's length and
  size, have picture and sound, contain no placeholder or missing shots and
  no unvoiced lines, and not be mostly black or frozen. A failure is a failed
  job, never an upload (`mcpublish verify <slug>` shows the checks).
- **Nothing lingers.** Once a film is uploaded its whole project folder is
  deleted (replays, clips, voice lines, the rendered file); the match
  recording is already gone by then. What stays is the record in
  `automation/state.json` (title, URL, time) and the logs for two weeks. A
  film that was not uploaded (publishing off, or the upload failed) is kept.
  After a staged story the set world is wiped; it regrows from its seed.
- Start and stop the loop with `tools/start-films.sh [--story-first]` and
  `tools/stop-films.sh` (tmux window "films", log `automation/loop.log`).
- **Staged stories are shot on natural terrain.** The set server is a
  generated world (`server:setup --terrain normal`). Each story gets a
  scouted stage (`terrain:pick <slug>` writes `terrain.json`: origin, ground
  height, biome); trees are cleared from the stage only; actors settle onto
  the real ground and a planned camera inside a hill is lifted out. The
  outline must commit to `point`, `premise`, `turn`, `final_image` and
  `feeling` (prompts/outline.md, "The story comes first"): a game situation
  with a clear outcome, told by a narrator, an event in every scene. The loop
  then runs an editor pass (`prompts/auto/story_review.md`) that rewrites an
  outline with no point. `mcauto story --no-publish` makes one and keeps it
  without uploading. Idle stories are OFF in `config/auto.json`
  (`idle_stories: false`, 2026-10-05): Tabor watched the automatic ones and
  found them hollow next to real matches, so the channel is real matches
  only. Do not turn them back on unasked.

## Stage files (all in projects/<slug>/)

| file | written by | read by |
|---|---|---|
| prompt.txt | `new` | you |
| story.json, world.json | you (outline) | validate, timeline, scene agents |
| scene_<id>.json | scene agents | validate, timeline |
| cast.json | you (casting), voice:cast | voice |
| timeline.json | timeline (+ shoot, voice, render write results back) | render, edl |
| shoot.json, voice.json | timeline | shoot, voice |
| replay/scene_<id>.json.gz | shoot | render |
| wav/<line>.wav, voice_result.json | voice | edl |
| clips/<shot>.mp4 | shoot (real client) or render | assemble |
| shoot_log.json | shoot | you |
| edl.json, ffmpeg_filter.txt | assemble | ffmpeg |
| final.mp4 | assemble | Tabor |

Schemas: `lib/schemas/*.schema.json`. Timing model: `lib/speeds.js`.

## Architecture (what each piece is)

- `lib/mc/server.js` Paper 1.21.4 set server in `server/`, port 25566, offline
  mode, flat world (grass at y=64). Separate from the live hardcorepvp server
  on 25565; never touch that one.
- `lib/mc/director.js` op'd bot "Camera": builds sets with /fill etc., runs
  world events, hovers over the set so chunks and entities are loaded,
  snapshots everything for the replay.
- `lib/mc/actor.js` + `lib/motion.js` one mineflayer bot per character,
  physics off, position/look packets every tick straight from the keyframes.
- `lib/mc/shoot.js` the master clock. 20 ticks/s, never skips a tick, logs
  late ticks. Writes one replay per scene.
- `lib/render/render.js` offline renderer (prismarine-viewer + headless-gl):
  replay + camera paths -> clips at any fps/resolution. Player skins from
  `skins/`. Needs an X display (xvfb). Swappable later for a real client.
- `lib/camera.js` camera path math; `lib/timeline.js` the editor (cut
  resolution, scene offsets); `lib/assemble/*` EDL + ffmpeg (ducking, cards).
- `lib/voice/client.js` HTTP client for `voice_server/` (`--mock` without it).
- `lib/skins.js` real player skins via Mojang; roster in `skins/players.json`.
- `lib/formats.js` long/short; `lib/publish/*` YouTube + Discord;
  `lib/auto/*` + `bin/mcauto.js` the unattended loop; `lib/voice/players.js`
  permanent player voices.

## Operating rules

- Plan fully, then execute. Do not edit plan files mid-shoot.
- `timeline` rebuilds keep earlier results (wavs, replays, clips) for items
  whose plan did not change; pass `--fresh` to drop them.
- The live hardcorepvp server (`~/hgserver`, port 25565) is production. Only
  read its `usercache.json`. Our set server is `server/` on 25566.
- Kit-vs-kit stories are staged: give actors the kit's items (`hold:`), use
  swings, sprints, `explode`/`lightning`/`summon` events. Kit plugin effects
  do not run on the set server and particles do not render.
- If a stage fails, say which stage, show the error, fix, re-run that stage.
- Check the demo for a working example: `projects/demo/`.
