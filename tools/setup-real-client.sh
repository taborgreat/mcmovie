#!/usr/bin/env bash
# Set up real-Minecraft filming for match films on a fresh machine.
# Needs Linux with an NVIDIA card (what the pipeline was built on). Nothing is installed
# system-wide and nothing here uses sudo; everything lands inside this folder:
#   capture/   the game launcher (portablemc, in its own Python venv), VirtualGL (unpacked from
#              its .deb, it lets the game draw on the graphics card with no monitor), the
#              no-crosshair resource pack, and the game itself (downloaded from Mojang)
#   studio/    the private game server a recorded match is replayed on: the same Paper build
#              the live server runs, plus the plugins that let the 1.21.4 bots join, give
#              players their skins, and run the real kit abilities
# Safe to run again: it only fills in what is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
KIT=$ROOT/setup/real-client
VGL_VERSION=3.1.5
GAME_VERSION=26.2

say () { printf '\n== %s\n' "$*"; }

say "checking what this machine has"
missing=()
for c in python3 node ffmpeg ffprobe Xvfb curl; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if ((${#missing[@]})); then
  echo "Missing programs: ${missing[*]}"
  echo "On Ubuntu or Debian:  sudo apt install python3-venv nodejs ffmpeg xvfb curl"
  exit 1
fi
python3 -c 'import venv, ensurepip' 2>/dev/null || { echo "Python's venv module is missing. On Ubuntu or Debian:  sudo apt install python3-venv"; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "This setup is for Linux. See max.md, \"Filming in the real game\"."; exit 1; }
[ -d node_modules ] || { echo "Run  npm install  first (see README.md, Requirements)."; exit 1; }

say "the game launcher (capture/.venv)"
if [ ! -x capture/.venv/bin/portablemc ]; then
  python3 -m venv capture/.venv
  capture/.venv/bin/pip install -q --upgrade pip
  capture/.venv/bin/pip install -q portablemc==4.4.1 python-xlib==0.33
fi
capture/.venv/bin/portablemc --version 2>/dev/null || true

say "VirtualGL $VGL_VERSION (capture/vgl)"
if [ ! -f capture/vgl/usr/lib/libvglfaker.so ]; then
  case "$(uname -m)" in
    x86_64) deb=virtualgl_${VGL_VERSION}_amd64.deb ;;
    aarch64) deb=virtualgl_${VGL_VERSION}_arm64.deb ;;
    *) echo "No VirtualGL package for $(uname -m)"; exit 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fL --retry 3 -o "$tmp/$deb" "https://github.com/VirtualGL/virtualgl/releases/download/$VGL_VERSION/$deb"
  mkdir -p capture/vgl
  if command -v dpkg-deb >/dev/null 2>&1; then dpkg-deb -x "$tmp/$deb" capture/vgl
  else (cd "$tmp" && ar x "$deb" && tar -xf data.tar.* -C "$ROOT/capture/vgl"); fi
  rm -rf "$tmp"
fi
[ -f capture/vgl/usr/lib/libvglfaker.so ] || { echo "VirtualGL did not unpack where expected (capture/vgl/usr/lib/libvglfaker.so)"; exit 1; }
echo ok

say "the no-crosshair resource pack (capture/work/resourcepacks/mcmovie)"
mkdir -p capture/work/resourcepacks
[ -d capture/work/resourcepacks/mcmovie ] || cp -r "$KIT/resourcepack/mcmovie" capture/work/resourcepacks/
echo ok

say "the studio server (studio/)"
mkdir -p studio/plugins
[ -f studio/paper.jar ] || cp "$KIT/paper.jar" studio/paper.jar
for j in "$KIT"/plugins/*.jar; do [ -f "studio/plugins/$(basename "$j")" ] || cp "$j" studio/plugins/; done
node -e "require('./lib/studio/server').setup()"
echo ok

say "the game itself, Minecraft $GAME_VERSION (capture/mc; about 1 GB the first time)"
capture/.venv/bin/portablemc --main-dir capture/mc --work-dir capture/work --output human start --dry "$GAME_VERSION" -u Lens

say "first start of the studio server (it unpacks itself and makes its world; a minute or two)"
node -e "require('./lib/studio/server').firstBoot().then(made => { console.log(made ? 'ok' : 'already done'); process.exit(0) }).catch(e => { console.error(String(e.message || e)); process.exit(1) })"

say "graphics card"
if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
else echo "nvidia-smi not found: the game draws through the NVIDIA driver (VirtualGL's EGL backend). Without an NVIDIA card this will not film; see max.md."; fi
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then echo "ffmpeg has the card's video encoder (h264_nvenc)"
else
  echo "ffmpeg has no h264_nvenc: tell the pipeline to encode on the CPU instead by creating"
  echo '  config/capture.json   {"encoder": "libx264"}'
  echo '  and adding to config/mix.json   "video_encoder": "libx264"'
fi

say "done"
cat <<'NEXT'
Film the sample match in the real game (see max.md for the whole walk-through):

  mkdir -p recordings && cp -r sample/last-match/recording recordings/20261005-025855
  export MCMOVIE_RECORDINGS=$PWD/recordings
  node bin/mcmatch.js import latest
  cp sample/last-match/doc.example.json projects/match-20261005-025855/doc.json
  xvfb-run -a -s "-screen 0 1920x1080x24" node bin/mcmatch.js make match-20261005-025855 --mock-voice --keep-recording

The first take is slower: the studio server unpacks itself and the game compiles its shaders.
NEXT
