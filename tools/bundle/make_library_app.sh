#!/bin/bash
# Assemble "microSAMPLER Library.app" (macOS only): the Swift Dock-app shell
# + the frozen library bridge as its supervised child.
#
#   pyinstaller --noconfirm --distpath dist/bundle --workpath build/bundle \
#     tools/bundle/library.spec           # → dist/bundle/microSAMPLER Library/
#   tools/bundle/make_library_app.sh      # → dist/bundle/microSAMPLER Library.app
#
# Optional: MSMPL_ICNS=/path/AppIcon.icns for the app icon.
# Signing/notarization happen afterwards (CI: .github/workflows/package.yml).
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="dist/bundle/microSAMPLER Library.app"
SRC="tools/bundle/library-app"
BRIDGE="dist/bundle/microSAMPLER Library"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null \
          || python3 -c "import json; print(json.load(open('package.json'))['version'])")
[ -d "$BRIDGE" ] || { echo "ERROR: $BRIDGE missing — run pyinstaller library.spec first"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

ARCH=$(uname -m)   # arm64 | x86_64 — CI builds each on its native runner
swiftc -O -target "$ARCH-apple-macos12.0" \
  -o "$APP/Contents/MacOS/microSAMPLER Library" \
  "$SRC/main.swift"

sed "s/__VERSION__/$VERSION/g" "$SRC/Info.plist" > "$APP/Contents/Info.plist"
# ditto, NOT cp -r: preserves the Python.framework symlink structure
ditto "$BRIDGE" "$APP/Contents/Resources/bridge"
[ -n "${MSMPL_ICNS:-}" ] && cp "$MSMPL_ICNS" "$APP/Contents/Resources/AppIcon.icns"

echo "assembled: $APP  (v$VERSION, $ARCH, macOS 12+)"
