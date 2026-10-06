# For Tabor: Max's short-form movie pipeline revision

Baseline: `99c16be3c19daa1f0bfb9ea6abd9a946ce02237d`. This pass changes recorded-match-to-MP4 processing. It does not change the live server, run the production loop, or publish a video.

## The review film

`projects/match-20261005-025855/doc.json` is **Thanks for the High Ground**: actual head-start/noob chat, a tower trap, the high-ground reversal, and the landing payoff. Seven scenes contain twelve shots and seven spoken lines. The approved outro and licensed Kevin MacLeod library remain. Action has room to play without kit-description filler.

This sample was authored and checked against its recording here. The production Claude planner was unavailable and was not run. Its prompt and context have been improved for subsequent unattended films; this single test does not establish story quality across future matches.

## Replay, identities, and cameras

- `evidence.js`, `recording.js`, and `build.js`: discrete damage/swing impulses, recorded death ticks and ground state, shortest-path recorded rotation, no early teleports or invented sprint jumps. Slow motion does not repeat a hit on adjacent output ticks.
- Separate transport identities (`FilmActorN`) and film-only `name<kit>` labels. No leading dot or platform suffix in labels. Same-name Java/Bedrock accounts remain distinct internally; a Bedrock identity does not borrow a Java skin.
- Known Java skins are set without the asynchronous clear/set race and verified against the applied texture before filming. A mismatch stops the take. Unrecorded Bedrock skins still use the game's default; name lookup cannot recover historical skins.
- The **studio-only** helper `lib/studio/labels/FilmLabels.java` mounts labels on actors so client interpolation moves them together. It reattaches after teleports and hides labels for invisible/dead actors. It automatically compiles into `studio/plugins/FilmLabels.jar` and needs `javac`/`jar` beside the configured studio Java. Do not install it on the live server.
- The helper plays recorded hurt effects without applying another hit. Replay actors are protected from ambient damage, mobs do not resume autonomous combat, and leaving recording range is not treated as death. Only recorded deaths trigger the death action. Independent burning, ignition, and explosion block destruction are suppressed; explicit recorded changes control terrain.
- Kit effects clear before terrain restoration. Every scene restores all known changed blocks; planning and ground correction use its terrain instead of the final map.
- Cameras check loaded terrain, partial blocks, foliage, lens clearance, and sampled player bodies. Obstructions force immediate retreat with slower outward recovery. Heading smoothing handles head twitches and angle wrap. A tight space can still require an abrupt avoidance correction.
- The real client has one fixed lens per take. Camera distance now compensates for planned narrower lenses, preserving subject size instead of producing unexpectedly wide shots. This is distance adjustment, not optical zoom. Automatic scoring penalizes tiny players, prefers close/medium coverage, and shortens portal establishing views. The sample also explicitly directs faces, reactions, tower, teleport, and impact.

## Story, captions, voices, and sound

- Recorded matches now default to vertical short-form regardless of match duration. `import --format long` remains available; automation can explicitly set `match_format: "long"`, or `"auto"` for its previous duration-based selection. Existing projects retain their stored format. No production loop was run.
- Complete chat pages contain 40 lines with three-line overlap and a chronological index. The digest retains spread-out excerpts. Relevant complete conversations supply setup/reply/payoff without adding another LLM call.
- Both manual and unattended planner prompts require grounded causal stories, meaningful side stories when supported, actual dialogue for chat-driven hooks, and machinima coverage. They reject padding, repeated kit names, inventory recitation, invented motives, and generic commentary. Natural Gen Z phrasing/humor is welcome when earned. No new like/subscribe request.
- Removed contradictory legacy directions to invent player reactions, fill side-story quotas, and speed up uneventful travel. Match validation now requires player speech to identify a real speaker and exactly match recorded chat. Narrator jokes remain available; fabricated player quotes do not.
- A deterministic proofreading gate catches common typos, repeated words, and American-English "math"; usernames and literal chat remain protected. It is not a comprehensive grammar engine. The planner must still reread its script.
- Proportional caption timing prevents short lines from silently losing their final words. Captions preserve written usernames and original chat. Speech alone expands chat shorthand and applies aliases: DreamyArl0 -> Dreamy Arlo; maxc153 -> maxc; 42wizards -> forty-two wizards. Meaningful numbers such as Player2, Agent47, and R2D2 remain. Ambiguous names still need pronunciation overrides.
- **The new review uses real Qwen3-TTS, not mock/eSpeak speech.** VoiceDesign and Base ran locally on Max's RTX 4080 SUPER for this authorized test. The narrator was designed locally; the player's voice uses the description in the copied registry. These are not claimed to be identical to Tabor's saved voice references.
- In-game `/movie voice` selections retain priority. Changing a choice now replaces a previously chosen cached cast voice. A real voice run refuses a server reporting its mock backend. Speech caches include pronunciation, text, voice, delivery, and backend mode.
- Copied voice profiles can resolve an unavailable machine-specific reference path to a sibling `<voice-id>.wav`. Qwen Base receives style instructions only when the installed API explicitly supports them, fixing the actual generation failure. Otherwise Base preserves the voice reference without arbitrary per-line style control.
- Weather/ambience, game sound, and music are quieter beneath speech. Removed compressor/limiter automatic gain that could raise weather again. Dialogue receives 4 dB after levelling to sit closer to the approved outro. Music credits remain in edit data. The commercial finale song was not supplied or downloaded.

## Recorder wishes: small, targeted additions

1. Save participant UUID and skin texture properties once per match, including Bedrock identities. Snapshot voice/profile choices and movie preferences at match time; current preferences can differ.
2. Record body yaw separately from head yaw/pitch when it changes meaningfully. Keep dense combat/jump/teleport sampling and add sharp direction changes; do not raise sampling for stationary players.
3. Record successful damage after cancellation/modification: tick, victim/source IDs, cause, final damage, post-hit health, and death. Deduplicate generic/combat callbacks. A recent hurt flag is not a repeating event.
4. Distinguish death from leaving tracking range. Record mob spawn/despawn/death reason, owner once, and actual attack targets. Replay AI must not guess whether a wolf was hit.
5. Supply an initial map plus ordered before/after changes, or a final map with complete reversible changes. Include fire, explosions, fluids, pistons, growth/decay, and kit resets. Coalesce duplicate writes per tick, retaining first-before and last-after. Missing fire history cannot be reconstructed from a burnt final map.
6. Preserve all chat with authoritative speaker ID and tick. It is cheap and often supplies the story. Apply film opt-outs before sharing context.

## Handoff and remaining limits

- Exact Tabor voice reproduction later needs relevant `movie-prefs.json` data plus saved `voice_server/voices/*.json` and reference WAVs. No machine access/passwords are required. Force affected speech lines after replacing remote reference audio: the client cache does not hash remote WAV contents.
- Only the supplied two-player Stomper/Endermage recording exists here. Dogs/fire/Romeo-and-Juliet cases cannot be visually verified. Missing historical skins, exact poses between sparse samples, and unrecorded block history need a future recorded benchmark.
- Optional `graphics_backend: "wsl-d3d12"` supports Max's Windows GPU. Production defaults stay VirtualGL. The temporary capture override is removed after filming and excluded from the handoff. Local downloaded models/Python setup are not production dependency changes.
- Reimport a working recording copy, copy the supplied doc.json and format.json into its project, then use build/voice/make with the real voice service and `--keep-recording`. Never give make the only recording copy. Stop at the MP4. Do not copy generated recording.txt between machines; reimport recreates that local path.
- No additional paid model passes, no global recording-rate increase, no remote production access. Voices stay cached; the helper only recompiles when changed. Camera checks use scene actors and loaded blocks.

## Validation

- All 29 existing checks pass after updating obsolete expectations for early teleport/swing guesses.
- Replay regression checks cover impulse timing, identities, camera collision/recovery and actor clearance, angle wrap, lens/portrait framing, all chat pages, spoken-name/caption separation, proofreading, and caption completeness.
- Voice regressions reject a silently mocked server and verify changed in-game selections override old choices.
- Real Qwen generated seven lines with zero failures. A local recognition audit recovered narration and the warning/question; its reading of the opening AFK acronym varied. This is supporting evidence, not a perfect pronunciation oracle.
- Delivery QA includes full video decode, missing-clip/voice checks, caption comparison, black/freeze checks, loudness measurements, and visual review of close-ups, teleport, landing, labels, and captions. The delivery notes contain final measured results.
