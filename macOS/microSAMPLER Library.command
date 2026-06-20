#!/bin/bash
# Double-clickable LIBRARY-mode starter (macOS) — browse, play and export the
# samples in microSAMPLER bank backups (the original Korg ".msmpl_bank" files,
# or this app's own ".zip" backups) with NO hardware connected. No password
# needed: library mode never touches USB, so it doesn't run as root.

echo "── microSAMPLER Library ───────────────────────────────────────────"

pause_exit() {
  echo "ERROR: $1"
  read -r -p "Press Return to close… " _
  exit 1
}

HERE="$(cd "$(dirname "$0")" && pwd)" || pause_exit "cannot resolve own path"
ROOT="$(cd "$HERE/.." && pwd)"       # app folder (this launcher lives in macOS/)
echo "repo:   $ROOT"
# clear the macOS download-quarantine flag so the bundled files load cleanly
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
cd "$ROOT/native-tools" || pause_exit "native-tools/ not found next to the app"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || pause_exit "python3 not found in PATH"
echo "python: $PY"

PORT=8766                 # library mode has its own port — never collides with
URL="http://localhost:$PORT"   # a device bridge on 8765
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
open_ui() { open -na "Google Chrome" --args --app="$URL" 2>/dev/null || open "$URL"; }

if port_open; then
  echo "Bridge already running — opening the library."
  open_ui
  echo "(close this window)"
  exit 0
fi

(
  for _ in $(seq 1 240); do
    if port_open; then open_ui; exit 0; fi
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
read -r -p "Press Return to close… " _
