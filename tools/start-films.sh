#!/bin/sh
# Starts the film loop (bin/mcauto.js) in a tmux window called "films", next to the game
# server's "hg" window. Safe to run twice: it does nothing if the window already exists.
#
#   tools/start-films.sh                # start the loop
#   tools/start-films.sh --story-first  # start it and make a story before anything else
#   tmux select-window -t films         # look at it
#   tools/stop-films.sh                 # stop it (a job in progress is abandoned)
#
# To start it at boot, add to the user crontab after the game server's line:
#   @reboot sleep 60 && /home/tabor/github/mcmovie/tools/start-films.sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmux=/usr/bin/tmux
window=films
node_bin="${NODE:-$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1)}"
java_dir="${JAVA_DIR:-$HOME/.jdks/jdk-25.0.4.1+1/bin}"
[ -x "$node_bin" ] || { echo "start-films: no node found (nvm)" >&2; exit 1; }

if $tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -qx "$window"; then
    echo "already running in tmux window $window"
    exit 0
fi

# The loop needs node, java (set server), claude (planning), xvfb-run and ffmpeg on PATH.
path="$(dirname "$node_bin"):$java_dir:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cmd="PATH='$path' '$node_bin' bin/mcauto.js run $* 2>&1 | tee -a automation/loop.log"

mkdir -p "$repo/automation"
if $tmux list-sessions >/dev/null 2>&1; then
    session=$($tmux list-sessions -F '#{session_attached} #{session_name}' | sort -rn | head -n 1 | cut -d' ' -f2-)
    $tmux new-window -d -t "$session:" -n "$window" -c "$repo" "$cmd"
else
    $tmux new-session -d -n "$window" -x 200 -y 50 -c "$repo" "$cmd"
fi
$tmux set-option -w -t "$window" remain-on-exit on 2>/dev/null || true
echo "film loop started in tmux window $window (log: automation/loop.log)"
