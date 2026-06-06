#!/bin/bash
# One-shot (run ON the Mac): build the launcher app's .icns icon from
# web-editor/assets/svg/AppIcon.svg using only stock macOS tools.
#
#   ./tools/make_app_icon.sh                 # render the SVG via Quick Look
#   ./tools/make_app_icon.sh --png file.png  # or supply a 1024x1024 PNG
#                                            # (export manually if QL balks)
set -euo pipefail
cd "$(dirname "$0")/.."

APP="microSAMPLER Editor.app"
SVG="web-editor/assets/svg/AppIcon.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "${1:-}" = "--png" ]; then
  PNG="$2"
else
  # Quick Look renders the SVG to a PNG thumbnail
  qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null
  PNG="$TMP/$(basename "$SVG").png"
  [ -f "$PNG" ] || { echo "Quick Look could not render the SVG — export a" \
    "1024x1024 PNG yourself and re-run with: $0 --png file.png"; exit 1; }
fi

SET="$TMP/icon.iconset"
mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s             "$PNG" --out "$SET/icon_${s}x${s}.png"      >/dev/null
  sips -z $((s*2)) $((s*2)) "$PNG" --out "$SET/icon_${s}x${s}@2x.png"   >/dev/null
done

# write under the name the bundle's plist declares (osacompile applets
# use "applet"; fall back to "icon")
NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' \
        "$APP/Contents/Info.plist" 2>/dev/null || echo icon)"
NAME="${NAME%.icns}"
mkdir -p "$APP/Contents/Resources"
iconutil -c icns "$SET" -o "$APP/Contents/Resources/$NAME.icns"
touch "$APP"      # nudge Finder/Dock to refresh the icon cache
# replacing the icon breaks the bundle's signature seal — re-sign ad hoc
# (harmless if make_launcher.sh signs again right after)
codesign --force --deep -s - "$APP" 2>/dev/null || true
echo "icon installed -> $APP/Contents/Resources/$NAME.icns"
echo "(if the Dock still shows a generic icon, drag the app out and back in)"
