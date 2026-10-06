# mcmovie

Type a prompt, get a Minecraft movie. The AI writes the story, dialogue,
blocking and shot list as JSON; bots act it out on a local Paper server; a
replay is rendered offline to clips; a local TTS server voices every line;
ffmpeg cuts it together with music from your library.

See `instructions.md` for the design spec and `CLAUDE.md` for how the LLM
operator drives it.

Working on a copy away from the production server (Max): start with `max.md`.
It has a recorded match to practise on (`sample/last-match/`) and the steps
to a first film.

## Requirements

- Node 20+, Java 21+ (Paper 1.21.4), ffmpeg/ffprobe
- Linux: `sudo apt install libxi-dev libxext-dev libglu1-mesa-dev python-is-python3 xvfb`
  (headless-gl build + a virtual display for rendering)
- Optional: a GPU box for `voice_server/` (Qwen3-TTS); otherwise `--mock-voice`

## Setup

```bash
npm install
node bin/mcmovie.js server:setup        # writes server/ config (Paper jar already in server/)
node bin/mcmovie.js music:scan ~/Music  # or music:mock for synthetic test tracks
node bin/mcmovie.js skins:sync --usercache ~/hgserver/usercache.json   # real player skins
```

## Run the demo

```bash
node bin/mcmovie.js validate demo
xvfb-run -a -s "-screen 0 1920x1080x24" node bin/mcmovie.js make demo --mock-voice
# -> projects/demo/final.mp4
```

The set server is started and stopped automatically by `shoot` if it is not
already running (`server:start` keeps one up between runs, faster).

## Filming in the real game

Films are shot by the real Minecraft client (`lib/capture/`, `lib/studio/`):
bots replay the scene on a private server and the game itself is recorded.
On a fresh Linux machine with an NVIDIA card:

```bash
tools/setup-real-client.sh    # launcher, VirtualGL, the game, the studio server; all inside this folder
```
`--offline` on `mcmatch make` uses the old built-in renderer instead (rough,
for checking cuts only). See `max.md` and CLAUDE.md, "Real client filming".

## Match mode

A real hardcorepvp match in, a vertical short-form film out by default. Use
`import --format long` to request a 3-5 minute landscape film. The plugin
(`~/github/hardcorekits`, `recording:` in its config.yml) records each match;
`bin/mcmatch.js` turns a recording into a film and deletes the recording
when the film is written.

```bash
node bin/mcmatch.js list
node bin/mcmatch.js import latest            # -> projects/match-<id>/digest.md
# the LLM reads digest.md and context/index.md plus relevant chat pages, then writes doc.json
xvfb-run -a -s "-screen 0 1920x1080x24" node bin/mcmatch.js make match-<id>
```

## Publishing and automation

```bash
cp config/publish.example.json config/publish.json   # YouTube OAuth client + Discord webhook
node bin/mcpublish.js auth                           # one-time YouTube consent
node bin/mcpublish.js <slug> --dry-run
node bin/mcauto.js run                               # the unattended loop (keep it in tmux)
```
The loop films every finished match as a vertical short by default,
uploads, posts to Discord, and after 8 idle hours stages a story from random
recent players and kits. `config/auto.json` can set `match_format` to `long`,
or `auto` for the old match-duration rule. See CLAUDE.md. Max's isolated
review workflow stops at the MP4 and does not run this publishing loop.

## Commands

Run `node bin/mcmovie.js help`.

## Layout

```
bin/mcmovie.js      CLI for staged movies (prompt -> story -> shoot)
bin/mcmatch.js      CLI for match mode (recorded match -> narrated film)
bin/mcpublish.js    YouTube upload + Discord post
bin/mcauto.js       unattended loop (matches, idle stories, publishing)
lib/                pipeline (see CLAUDE.md for the map)
prompts/            instructions for the planning stages + kits reference
projects/<slug>/    one movie: plan files, replays, clips, wavs, final.mp4
sets/               reusable structures (load op)
skins/              player skins (png) + players.json roster
music/              your library + music_manifest.json
server/             Paper set server (world is disposable)
voice_server/       TTS HTTP server for the GPU box
vendor/             node-canvas-webgl shim (canvas + headless-gl)
```
