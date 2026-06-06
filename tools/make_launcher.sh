#!/bin/bash
# One-shot (run ON the Mac): build the double-clickable launcher app from
# tools/launcher.applescript, then give it the Dehli Musikk icon.
#
#   ./tools/make_launcher.sh
#
# Rebuild after editing launcher.applescript. The app must stay in the
# repo root (it resolves the repo relative to itself); drag it to the
# Dock for quick access.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="microSAMPLER Editor.app"

rm -rf "$APP"
osacompile -o "$APP" tools/launcher.applescript

PB=/usr/libexec/PlistBuddy
PLIST="$APP/Contents/Info.plist"
$PB -c 'Add :CFBundleName string "microSAMPLER Editor"' "$PLIST" 2>/dev/null \
  || $PB -c 'Set :CFBundleName "microSAMPLER Editor"' "$PLIST"
$PB -c 'Add :CFBundleIdentifier string "no.dehlimusikk.microsampler-editor"' "$PLIST" 2>/dev/null \
  || $PB -c 'Set :CFBundleIdentifier "no.dehlimusikk.microsampler-editor"' "$PLIST"

./tools/make_app_icon.sh

# editing the bundle (plist + icon) breaks the applet's code-signature seal
# and macOS then kills it at launch ("is not open anymore") — re-sign ad hoc
codesign --force --deep -s - "$APP"

echo
echo "Built: $APP  — double-click to launch the editor."
