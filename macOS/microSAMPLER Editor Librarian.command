#!/bin/bash
# Double-clickable starter for the microSAMPLER editor.
#
# Opens a Terminal window, starts the bridge with sudo (type your password
# here — same as the CLI flow), auto-opens the editor in a Chrome app-mode
# window once the bridge is ready, and shows live bridge output.
# Stop with Ctrl+C or by closing the window.

echo "── microSAMPLER Editor / Librarian ────────────────────────────────"

pause_exit() {                       # never vanish silently
  echo "ERROR: $1"
  read -r -p "Press Return to close… " _
  exit 1
}

HERE="$(cd "$(dirname "$0")" && pwd)" || pause_exit "cannot resolve own path"
ROOT="$(cd "$HERE/.." && pwd)"       # app folder (this launcher lives in macOS/)
echo "repo:   $ROOT"

# Clear the macOS "downloaded from the internet" quarantine flag on the whole
# app so Gatekeeper lets the bundled libusb library (native-tools/vendor/libusb/)
# load. Harmless if already clear (e.g. a git clone); needed once for a ZIP.
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true

cd "$ROOT/native-tools" || pause_exit "native-tools/ not found next to the app"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || pause_exit "python3 not found in PATH"
echo "python: $PY"

PORT=8765
URL="http://localhost:$PORT"

# bash-builtin port probe — macOS nc can hang on localhost/IPv6
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

open_ui() {
  open -na "Google Chrome" --args --app="$URL" 2>/dev/null || open "$URL"
}

if port_open; then
  echo "Bridge already running — opening the editor."
  open_ui
  echo "(close this window)"
  exit 0
fi

# open the editor window as soon as the bridge starts listening
(
  for _ in $(seq 1 240); do
    if port_open; then
      open_ui
      exit 0
    fi
    sleep 0.25
  done
) &
WATCHER=$!

echo
echo "Starting the bridge — your password may be asked (needed to claim"
echo "the USB interface from CoreMIDI). The editor window opens by itself."
echo "Stop the bridge with Ctrl+C."
echo "────────────────────────────────────────────────────────────────"
sudo "$PY" bridge.py
RC=$?
kill "$WATCHER" 2>/dev/null
echo "────────────────────────────────────────────────────────────────"
echo "bridge exited (status $RC)"
read -r -p "Press Return to close… " _
