#!/bin/bash
# Submit ONE file to Apple notarization and wait for the verdict (CI helper).
#
#   APPLE_ID=… APPLE_TEAM_ID=… APPLE_APP_PASSWORD=… tools/bundle/notarize.sh <file>
#
# NOT `notarytool submit --wait`: its internal polling aborts on the first
# transient network error (seen: NSURLError -1009/-1001 after 1¾ h of an
# Apple-side slow queue). Submit, take the id, poll ourselves — a blip is
# then just one failed poll among many. Exits 0 only on Accepted; on
# Invalid/Rejected it prints the notary log and exits 1.
set -euo pipefail
FILE="$1"
OUT=$(mktemp)

for attempt in 1 2 3; do
  xcrun notarytool submit "$FILE" \
    --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --output-format json > "$OUT" && break
  echo "submit attempt $attempt failed — retrying in 30 s"
  sleep 30
done
SUB_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$OUT")
echo "submission id: $SUB_ID ($FILE)"

STATUS=Unknown
for i in $(seq 1 360); do              # ≤3 h, 30 s apart
  sleep 30
  STATUS=$( { xcrun notarytool info "$SUB_ID" \
      --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_PASSWORD" --output-format json \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','Unknown'))"; \
    } 2>/dev/null || echo TransientError)
  echo "[$i/360] $STATUS"
  case "$STATUS" in
    Accepted) exit 0 ;;
    Invalid|Rejected)
      xcrun notarytool log "$SUB_ID" \
        --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
        --password "$APPLE_APP_PASSWORD"
      exit 1 ;;
  esac
done
echo "never Accepted within 3 h"
exit 1
