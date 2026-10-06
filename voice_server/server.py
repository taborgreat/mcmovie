"""
mcmovie voice server - local TTS over HTTP for the 3090 box.

OpenAI-style endpoints the orchestrator uses:
  GET  /v1/voices                      list voice profiles
  POST /v1/voices/design               {id, description, language, sample_text} -> design a voice, save reference
  POST /v1/voices/clone?id=..&ref_text=..   body: WAV bytes -> save as reference
  POST /v1/audio/speech                {input, voice, instructions, response_format, speed, crowd} -> WAV
  GET  /health

Backends:
  mock     no GPU, espeak-ng if installed, else tone patterns (for pipeline tests)
  qwen3tts Qwen3-TTS (voice design + cloning, open weights, fits in 24 GB)

Run:  MCMOVIE_TTS_BACKEND=qwen3tts uvicorn server:app --host 0.0.0.0 --port 8880
      (default backend is mock)
"""
import io
import inspect
import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
VOICES_DIR = Path(os.environ.get("MCMOVIE_VOICES_DIR", HERE / "voices"))
VOICES_DIR.mkdir(parents=True, exist_ok=True)
BANK = json.loads((HERE / "bank.json").read_text())
BACKEND_NAME = os.environ.get("MCMOVIE_TTS_BACKEND", "mock")
SR = 24000

app = FastAPI(title="mcmovie voice server")
_lock = threading.Lock()


# ---------------------------------------------------------------- profiles
def profile_path(vid: str) -> Path:
    return VOICES_DIR / f"{vid}.json"


def load_profile(vid: str):
    p = profile_path(vid)
    if p.exists():
        prof = json.loads(p.read_text())
        # A copied voice folder must not retain Tabor's machine-specific paths.
        # Prefer the bundled reference when the old absolute path is unavailable.
        ref = prof.get("ref_audio")
        if ref and not Path(ref).is_file():
            local_ref = VOICES_DIR / f"{vid}.wav"
            if local_ref.is_file():
                prof["ref_audio"] = str(local_ref)
        return prof
    if vid in BANK["voices"]:
        # stock voice not built yet: describe it so backends can design on the fly
        return {"id": vid, "description": BANK["voices"][vid], "language": BANK.get("language", "en"), "ref_audio": None, "ref_text": None, "stock": True}
    return None


def save_profile(prof: dict):
    profile_path(prof["id"]).write_text(json.dumps(prof, indent=2))
    return prof


# ---------------------------------------------------------------- backends
class MockBackend:
    name = "mock"

    def __init__(self):
        self.espeak = shutil.which("espeak-ng")

    def design(self, prof: dict, sample_text: str):
        wav = self.speak(sample_text, prof, "")
        ref = VOICES_DIR / f"{prof['id']}.wav"
        sf.write(ref, wav, SR)
        prof["ref_audio"] = str(ref)
        prof["ref_text"] = sample_text
        return prof

    def speak(self, text: str, prof: dict, instructions: str, speed: float = 1.0) -> np.ndarray:
        desc = (prof.get("description") or prof.get("id") or "").lower()
        if self.espeak:
            voice = "en+f3" if any(w in desc for w in ("woman", "female", "girl", "kid", "child")) else "en+m3"
            pitch = 70 if "child" in desc or "kid" in desc else (30 if any(w in desc for w in ("old", "gruff", "deep")) else 50)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                out = f.name
            subprocess.run([self.espeak, "-v", voice, "-p", str(pitch), "-s", str(int(165 * speed)), "-w", out, text], check=True)
            data, sr = sf.read(out, dtype="float32")
            os.unlink(out)
            if sr != SR:
                idx = np.linspace(0, len(data) - 1, int(len(data) * SR / sr)).astype(int)
                data = data[idx]
            return data
        # tone pattern: one beep per word
        words = max(1, len(text.split()))
        sec = max(0.6, words / 2.6 + 0.35)
        freq = 520 if any(w in desc for w in ("woman", "female")) else (700 if "child" in desc else 260)
        t = np.arange(int(sec * SR)) / SR
        per = sec / words
        env = ((t % per) < per * 0.6).astype(np.float32)
        return (0.25 * np.sin(2 * np.pi * freq * t) * env).astype(np.float32)


class Qwen3TTSBackend:
    """Qwen3-TTS via the `qwen_tts` package. Two models: VoiceDesign (text -> voice) and
    Base (voice clone from a reference). Check the package README if the API moved."""
    name = "qwen3tts"

    def __init__(self):
        import torch  # noqa
        from qwen_tts import Qwen3TTSModel  # type: ignore
        self.torch = torch
        design_id = os.environ.get("MCMOVIE_QWEN_DESIGN", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
        clone_id = os.environ.get("MCMOVIE_QWEN_CLONE", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        kw = dict(device_map="cuda:0", dtype=torch.bfloat16)
        self.design_model = Qwen3TTSModel.from_pretrained(design_id, **kw)
        self.clone_model = Qwen3TTSModel.from_pretrained(clone_id, **kw)
        self.prompt_cache = {}

    def design(self, prof: dict, sample_text: str):
        lang = _lang(prof.get("language"))
        wavs, sr = self.design_model.generate_voice_design(text=sample_text, language=lang, instruct=prof["description"])
        ref = VOICES_DIR / f"{prof['id']}.wav"
        sf.write(ref, wavs[0], sr)
        prof["ref_audio"] = str(ref)
        prof["ref_text"] = sample_text
        return prof

    def speak(self, text: str, prof: dict, instructions: str, speed: float = 1.0) -> np.ndarray:
        lang = _lang(prof.get("language"))
        if not prof.get("ref_audio"):
            prof = self.design(prof, BANK.get("sample_text"))
            save_profile(prof)
        key = prof["id"]
        if key not in self.prompt_cache:
            ref = prof["ref_audio"]
            if not os.path.exists(ref):  # a profile made on another machine: the audio sits beside it
                beside = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices", os.path.basename(ref))
                if os.path.exists(beside):
                    ref = beside
            self.prompt_cache[key] = self.clone_model.create_voice_clone_prompt(ref_audio=ref, ref_text=prof.get("ref_text") or "")
        kwargs = dict(text=text, language=lang, voice_clone_prompt=self.prompt_cache[key])
        # Base cloning preserves the saved voice; released Qwen Base versions
        # do not all support per-line style instructions. Do not forward an
        # unsupported keyword into Transformers generation (it raises ValueError).
        if instructions and "instruct" in inspect.signature(self.clone_model.generate_voice_clone).parameters:
            kwargs["instruct"] = instructions
        wavs, sr = self.clone_model.generate_voice_clone(**kwargs)
        data = np.asarray(wavs[0], dtype=np.float32)
        if sr != SR:
            idx = np.linspace(0, len(data) - 1, int(len(data) * SR / sr)).astype(int)
            data = data[idx]
        return data


def _lang(code):
    return {"en": "English", "de": "German", "es": "Spanish", "fr": "French", "ja": "Japanese", "zh": "Chinese", None: "English"}.get(code, code or "English")


def make_backend():
    if BACKEND_NAME == "qwen3tts":
        return Qwen3TTSBackend()
    return MockBackend()


backend = make_backend()


# ---------------------------------------------------------------- helpers
def to_wav_bytes(data: np.ndarray, sr: int = SR) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def trim_silence(data: np.ndarray, thresh=0.01, pad=0.08):
    idx = np.where(np.abs(data) > thresh)[0]
    if len(idx) == 0:
        return data
    a = max(0, idx[0] - int(pad * SR))
    b = min(len(data), idx[-1] + int(pad * SR))
    return data[a:b]


def crowd_mix(text, prof, instructions, takes=6, jitter_ms=180, speed=1.0):
    """Several takes layered with random offsets and detune -> murmur/yell."""
    rng = np.random.default_rng(abs(hash(text)) % (2**32))
    layers = []
    for i in range(takes):
        layer_prof = dict(prof)
        layer_prof["id"] = f"crowd_{i}" if BACKEND_NAME == "mock" else prof["id"]
        w = backend.speak(text, layer_prof, instructions, speed=speed * float(rng.uniform(0.92, 1.08)))
        # cheap detune by resampling
        f = float(rng.uniform(0.9, 1.12))
        idx = np.clip((np.arange(int(len(w) / f)) * f).astype(int), 0, len(w) - 1)
        w = w[idx]
        off = int(rng.uniform(0, jitter_ms / 1000) * SR)
        layers.append((off, w))
    n = max(o + len(w) for o, w in layers)
    out = np.zeros(n, dtype=np.float32)
    for o, w in layers:
        out[o:o + len(w)] += w / np.sqrt(takes)
    return np.clip(out, -1, 1)


# ---------------------------------------------------------------- API
class DesignReq(BaseModel):
    id: str
    description: str
    language: str | None = "en"
    sample_text: str | None = None


class CrowdOpts(BaseModel):
    takes: int = 6
    jitter_ms: int = 180


class SpeechReq(BaseModel):
    input: str
    voice: str = "adult_male"
    instructions: str | None = None
    response_format: str = "wav"
    speed: float = 1.0
    model: str | None = None
    crowd: CrowdOpts | None = None


@app.get("/health")
def health():
    return {"ok": True, "backend": backend.name}


@app.get("/v1/voices")
def list_voices():
    out = []
    seen = set()
    for p in sorted(VOICES_DIR.glob("*.json")):
        prof = json.loads(p.read_text())
        seen.add(prof["id"])
        out.append({"id": prof["id"], "description": prof.get("description"), "built": bool(prof.get("ref_audio"))})
    for vid, desc in BANK["voices"].items():
        if vid not in seen:
            out.append({"id": vid, "description": desc, "built": False, "stock": True})
    return {"backend": backend.name, "voices": out}


@app.post("/v1/voices/design")
def design_voice(req: DesignReq):
    prof = {"id": req.id, "description": req.description, "language": req.language or "en", "ref_audio": None, "ref_text": None}
    with _lock:
        prof = backend.design(prof, req.sample_text or BANK.get("sample_text"))
        save_profile(prof)
    return prof


@app.post("/v1/voices/clone")
async def clone_voice(request: Request, id: str, ref_text: str = "", language: str = "en"):
    body = await request.body()
    if not body:
        raise HTTPException(400, "WAV body required")
    ref = VOICES_DIR / f"{id}.wav"
    data, sr = sf.read(io.BytesIO(body), dtype="float32")
    sf.write(ref, data, sr)
    prof = {"id": id, "description": f"cloned from upload", "language": language, "ref_audio": str(ref), "ref_text": ref_text}
    save_profile(prof)
    return prof


@app.post("/v1/audio/speech")
def speech(req: SpeechReq):
    prof = load_profile(req.voice)
    if prof is None:
        raise HTTPException(404, f"unknown voice {req.voice}")
    instructions = req.instructions or ""
    with _lock:
        if req.crowd or req.voice == "crowd":
            c = req.crowd or CrowdOpts()
            data = crowd_mix(req.input, prof, instructions, takes=c.takes, jitter_ms=c.jitter_ms, speed=req.speed)
        else:
            data = trim_silence(backend.speak(req.input, prof, instructions, speed=req.speed))
        if prof.get("stock") and prof.get("ref_audio") and not profile_path(prof["id"]).exists():
            save_profile(prof)
    if req.response_format != "wav":
        raise HTTPException(400, "only wav is supported")
    return Response(content=to_wav_bytes(data), media_type="audio/wav")
