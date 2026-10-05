Minecraft Movie Generator
Build spec - one prompt in, one finished video out. Prepared for the builder. October 2026.
1. The idea in one paragraph
A user types a single prompt, as simple or detailed as they like. The system expands that prompt into a full
plan (a tree: story, scenes, characters, dialogue, camera shots), then executes the plan inside a real
Minecraft server using bot players as actors and a bot as the camera, records every shot to video,
generates every line of dialogue as audio on a local GPU, picks a song from Tabor's own music library,
assembles everything with ffmpeg, and exports a single MP4. No human touches it between the prompt
and the file. Uploading is explicitly out of scope for v1.
Why Minecraft instead of AI video: AI video has to invent every pixel and loses consistency within seconds.
Minecraft is a deterministic world engine. The AI never generates pixels; it only decides what happens,
where characters stand, and where the camera points. The engine renders it with perfect continuity. The AI
makes decisions, the engine makes frames.
2. Non-negotiable design principles
- Plan fully, then execute. Nothing is recorded until the entire tree is finished. No improvising mid-shoot.
- Tree, not blob. The prompt is decomposed top-down: outline, then scenes, then the beats inside each
scene, then the leaves (lines, shots, movements). Each level only has to worry about its own level.
- One scene = one focused agent context. Scene-level planning runs in its own agent with its own
memory: it knows the story bible and its scene, nothing else. This keeps context small and quality high.
- Everything is a file with a timestamp. Every handoff between stages is a JSON or media file keyed to
the same tick clock. Nothing is passed by feel.
- The tick is the clock. Minecraft runs at 20 ticks/second. Every movement, line, and shot is scheduled
in ticks. Timing is inferred from known speeds (walk 4.3 blocks/s, sprint 5.6 blocks/s, etc.) so the planner
can predict how long a move takes.
- Deterministic rendering. The planner writes an edit decision list; ffmpeg renders it. The AI never 'edits
by eye'.
- Keep the context window clean. Each stage reads only the files it needs. No stage sees the whole
project.
3. Pipeline overview
PROMPT
|
v
[1] OUTLINE AGENT ........ story bible, character list, scene list
|
v
[2] SCENE AGENTS (one per scene, parallel, own memory)
beats -> dialogue -> blocking -> shot list
|
v
[3] CASTING ............... assign a voice profile to every character
|
v
[4] BUILD TIMELINE ........ merge all scenes into one tick-based timeline
|
+-----------------------------+
| |
v v
[5a] SHOOT [5b] VOICE
Minecraft server POST each line to TTS server
bots act, camera bot on the 3090 -> WAV per line
films, recorder saves (runs in parallel with 5a)
one clip per shot
| |
+-----------------------------+
[6] MUSIC ................. pick track + in/out points from library manifest
|
v
|
v
[7] ASSEMBLE .............. EDL -> ffmpeg -> final.mp4
4. Stage-by-stage
Stage 1 - Outline agent
Input: the raw prompt. Output: story.json. Takes any prompt, however thin, and produces a complete
story bible: title, logline, tone, setting (biome, time of day, era of builds), a character roster (name, role,
personality, voice description, skin description), and an ordered list of 3-8 scenes, each with a
one-paragraph summary, location, which characters appear, and a target duration in seconds. Also writes
world.json: what structures must exist before shooting (a village, a tower, a cave) so the set can be built
or loaded first.
Stage 2 - Scene agents
One agent per scene, each spawned fresh with only story.json and its own scene entry. Output:
scene_N.json. Each agent works down its own branch:
- Beats: 3-6 beats per scene (what changes, what the audience learns).
- Dialogue: every line, tagged with character, emotion, and intended delivery. Crowd and background
noise lines are tagged with a group voice.
- Blocking: for every character, a list of movement keyframes: at tick T be at (x,y,z) facing yaw/pitch,
doing animation A (walk, sprint, sneak, swing, look-at). The agent computes ticks from distance and
known movement speeds.
- Shot list: every camera shot with start tick, end tick, camera path (static, dolly, orbit, follow-entity,
crane), FOV, and which line(s) it covers. Shots are allowed to overlap in time; the editor chooses
between them later.
Each scene agent runs a self-check before finishing: do all lines have a shot covering them, do any two
characters occupy the same block at the same tick, does total duration land near the target.
Stage 3 - Casting
Every character gets a voice profile. The TTS system must support multiple distinct voices in one project.
Two sources of voices:
- Stock bank (built once, reused forever): generic adult male, generic adult female, kid, elderly male,
elderly female, gruff/villain, narrator, and a crowd profile (several voices layered with slight timing
offsets to produce yelling/murmur).
- Designed voices: for named characters, the voice is generated from a text description in story.json
('tired old miner, slow and gravelly') using a model that supports voice design from prompt. The
reference clip it produces is saved so the character sounds identical in every line and every future video
that reuses them.
Output: cast.json mapping character -> voice profile id -> reference audio path.
Stage 4 - Timeline build
A plain script (no AI) concatenates scenes into one global tick timeline, offsets each scene's local ticks,
and emits timeline.json: the single source of truth for shooting and assembly. It also emits the three work
orders: shoot.json (bot keyframes + shots), voice.json (lines + voice profiles), world.json (set
requirements).
Stage 5a - Shoot (Minecraft)
A headless controller connects to the Minecraft server and drives it from shoot.json. See section 5 for the
control layer. For each scene: load or build the set, place bot actors at their first keyframe, start the tick
clock, play all keyframes, and for each shot start/stop the recorder. Output: one video clip per shot, named
by shot id, plus a log of the actual tick each shot started on (so audio sync uses real ticks, not planned
ticks).
Stage 5b - Voice (3090 box)
Runs in parallel with the shoot. A local TTS server on the 3090 exposes an HTTP endpoint. The
orchestrator POSTs each line with its voice profile and emotion tag and receives a WAV. Each WAV is
measured for duration and written back into timeline.json so assembly knows exactly how long each line is.
If a line runs longer than its planned shot, the assembler extends the shot's clip rather than cutting the line.
Stage 6 - Music
Tabor's own music library, tagged once in music_manifest.json (track id, path, mood tags, tempo,
intensity 1-5, loopable, good in/out points). The outline agent picks one or two tracks per video by mood
and tempo and writes the choice into timeline.json. No generated music in v1.
Stage 7 - Assemble
A script turns timeline.json into an edit decision list and then into an ffmpeg filtergraph: concatenate shot
clips in order, overlay dialogue WAVs at their real tick offsets, lay the music bed underneath with sidechain
ducking under dialogue, optional title card and end card, export final.mp4 (1080p, 30 or 60 fps, AAC
audio). Deterministic: same timeline in, same video out.
5. The Minecraft control layer
This is the part that must be built well. Everything else is glue. The bots have to be controllable precisely
and the camera has to be controllable precisely, both on a tick clock.
Build vs. adapt
Existing tools worth stealing from: Blockbuster Engine (datapack, actors with custom skins, recorded
movement playback), ImmersiveCinematics (JSON-defined camera cutscenes, Forge/Fabric), Replay Mod
(offline rendering to video with FFmpeg), Carpet mod fake players, Citizens NPC plugin.
Recommendation: do not adopt them wholesale. They are built for humans clicking in-game editors and
carry far more surface area than this needs. Instead, write one small purpose-built server plugin
(Paper/Fabric) that exposes exactly the primitives the planner needs, and borrow Replay Mod only for the
final render step if it proves easier than a custom recorder. Simpler surface = the AI can drive it reliably.
Required primitives (the plugin's API)
Primitive What it does
spawn_actor(id, skin, x, y, z, yaw, pitch) Creates a fake player with a skin. Fake players, not real clients, so dozens can
exist.
keyframe(actor, tick, x, y, z, yaw, pitch,
anim)
Schedules a position/orientation/animation target. The plugin interpolates
between keyframes at the actor's movement speed. anim: idle, walk, sprint,
sneak, swing, crouch, look_at(entity), hold(item), hurt, death.
set_world_state(tick, …) Time of day, weather, block placements/removals, spawn/despawn mobs, item
drops, explosions. Lets the story change the set mid-scene.
camera_shot(id, start_tick, end_tick,
path, fov)
Drives a spectator-mode camera entity. Path types: static, dolly(from, to),
orbit(target, radius, degrees), follow(actor, offset), crane. Easing on all paths.
record(shot_id, start_tick, end_tick) Starts/stops capture of the camera entity's view to a clip file named by shot id.
Records at a fixed tick rate so clips are frame-accurate.
load_set(name) / build_set(spec) Loads a saved structure or world region, or places a described structure before
the scene starts.
clock: play / pause / seek(tick) The master clock all of the above is scheduled against. Allows re-shooting a
single shot without re-running the scene.
log Every scheduled event emits the actual tick it fired on. This log is what
assembly syncs audio to.
Timing model
The planner never guesses durations. It uses a small table of known speeds (walking 4.3 blocks/s,
sprinting 5.6, sneaking 1.3, swimming, climbing, falling) and the tick rate to compute how many ticks a
keyframe move takes. If a line of dialogue is 3.2 seconds, the shot covering it is at least 64 ticks. The
plugin enforces the same speeds, so planned ticks and real ticks agree.
Recording
Two viable approaches, decide during the prototype: (a) a dedicated headless render client in spectator
mode that follows the camera entity and captures frames at a fixed rate; (b) Replay Mod recording the
server and rendering camera paths offline. Option (a) is simpler to automate and keeps everything on one
clock. Rendering can run on the 3090 box as well; shooting and voice generation are not VRAM-heavy at
the same time.
6. Voice server on the 3090
A local HTTP server with an OpenAI-style /speech endpoint. Candidate models (all open weights, all fit in
24 GB): Qwen3-TTS (voice cloning plus voice design from a text description, which is what makes
named-character casting automatic), Voxtral TTS (strong 3-second cloning), Step Audio EditX (emotion
control), VoxCPM2. Pick one for v1; the server interface stays the same if the model changes. Exposed to
the orchestrator over the LAN or Tailscale. Must support: multiple voice profiles per job, an emotion/style
tag per line, saving and reloading voice references, and a crowd mode (render N layered takes with jitter).
7. Core data contracts
Abbreviated. The builder should treat these as the real API between stages.
story.json
{ "title", "logline", "tone", "setting": {"biome","time_of_day","style"},
"characters": [ {"id","name","role","personality",
"voice_desc","skin_desc"} ],
"scenes": [ {"id","summary","location","characters":[...],
"target_seconds"} ],
"music": {"mood_tags":[...], "tempo":"slow|mid|fast"} }
scene_N.json
{ "scene_id",
"beats": [ {"id","description"} ],
"lines": [ {"id","tick","character","text","emotion"} ],
"keyframes": [ {"actor","tick","x","y","z","yaw","pitch","anim"} ],
"world_events": [ {"tick","type", ...} ],
"shots": [ {"id","start_tick","end_tick","path":{...},"fov",
"covers_lines":[...]} ] }
timeline.json (global ticks, after offsetting each scene)
{ "tick_rate": 20, "scenes": [...], "cast": {...},
"music": {"track_id","in_sec","out_sec"},
"lines": [ {..., "wav", "duration_sec", "actual_tick"} ],
"shots": [ {..., "clip", "actual_start_tick"} ] }
edl.json
{ "fps": 30,
"video": [ {"clip","in_sec","out_sec"} ],
"audio": [ {"wav","at_sec","gain_db"} ],
"music": {"track","at_sec","duck_db":-12} }
8. Build order
Step Deliverable Done when
1 Server plugin: spawn_actor + keyframe + clock A JSON file makes two bots walk a path on cue, repeatably.
2 Camera entity + camera_shot paths A JSON shot list produces smooth dolly/orbit/follow moves.
3 Recorder Each shot in the list becomes its own clip file, frame-accurate.
4 TTS server on the 3090 POST a line + voice id, get a WAV. Stock voice bank built.
Step Deliverable Done when
5 Assembler timeline.json + clips + WAVs + a track -> final.mp4 with ducking.
6 Outline agent + scene agents A prompt produces valid story.json and scene_N.json that pass
the self-checks.
7 Orchestrator (Claude Code) One command runs 1-6 end to end. First full movie exists.
8 Hardening Re-shoot single shots, retry failed lines, cron it.
Steps 1-5 are plumbing and can be built and tested with hand-written JSON before any AI is involved. That
is deliberate: if the plumbing works from hand-written files, the AI only has to write the same files.
9. Out of scope for v1
- YouTube or any upload. The output is final.mp4 on disk.
- Generated music. Library selection only.
- Lip sync. Minecraft faces are static; audiences accept it.
- Real-player involvement. Everything is bots.
- Live/streaming. Batch only.
10. The one-sentence version for anyone who asks
It's an automated film studio where the AI writes the script and the shot list, Minecraft is the set and the
actors, a local GPU is the voice booth, Tabor's music is the soundtrack, and ffmpeg is the cutting room.
Type a prompt, get a movie
