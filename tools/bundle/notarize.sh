#!/bin/bash
# Submit one file to Apple notarization and wait for the verdict (CI helper).
#
#   APPLE_ID=… APPLE_TEAM_ID=… APPLE_APP_PASSWORD=… tools/bundle/notarize.sh <file>
#
# Submits and polls here rather than using `notarytool submit --wait`, whose
# polling aborts on the first transient network error (e.g. NSURLError -1009/
# -1001 during a slow Apple queue); here a blip is just one failed poll.
# Exits 0 only on Accepted; on Invalid/Rejected it prints the notary log and
# exits 1.
set -euo pipefail
FILE="$1"
AUTH=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# a failed attempt can still leave output in $OUT, so track success explicitly
ok=0
for attempt in 1 2 3; do
  if xcrun notarytool submit "$FILE" "${AUTH[@]}" --output-format json > "$OUT"; then
    ok=1
    break
  fi
  [ "$attempt" -lt 3 ] && { echo "submit attempt $attempt failed — retrying in 30 s"; sleep 30; }
done
[ "$ok" = 1 ] || { echo "ERROR: all submit attempts failed"; exit 1; }
SUB_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$OUT")
echo "submission id: $SUB_ID ($FILE)"

STATUS=Unknown
for i in $(seq 1 360); do              # ≤3 h, 30 s apart
  sleep 30
  STATUS=$( { xcrun notarytool info "$SUB_ID" "${AUTH[@]}" --output-format json \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','Unknown'))"; \
    } 2>/dev/null || echo TransientError)
  echo "[$i/360] $STATUS"
  case "$STATUS" in
    Accepted) exit 0 ;;
    Invalid|Rejected)
      xcrun notarytool log "$SUB_ID" "${AUTH[@]}"
      exit 1 ;;
  esac
done
echo "never Accepted within 3 h"
exit 1
