# max.md: context for Max's agent

You are working in Max's copy of this repo. Read this before CLAUDE.md. Where
the two disagree, this file wins: CLAUDE.md describes Tabor's production box,
and most of what it says about servers, uploading and the unattended loop does
not exist here.

## From Tabor

This repo is wired to a real Minecraft server and website, hardcorepvp.com,
and on my machine it runs on its own GPU box that also does the voices. A lot
of it is hardwired to that production setup.

My friend Max is getting the folder because he wants to edit and play with
the video side: how a recorded match becomes a film. He is doing that on his
own device, isolated from production. So there will be things in here that
do nothing for you, and small edges to file down before the part that
matters runs on his machine. Do that filing, and no more.

When he hands it back I will make small changes to fit it into my pipeline
again. So please do not add a pile of unrelated things. Stay inside video
generation and handling.

I have included the real data of a match from the live server. Use it as if
it had just come from the real server, do everything Max asks, and stop once
the MP4 is rendered. That is the point where my side would upload to
YouTube. You never upload.

Max is only working on the stretch from the raw Minecraft data, to what
Claude is given to plan the film, to the final render.

If, while changing the pipeline, you find that the live server should be
recording something it does not record today (or records in a way the replay
cannot use), write it down in `FOR_TABOR.md`. That list is for me: what I
could track on the live server so the next films come out better with the
changes you two made.

With Max: be less technical. Do what he says thoroughly, let him be
creative, and help him get what he wants on screen. I will deal with the
technical side when it comes back.

For the other half of the picture, read the server's repo:
https://github.com/taborgreat/hardcorekits. It has the custom server, every
kit and its logic, and the recorder (`record/MatchRecorder.java`) that writes
the event log these films are made from.

Two things I am raising now because Max will run into them:

- **Voices.** The voices come from a TTS server on my GPU. Max does not have
  it. Tell him plainly: he can keep the lines as text with placeholder audio
  and know the real voices will be there when he hands it back, or you can
  help him set TTS up on his own GPU if he wants that.
- **Music.** My library is the free Kevin MacLeod tracks, plus one song for
  the final fight. New music changes these films a lot, so tell Max that
  adding songs may matter as much as any change to how the film is put
  together. He is free to do it.

Everything after this is Max. Tabor out. Good luck.

## What is in this copy

| | |
|---|---|
| `sample/last-match/recording/` | A real match, exactly as the server's recorder wrote it: two players, 5 min 32 s, a Stomper and an Endermage, with the map it was played on (`region/`). |
| `sample/last-match/doc.example.json` | A finished narration plan for that match (the one Tabor's last test film used). A working example of what you write, and a quick way to get a first film. |
| `music/kevin_macleod/`, `music/music_manifest.json` | 24 tracks (CC BY 4.0, credit lines are in the manifest) tagged by mood. |
| `assets/outro/` | The outro clip every film ends on. Tabor approved it by eye. Leave it alone unless Max asks. |
| `setup/real-client/`, `tools/setup-real-client.sh` | What is needed to film in the real game (below). |
| `FOR_TABOR.md` | Your running notes for the hand-back. |

Not in this copy, on purpose:

- **The finale song.** It is a commercial track, so it is not in a public
  repo. With no song the films simply have no finale section (the last fight
  is shown as an ordinary scene). To switch the finale on, put any audio file
  in `music/finale/`. The cut is timed to the song's drop: set `drop_sec`
  under `"finale"` in `config/mix.json` to the second where Max's song hits
  (Tabor's was 9). Max may get the original from Tabor directly.
- **Credentials** (`config/publish.json`), the live server, the film loop's
  state. Nothing here can upload, and you should not try.

## Making a film from the sample match

One-time: `npm install` (README.md lists the system packages), then the
real-game setup in the next section.

```bash
# 1. a working copy of the recording. `make` DELETES the recording it is given
#    unless you pass --keep-recording, so never point it at sample/ itself.
mkdir -p recordings && cp -r sample/last-match/recording recordings/20261005-025855
export MCMOVIE_RECORDINGS=$PWD/recordings

# 2. read the match
node bin/mcmatch.js import latest      # -> projects/match-20261005-025855/digest.md and moments/

# 3. you write projects/match-20261005-025855/doc.json: the narration plan.
#    prompts/match.md is the brief; digest.md is the only thing you plan from.
#    (To see a film first: cp sample/last-match/doc.example.json projects/match-20261005-025855/doc.json)
node bin/mcmatch.js check match-20261005-025855

# 4. the film. Stop here: final.mp4 is the end of your part.
xvfb-run -a -s "-screen 0 1920x1080x24" \
  node bin/mcmatch.js make match-20261005-025855 --mock-voice --keep-recording
# -> projects/match-20261005-025855/final.mp4
```

- `--mock-voice` is the no-TTS mode Tabor mentions: placeholder audio stands
  in for each line and the captions still show the words. Drop the flag once
  Max has a voice server (`voice_server/README.md`; it needs about 8 GB of
  GPU memory and listens on `MCMOVIE_TTS_URL`, default `http://127.0.0.1:8880`).
- To redo one stage instead of everything: `build`, `voice`, `finish`
  (`node bin/mcmatch.js help`). Captions, music levels, the cards and the
  outro only need `node bin/mcmovie.js assemble <slug>`, no re-filming.
- `node test/run.js` should keep passing.
- If the sample recording ever goes missing: `git checkout sample/`.

## Filming in the real game

Tabor's films are shot in real Minecraft: the recorded match is replayed by
bots on a private copy of the game server and filmed by the actual game
client, so skins, name tags, items, hits, kit effects and sound are the
game's own. Tabor wants Max to have that, not the old stand-in renderer.

```bash
tools/setup-real-client.sh
```

It needs Linux with an NVIDIA graphics card, and it puts everything inside
this folder (no sudo, nothing system-wide): the game launcher, VirtualGL
(lets the game draw on the card with no monitor attached), the game itself
(about 1 GB from Mojang, no account needed), and the studio server with its
plugins, including the hardcorekits plugin in "studio mode" so kit abilities
are the plugin's real code. After it, the `make` command above films in the
real game with no extra flags. You can tell from the log: it says
`filmed N clips in the studio with the real client`.

Things worth knowing:

- This setup was checked once, from a clean clone on Tabor's machine (same
  kind of box: Ubuntu, NVIDIA). It has not been tried on any other hardware.
  If Max's machine is different, expect to adjust `lib/capture/client.js`
  (the display, the GPU bridge, the sound file, the screen grab); that file
  is the whole of the machine-specific part.
- No NVIDIA video encoder in ffmpeg? The script prints the two settings that
  move encoding to the CPU.
- A take that fails is retried three times and then stops with an error. It
  does not quietly switch renderers.
- **The old renderer** is still there for when the real game cannot run (a
  laptop, a Mac, a quick look at camera angles): add `--offline` to `make`.
  It draws the match itself, roughly: flat skins, drawn name tags, no kit
  effects, no game sound. Good for checking a cut, not for judging a film.
  Tell Max which one made the file he is watching.

## Where Max's ideas usually land

| He wants to change... | Look at |
|---|---|
| How the story is told, the narrator's voice and rules | `prompts/match.md` |
| What you are told about the match before you plan | `lib/match/digest.js`, `lib/match/insight.js` (they write digest.md and moments/) |
| Camera choices | `lib/match/autoshots.js` (automatic), `lib/camera.js` (the moves), `lib/capture/film.js` (keeping the subject in sight) |
| The last fight, slow motion, the song | `lib/match/finale.js`, `"finale"` in `config/mix.json` |
| How raw data becomes movement and events on screen | `lib/match/build.js` (cuts the replay), `lib/studio/perform.js` (plays it in the game) |
| Captions, sound levels, cards, the outro | `lib/assemble/`, `config/mix.json` |
| Music | drop files in `music/<mood>/` and run `node bin/mcmovie.js music:scan music`; moods are asked for per segment in doc.json |
| Length and shape (vertical Short or wide video) | `lib/formats.js`, `--format short|long` at import |

CLAUDE.md explains each of these in depth. Read its "Match mode" and
"Formats, music moods, voices" sections; skip "Publishing and the unattended
loop" except to know what not to run.

## Leave alone

- `bin/mcpublish.js`, `bin/mcauto.js`, `lib/publish/`, `lib/auto/`,
  `tools/start-films.sh`, `tools/stop-films.sh`: Tabor's upload and
  automation side. Do not run them and do not edit them.
- Staged stories (`bin/mcmovie.js new/shoot/...`, `server/`): Tabor has
  switched them off. Max's work is match films.
- File names, command names and the meaning of existing flags and settings.
  Tabor has to fit this back into production; add a setting rather than
  changing what an old one means.
- `/movie block` is a player's choice to stay out of films
  (`lib/prefs.js`). Never work around it.

## Handing it back

Keep `FOR_TABOR.md` current as you go, in plain words:

1. **Recorder wishes**: what the live server should start recording, and
   what film change needs it.
2. **What changed**: each change Max kept, the files it touched, and any new
   setting or new file.
3. **Loose ends**: anything half-done, anything that only works on Max's
   machine, any new music and where it came from (with its licence).

## Answers to Max's agent (2026-10-06)

Your list of what would make the test setup match production, answered in order. The
things you can fetch yourself are in this commit; the rest is explained.

1. **The actual voices.** Now in the repo: `voice_server/voices/` (39 designed voices,
   each a `.json` profile and its `.wav` reference) and `config/player_voices.json` (which
   voice each real player has; it was already tracked). The profiles store the audio path as
   it was on Tabor's machine; the voice server now falls back to the `.wav` beside the
   profile, so they work where you put them. You still need the voice server itself running
   on a GPU (`voice_server/README.md`): Qwen3-TTS through the `qwen-tts` package
   (0.1.1), models `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` and
   `Qwen/Qwen3-TTS-12Hz-1.7B-Base`, bf16 on `cuda:0`, about 8 GB of VRAM; torch
   2.6.0+cu124, transformers 4.57.3, fastapi 0.142.2, uvicorn 0.54.0 on Tabor's box
   (driver 550). Without it, `--mock-voice` as before.
2. **Players' choices.** Not sent, on purpose. Tabor's call: your work does not need them.
   `movie-prefs.json` is players' own opt-outs and stays on the live server. The
   `movie.voices` list (the bank voices a player can pick) is in the plugin's config in the
   public server repo: `src/main/resources/config.yml` in
   https://github.com/taborgreat/hardcorekits.
3. **How production runs.** Branch `main` of this repo; production is the commit that added
   this section (Tabor's box runs the working tree of `~/github/mcmovie` at that commit).
   The pipeline is started with `tools/start-films.sh`, which runs `node bin/mcauto.js run`
   in a tmux window; `node bin/mcauto.js status` shows its state. The planner is Claude Code
   headless: `claude -p --permission-mode acceptEdits --allowedTools Read Write Edit Glob Grep`
   (Claude Code 2.1.291, model not pinned, so Claude Code's current default), fed the
   prompts in `prompts/auto/` (`match_plan.md`, then `fix.md` with the checker's errors, up to
   3 rounds). Production's `config/auto.json` is just `{"publish": true, "idle_stories": false}`;
   every other setting is the default in `lib/auto/config.js`. `config/mix.json` is tracked
   as it runs.
4. **A complete production example.** Being straight about this: uploaded films are deleted
   from the machine once they are up (the "nothing lingers" rule), and until today the
   recordings were too, so no uploaded film still exists as a file with its inputs. The
   closest thing is in `sample/last-match/example/`: the `doc.json` the planner wrote for the
   sample recording, its `cast.json`, `plan.txt` (the planner's run, including the exact
   prompt it was given) and `film.txt` (the studio take and the export). The finished film
   itself is not in the repo (a 93 MB video does not belong in git): make it yourself from
   those exact inputs with the `make` command above, with the real client, and you have the
   same film Tabor's box produced. The same match as uploaded, from an earlier build of the
   pipeline, is YouTube #3: https://youtube.com/shorts/38Aab5aAgBo. Tabor watched the
   example render and kept it; treat it as "what the pipeline makes today", not as the best
   film it ever made.
5. **Deployment.** Push your work to a branch (or a fork), never to `main`; Tabor pulls it on
   his box, reads `FOR_TABOR.md`, merges, and restarts the loop
   (`tools/stop-films.sh && tools/start-films.sh`). Untouched on production, so do not depend
   on changing them: everything under `config/` except `kit_rules.json` and
   `pronunciations.json` (his `publish.json`, `auto.json`, `mix.json` values,
   `player_voices.json` entries), and the ignored folders `automation/`, `keep/`, `studio/`,
   `capture/`, `server/`. A test render that stops before uploading is exactly the `make`
   command in "Making a film from the sample match": `make` never uploads anywhere;
   publishing is a separate command (`bin/mcpublish.js`) that only the loop or a person runs.
