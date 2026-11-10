#!/bin/bash
# Double-clickable starter for the microSAMPLER editor on Linux.
#
# Mirrors the macOS .command: starts the bridge with sudo (root is needed to
# claim the USB interface), opens the editor in your browser once the bridge is
# ready, and shows live output. Stop with Ctrl+C or by closing the window.
#
# Tip: some file managers open .sh files in a text editor instead of running
# them. Mark this file executable / "Allow launching" first, or run it from a
# terminal:   ./'microSAMPLER Editor Librarian.sh'

# If launched without a terminal (e.g. double-clicked), relaunch inside one so
# the sudo password prompt and the bridge output are actually visible.
if [ "${1:-}" != "--relaunched" ] && [ ! -t 0 ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  for T in x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty xterm; do
    command -v "$T" >/dev/null 2>&1 || continue
    case "$T" in
      gnome-terminal) exec "$T" -- bash "$SELF" --relaunched ;;
      *)              exec "$T" -e bash "$SELF" --relaunched ;;
    esac
  done
  # no terminal emulator found — fall through and hope sudo can prompt
fi

set -u
echo "── microSAMPLER Editor / Librarian ────────────────────────────────"

pause_exit() {                       # never vanish silently
  echo "ERROR: $1"
  read -r -p "Press Enter to close… " _
  exit 1
}

HERE="$(cd "$(dirname "$0")" && pwd)" || pause_exit "cannot resolve own path"
# Locate native-tools relative to this launcher. Works both from the packaged
# ZIP (launcher in macOS/ etc., native-tools at the ZIP root) and from a source
# checkout (launcher in src/launchers/<OS>/, native-tools in src/).
NT=""
for _c in "$HERE/../native-tools" "$HERE/../../native-tools"; do
  [ -f "$_c/bridge.py" ] && { NT="$(cd "$_c" && pwd)"; break; }
done
[ -n "$NT" ] || pause_exit "native-tools/ not found near the launcher"
ROOT="$(cd "$NT/.." && pwd)"
echo "repo:   $ROOT"
cd "$NT" || pause_exit "cannot enter native-tools/"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || pause_exit "python3 not found in PATH"
echo "python: $PY"

PORT=8765
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
  echo "Bridge already running — opening the editor."
  open_ui
  read -r -p "Press Enter to close… " _
  exit 0
fi

echo
echo "Starting the bridge — your password may be asked (root is needed to"
echo "claim the USB interface). The editor window opens by itself."
echo "Stop the bridge with Ctrl+C."
echo "────────────────────────────────────────────────────────────────"
# ask for the password first, so the window watcher's timeout below only
# covers the bridge starting up, not the time spent typing it
if ! sudo -v; then
  read -r -p "No admin password given — press Enter to close… " _
  exit 1
fi

# open the editor window as soon as the bridge starts listening (≤ 2 min)
(
  for _ in $(seq 1 480); do
    port_open && { open_ui; exit 0; }
    sleep 0.25
  done
) &
WATCHER=$!

sudo "$PY" bridge.py
RC=$?
kill "$WATCHER" 2>/dev/null
echo "────────────────────────────────────────────────────────────────"
echo "bridge exited (status $RC)"
read -r -p "Press Enter to close… " _
