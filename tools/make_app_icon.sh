#!/bin/bash
# One-shot (run ON the Mac): give "microSAMPLER Editor Librarian.command"
# the Dehli Musikk icon.
#
# Applies web-editor/assets/AppIcon.png (1024x1024, transparent background,
# pre-rendered from AppIcon.svg) with NSWorkspace — a Finder "custom icon",
# stored in local extended attributes / resource fork. NOTE: git does not
# preserve those, so the icon is per-machine; just re-run after cloning.
#
#   ./tools/make_app_icon.sh
#   ./tools/make_app_icon.sh --png file.png    # use a different image
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="$PWD/microSAMPLER Editor Librarian.command"
PNG="$PWD/web-editor/assets/AppIcon.png"

[ -f "$TARGET" ] || { echo "not found: $TARGET"; exit 1; }
if [ "${1:-}" = "--png" ]; then
  PNG="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
fi
[ -f "$PNG" ] || { echo "not found: $PNG"; exit 1; }

/usr/bin/osascript - "$PNG" "$TARGET" <<'EOF'
use framework "AppKit"
on run argv
	set pngPath to item 1 of argv
	set targetPath to item 2 of argv
	set img to current application's NSImage's alloc()'s initWithContentsOfFile:pngPath
	if img is missing value then error "could not load " & pngPath
	set ok to current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:targetPath options:0
	if not (ok as boolean) then error "setIcon failed for " & targetPath
end run
EOF

echo "icon applied to: $TARGET"
echo "(if it was already in the Dock, remove and re-add it — Dock icons cache)"
