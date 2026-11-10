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

# Clear the macOS "downloaded from the internet" quarantine flag on the whole
# app so Gatekeeper lets the bundled libusb library (native-tools/vendor/libusb/)
# load. Harmless if already clear (e.g. a git clone); needed once for a ZIP.
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true

cd "$NT" || pause_exit "cannot enter native-tools/"

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

echo
echo "Starting the bridge — your password may be asked (needed to claim"
echo "the USB interface from CoreMIDI). The editor window opens by itself."
echo "Stop the bridge with Ctrl+C."
echo "────────────────────────────────────────────────────────────────"
# ask for the password first, so the window watcher's timeout below only
# covers the bridge starting up, not the time spent typing it
if ! sudo -v; then
  read -r -p "No admin password given — press Return to close… " _
  exit 1
fi

# open the editor window as soon as the bridge starts listening (≤ 2 min)
(
  for _ in $(seq 1 480); do
    if port_open; then
      open_ui
      exit 0
    fi
    sleep 0.25
  done
) &
WATCHER=$!

sudo "$PY" bridge.py
RC=$?
kill "$WATCHER" 2>/dev/null
echo "────────────────────────────────────────────────────────────────"
echo "bridge exited (status $RC)"
read -r -p "Press Return to close… " _
