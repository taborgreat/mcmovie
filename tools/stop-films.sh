#!/bin/sh
# Stops the film loop started by tools/start-films.sh and closes its tmux window.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pidfile="$repo/automation/daemon.pid"
if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
fi
# close the window by its exact address: with more than one tmux session, a bare name can
# fail to resolve and leave a dead window behind that blocks the next start
for w in $(/usr/bin/tmux list-windows -a -F '#{session_name}:#{window_index} #{window_name}' 2>/dev/null | awk '$2 == "films" { print $1 }'); do
    /usr/bin/tmux kill-window -t "$w" 2>/dev/null || true
done
echo "film loop stopped"
