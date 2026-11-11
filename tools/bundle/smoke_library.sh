#!/bin/bash
# CI smoke test for a frozen Library bridge: start it headless, check that it
# serves the app in library mode on 8766, then stop it through the API.
#
#   MSMPL_NO_OPEN=1 tools/bundle/smoke_library.sh <frozen binary>
# grep reads the whole response (no -q): an early exit would make curl fail
# with a write error (23) under pipefail.
set -eo pipefail
"$1" &
for _ in $(seq 1 40); do
  curl -sf http://localhost:8766/api/status > /dev/null && break
  sleep 0.5
done
curl -sf http://localhost:8766/api/status | grep '"library": true' > /dev/null
curl -sf http://localhost:8766/app.html | grep microSAMPLER > /dev/null
curl -sf -X POST http://localhost:8766/api/shutdown | grep '"ok": true' > /dev/null
