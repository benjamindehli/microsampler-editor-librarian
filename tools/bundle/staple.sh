#!/bin/bash
# Staple a notarization ticket, retrying transient network errors (CI helper).
#
#   tools/bundle/staple.sh <app-or-dmg> [...]
#
# stapler fetches the ticket from Apple's CloudKit; one dropped connection
# (seen: NSURLError -1005 "network connection was lost", stapler error 68)
# failed a whole release build AFTER notarization had already been Accepted.
# The ticket isn't going anywhere, so just ask again.
set -euo pipefail
for TARGET in "$@"; do
  for attempt in 1 2 3 4 5; do
    xcrun stapler staple "$TARGET" && continue 2
    echo "staple attempt $attempt failed for $TARGET — retrying in 30 s"
    sleep 30
  done
  echo "ERROR: could not staple $TARGET"
  exit 1
done
