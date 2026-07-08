#!/bin/bash
# Build a Linux AppImage from the PyInstaller onedir output (Linux x86_64).
#
#   pyinstaller --noconfirm --distpath dist/bundle --workpath build/bundle \
#     tools/bundle/library.spec
#   tools/bundle/make_appimage.sh
#
# → dist/bundle/microSAMPLER_Library-x86_64.AppImage
# Downloads appimagetool on first use (cached in build/bundle/).
set -euo pipefail
cd "$(dirname "$0")/../.."

ONEDIR="dist/bundle/microSAMPLER Library"
APPDIR="build/bundle/AppDir"
TOOL="build/bundle/appimagetool"
[ -d "$ONEDIR" ] || { echo "ERROR: $ONEDIR not found — run pyinstaller first"; exit 1; }

rm -rf "$APPDIR"
mkdir -p "$APPDIR"
cp -r "$ONEDIR"/. "$APPDIR/"
cp web-editor/assets/AppIcon.png "$APPDIR/microsampler-library.png"

cat > "$APPDIR/microsampler-library.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=microSAMPLER Library
Comment=Browse, play and export Korg microSAMPLER bank backups (no hardware needed)
Exec=AppRun
Icon=microsampler-library
Categories=Audio;AudioVideo;Music;
Terminal=false
EOF

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
exec "$(dirname "$(readlink -f "$0")")/microSAMPLER Library" "$@"
EOF
chmod +x "$APPDIR/AppRun"

if [ ! -x "$TOOL" ]; then
  echo "downloading appimagetool…"
  curl -fsSL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi

# --appimage-extract-and-run: works without FUSE (containers, CI runners)
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" \
  "dist/bundle/microSAMPLER_Library-x86_64.AppImage"
echo "built: dist/bundle/microSAMPLER_Library-x86_64.AppImage"
