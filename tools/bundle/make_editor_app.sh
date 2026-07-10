#!/bin/bash
# Assemble "microSAMPLER Editor Librarian.app" (macOS only): the Swift
# menu-bar shell + the SMAppService daemon plist + the frozen device bridge.
#
#   pyinstaller --noconfirm --distpath dist/bundle --workpath build/bundle \
#     tools/bundle/editor.spec                      # → dist/bundle/msmpl-bridge/
#   tools/bundle/make_editor_app.sh                 # → dist/bundle/…app
#
# Optional: MSMPL_ICNS=/path/AppIcon.icns for the app icon.
# Signing/notarization happen afterwards (CI: .github/workflows/package.yml).
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="dist/bundle/microSAMPLER Editor Librarian.app"
SRC="tools/bundle/editor-app"
BRIDGE="dist/bundle/msmpl-bridge"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null \
          || python3 -c "import json; print(json.load(open('package.json'))['version'])")
[ -d "$BRIDGE" ] || { echo "ERROR: $BRIDGE missing — run pyinstaller editor.spec first"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" \
         "$APP/Contents/Library/LaunchDaemons"

# the menu-bar shell (single-file AppKit; main.swift = top-level code)
ARCH=$(uname -m)   # arm64 | x86_64 — CI builds each on its native runner
swiftc -O -target "$ARCH-apple-macos13.0" \
  -o "$APP/Contents/MacOS/microSAMPLER Editor Librarian" \
  "$SRC/main.swift"

sed "s/__VERSION__/$VERSION/g" "$SRC/Info.plist" > "$APP/Contents/Info.plist"
cp "$SRC/no.dehlimusikk.msmpl.bridge.plist" "$APP/Contents/Library/LaunchDaemons/"
cp -r "$BRIDGE" "$APP/Contents/Resources/bridge"
[ -n "${MSMPL_ICNS:-}" ] && cp "$MSMPL_ICNS" "$APP/Contents/Resources/AppIcon.icns"

echo "assembled: $APP  (v$VERSION, $ARCH, macOS 13+)"
echo "next: codesign everything (incl. Resources/bridge) + notarize — see package.yml"
