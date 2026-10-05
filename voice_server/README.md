# mcmovie voice server

Local TTS over HTTP. The orchestrator POSTs each line with a voice profile id
and an emotion/delivery string and gets a WAV back. Runs on the 3090.

## Setup (done on this machine 2026-10-04)

```bash
cd voice_server
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# torch build that matches NVIDIA driver 550 (CUDA 12.4); the default wheel wants a newer driver
pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
```
Models (Qwen3-TTS VoiceDesign + Base, about 8 GB of VRAM together) download
from Hugging Face on first start.

## Run

```bash
MCMOVIE_TTS_BACKEND=qwen3tts .venv/bin/uvicorn server:app --host 127.0.0.1 --port 8880
.venv/bin/python build_bank.py      # designs every voice in bank.json once (saved under voices/)
```
Without the env var the server runs the mock backend (no GPU). The
unattended loop (`bin/mcauto.js`) starts the real server itself when it is
not answering. Point other machines at it with `MCMOVIE_TTS_URL`.

## The voice collection

- `bank.json`: 24 designed voices (5 narrators, 19 character types). Each is
  generated once from its text description and kept as a reference clip, so
  it sounds the same in every film. Add a line to bank.json and re-run
  build_bank.py to add a voice; no samples or licenses involved.
- Players get their own permanent made-up voices on first use
  (`config/player_voices.json` in the repo root).
- Any WAV can become a voice with `POST /v1/voices/clone` (use only
  recordings you have the right to use).

## API

| Endpoint | Body | Returns |
|---|---|---|
| `GET /v1/voices` | | profiles (stock + designed) |
| `POST /v1/voices/design` | `{id, description, language, sample_text}` | profile with `ref_audio` |
| `POST /v1/voices/clone?id=X&ref_text=...` | WAV bytes | profile |
| `POST /v1/audio/speech` | `{input, voice, instructions, speed, crowd:{takes,jitter_ms}}` | `audio/wav` |

Voice profiles live in `voices/<id>.json` + `<id>.wav` (the reference clip). A
designed character sounds identical in every line and every future video.

## Notes

- The Qwen3-TTS Python API (`generate_voice_design`, `create_voice_clone_prompt`,
  `generate_voice_clone`) is wrapped in `Qwen3TTSBackend`; if the package API
  differs in your installed version, that class is the only place to adjust.
- Emotion: the line's `emotion` + `delivery` strings are passed as `instruct`.
  Backends that cannot take instructions ignore it.
- Crowd mode layers N takes with timing jitter and detune.
