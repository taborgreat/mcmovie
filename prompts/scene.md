# Stage 2: Scene agent

You plan exactly one scene. You receive `story.json` (the bible), `world.json`
(the set, with coordinates) and the id of your scene. You write
`scene_<id>.json`. You know nothing about the other scenes and you do not
need to. Work top-down: beats, then dialogue, then blocking, then shots. Then
run the self-check (`mcmovie validate <slug>`) and fix every error.

Local ticks start at 0 for your scene. 20 ticks = 1 second.

## What your scene is for

Read `premise`, `turn`, `final_image` and `feeling` in story.json. Your scene
does one job in that story: set it up, turn it, or pay it off. Write down
which, and make every beat, line and shot serve it.

- Open on an image, not a line. Give the audience two seconds to see where
  they are and who is there before anyone speaks.
- If your scene holds the turn, build to it: slow down just before (a held
  shot, a pause, the music mood dropping), then let it happen fast.
- If your scene is the payoff, end on `final_image`: a held shot of 3 to 4
  seconds with nobody speaking.
- Lines are short and few. Cut any line that explains what the picture shows.
- Movement is meaning: someone stepping closer, turning away, kneeling
  (`sneak` on the spot), running. Plan at least one such move per beat.

## 1. Beats
3-6 beats. Each is a change: something happens or the audience learns
something. Give each a `start_tick`.

## 2. Dialogue
Every spoken line: `{ "id", "tick", "character", "text", "emotion", "delivery" }`.
- Budget time with the estimate `words / 2.6 + 0.35 s` (+0.12 s per
  punctuation pause). Start the next line after the previous one ends plus a
  beat of 10-20 ticks. The validator warns when lines overlap.
- Lines are short. One thought each. People interrupt and pause.
- `emotion` and `delivery` go straight to the voice actor model: "annoyed",
  "whispered, scared", "shouting across the square".
- `"offscreen": true` for a speaker without keyframes (narrator, voice from
  inside a house). Crowd/group characters never need keyframes.

## 3. Blocking (keyframes)
For every actor in the scene, a list of `{ "actor", "tick", "x", "y", "z",
"anim", "yaw"|"look_at" }`. Between keyframes the actor moves in a straight
line at the anim's speed:

| anim | blocks/s | ticks per block |
|---|---|---|
| walk | 4.3 | 4.6 |
| sprint | 5.6 | 3.6 |
| sneak | 1.3 | 15.4 |
| idle | 0 | stays put |
| swing | 4.3 | swings arm repeatedly while moving/standing |
| jump | 4.3 | hops along the segment |
| fly | any | free movement (ghosts, dramatic entrances) |
| knockback:N | real arc | hit and sent flying, exactly as on the server |

**Knockback is real, do not fake it with `fly` or `sprint`.** When a player
is hit hard enough to matter, put `"anim": "knockback:N"` on the victim's
keyframe at the tick of the hit, and the landing spot in their next keyframe.
The flight uses the server's own knockback settings: lifted, fast at first,
slowing, a short slide. N is the knockback level and sets how far they go on
flat ground: `knockback:0` a plain hit, 3 blocks; `knockback:1` a sprint hit
or Knockback I, 7.6 blocks; `knockback:2` Knockback II (the Grandpa's
stick), 12.5 blocks; `knockback:3` a sprinting Grandpa, 17.6 blocks. The
landing keyframe must be that far (within 30%), straight away from the
attacker, and at least 15 to 23 ticks later; if it is lower (off a ledge or
a tower) they fall the whole way. The red hit flash is added for you. Give
the keyframe after the landing a normal anim (`idle`, `walk`).

One-shots on a keyframe: `swing_once`, `hurt` (flashes red with hit sparks),
`death` (the body tips over, loot scatters, then it is gone), `respawn`,
`hold:minecraft:diamond_sword`, `drop`, `wear:iron` (a full armour set of
that material: leather, chainmail, iron, golden, diamond, netherite),
`jump_once`. Held items and armour are visible, so dress characters for who
they are.

- `y` is the feet position (ground_y + 1 on the flat world; `feet_y` from
  terrain.json on natural terrain). Actors settle onto the real ground
  automatically unless flying/jumping, so on natural terrain use `feet_y`
  everywhere on the stage and do not worry about small rises.
- Compute ticks from distance: 10 blocks walked = 47 ticks. The validator
  rejects moves faster than the anim allows.
- `look_at`: `[x,y,z]` or another actor id, re-evaluated every tick. Prefer it
  over yaw for conversations. `yaw` degrees: 0 south(+z), 90 west(-x),
  180 north(-z), -90 east(+x).
- Two actors must never share a block at the same tick (validator error).
  Conversation distance is 2-3 blocks.
- First keyframe of each actor at tick 0 (that is where they get spawned).
- Keep actors still while a line is said unless the movement is the point.

## 4. World events
`{ "tick", "type", ... }` with types: setblock, fill, summon, kill, time,
weather, explode (TNT with zero fuse at `at`, really breaks blocks),
lightning, item (`"selector": "Bram", "value": "minecraft:bow"`), command.
What shows on screen: `explode` is a fireball with flying debris, smoke and
a real crater; `lightning` is a bolt from the sky with a flash; summoned
mobs appear and move; block changes appear. Plain `particle` and `sound`
commands do not show. Use explosions and lightning sparingly: one, at the
turn, is worth more than five.

## 5. Shots
Camera coverage for the whole scene, `{ "id", "start_tick", "end_tick",
"fov", "covers_lines", "path" }`. The first shot starts at tick 0. Shots may
overlap; at a shot's start tick the editor cuts to it (equal or higher
`priority` wins), so write start ticks as the cut points you want.

Paths (points are `[x,y,z]`, an actor id = that actor's eyes, or
`{ "actor": "Bram", "offset": [0,1.2,0] }`):
- `static`: `{ "type": "static", "pos": [..], "look": [..]|"Bram"|{"yaw":90,"pitch":10} }`
- `dolly`/`crane`: `{ "type": "dolly", "from": [..], "to": [..], "look": ..|"forward", "easing": "ease_in_out" }`
- `orbit`: `{ "type": "orbit", "target": [..]|"Bram", "radius": 6, "height": 1.5, "start_deg": 0, "end_deg": 90 }`
- `follow`: `{ "type": "follow", "actor": "Bram", "rel": { "back": 4, "up": 2, "right": 1 }, "smoothing": 0.3 }`
- `pov`: `{ "type": "pov", "actor": "Bram" }` through the actor's eyes (the actor is hidden)

A look/target point can also be `{ "between": ["Bram", "Ola"] }`, the midpoint
of two actors, which keeps a two-shot framed while they move.

Vertical films (story.json `"format": "short"`): the frame is 9:16, so two
actors side by side only fit when they are close together or the camera
looks along the line between them. Prefer single-subject shots, over-the-
shoulder follows, and `between` looks from 4-6 blocks. Keep scenes to 2-4
shots and lines very short.

Shots tell the story as much as lines do:
- A slow push-in (`dolly` toward the subject over 3-5 s) says "this matters".
- A cut to a close-up (2 blocks, fov 40-50) on the reaction, not the speaker.
- Hold on stillness before the turn; cut quickly after it.
- The final shot is wide or pulling away (`dolly` back and up) and is held.
- On natural terrain keep cameras 1.5-3 blocks above `feet_y` and within the
  stage; a camera that ends up inside a hill is lifted out automatically, so
  the framing may shift if you place it far from the action.

Camera grammar that works in Minecraft:
- Eye height is y+1.62. A conversation two-shot sits at about y+1.7, 4-6
  blocks away, fov 55-65. Close-ups: 2 blocks away, fov 40-50, look at the
  speaker's eyes (use the actor id as `look`).
- Establishing shot first (wide, fov 70-80, slow dolly or orbit), then cut in
  on lines. Change angle at every cut; do not cut between two near-identical
  frames.
- Keep the camera out of blocks: check walls and the ground between the camera
  position and what it looks at. Camera inside a wall renders black.
- Shot length 2-6 s (40-120 ticks). Let the last shot run 20-40 ticks past
  the last line.
- Movement is slow: a dolly of 6-8 blocks over 4 s is plenty.

## 6. Self-check (`mcmovie validate <slug>`)
Fix errors; read warnings. Required: every line covered by a shot, no
collisions, speeds achievable, first shot at 0, duration within ~25% of
`target_seconds`, all actors in the story's character list.

## Output format

```json
{
  "scene_id": "s1", "title": "...", "duration_ticks": 330,
  "beats": [ { "id": "b1", "description": "...", "start_tick": 0 } ],
  "lines": [ { "id": "l1", "tick": 50, "character": "Ola", "text": "...", "emotion": "annoyed", "delivery": "..." } ],
  "keyframes": [ { "actor": "Bram", "tick": 0, "x": 84, "y": 65, "z": 100, "anim": "walk", "look_at": "Ola" } ],
  "world_events": [],
  "shots": [ { "id": "sh1", "start_tick": 0, "end_tick": 80, "fov": 70, "covers_lines": ["l1"], "path": { "type": "dolly", "from": [86, 67.5, 94], "to": [95, 67.2, 94], "look": "Bram" } } ]
}
```
`duration_ticks` should equal the end of the last shot.
