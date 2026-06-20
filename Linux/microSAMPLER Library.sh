#!/bin/bash
# Double-clickable LIBRARY-mode starter for Linux — browse, play and export the
# samples in microSAMPLER bank backups (original Korg ".msmpl_bank" files, or
# this app's ".zip" backups) with NO hardware connected. No sudo: library mode
# never touches USB.
#
# Tip: some file managers open .sh files in a text editor instead of running
# them. Mark this file executable / "Allow launching" first, or run it from a
# terminal:   ./'Linux/microSAMPLER Library.sh'

# If launched without a terminal (double-clicked), relaunch inside one so the
# bridge output is visible.
if [ "${1:-}" != "--relaunched" ] && [ ! -t 0 ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  for T in x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty xterm; do
    command -v "$T" >/dev/null 2>&1 || continue
    case "$T" in
      gnome-terminal) exec "$T" -- bash "$SELF" --relaunched ;;
      *)              exec "$T" -e bash "$SELF" --relaunched ;;
    esac
  done
fi

set -u
echo "── microSAMPLER Library ───────────────────────────────────────────"

pause_exit() {
  echo "ERROR: $1"
  read -r -p "Press Enter to close… " _
  exit 1
}

HERE="$(cd "$(dirname "$0")" && pwd)" || pause_exit "cannot resolve own path"
ROOT="$(cd "$HERE/.." && pwd)"       # app folder (this launcher lives in Linux/)
echo "repo:   $ROOT"
cd "$ROOT/native-tools" || pause_exit "native-tools/ not found next to the app"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || pause_exit "python3 not found in PATH"
echo "python: $PY"

PORT=8766                 # library mode's own port (the device bridge uses 8765)
URL="http://localhost:$PORT"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
open_ui() {
  for B in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
    if command -v "$B" >/dev/null 2>&1; then
      "$B" --app="$URL" >/dev/null 2>&1 &
      return
    fi
  done
  xdg-open "$URL" >/dev/null 2>&1 &
}

if port_open; then
  echo "Library bridge already running — opening it."
  open_ui
  read -r -p "Press Enter to close… " _
  exit 0
fi

(
  for _ in $(seq 1 240); do
    port_open && { open_ui; exit 0; }
    sleep 0.25
  done
) &
WATCHER=$!

echo
echo "Starting LIBRARY mode (no device, no password). The window opens by itself."
echo "Stop with Ctrl+C."
echo "────────────────────────────────────────────────────────────────"
"$PY" bridge.py --library --port "$PORT"
RC=$?
kill "$WATCHER" 2>/dev/null
echo "────────────────────────────────────────────────────────────────"
echo "bridge exited (status $RC)"
read -r -p "Press Enter to close… " _
