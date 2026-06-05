#!/usr/bin/env bash
# Serve the editor on http://localhost:8000 (Web MIDI needs a secure context).
# Open it in Chrome / Edge / Opera.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
echo "microSAMPLER Editor → http://localhost:$PORT  (Ctrl+C to stop)"
python3 -m http.server "$PORT"
