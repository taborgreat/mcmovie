"""Build the stock voice bank once: designs every voice in bank.json on the running server."""
import json
import sys
import urllib.request
from pathlib import Path

url = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8880").rstrip("/")
bank = json.loads((Path(__file__).parent / "bank.json").read_text())
for vid, desc in bank["voices"].items():
    body = json.dumps({"id": vid, "description": desc, "language": bank.get("language", "en"), "sample_text": bank.get("sample_text")}).encode()
    req = urllib.request.Request(url + "/v1/voices/design", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        print(vid, "->", json.loads(r.read())["ref_audio"])
