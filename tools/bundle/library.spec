# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the BUNDLED 'microSAMPLER Library' app (hardware-free
# librarian; no USB, no sudo). Build (from the repo, PyInstaller installed):
#
#   pyinstaller --noconfirm tools/bundle/library.spec
#
# → dist/microSAMPLER Library/          (Linux/Windows onedir)
# → dist/microSAMPLER Library.app       (macOS bundle; sign+notarize in CI —
#                                        see .github/workflows/package.yml)
#
# Bundles the RAW web-editor/ (no build step — served as-is like in dev) and
# the native-tools python modules. vendor/ (pyusb + libusb) is deliberately
# EXCLUDED: library mode never opens USB, and msusb only reaches for pyusb
# lazily when real hardware is opened.
import json
import os
import sys

ROOT = os.path.normpath(os.path.join(SPECPATH, '..', '..'))      # repo root
NATIVE = os.path.join(ROOT, 'native-tools')
APP_NAME = 'microSAMPLER Library'
with open(os.path.join(ROOT, 'package.json')) as f:
    VERSION = json.load(f)['version']

# optional .icns (generated in CI from assets/AppIcon.png; macOS only)
ICON = os.environ.get('MSMPL_ICNS') or None

a = Analysis(
    [os.path.join(SPECPATH, 'library_app.py')],
    pathex=[NATIVE],                     # so `import bridge` resolves
    datas=[(os.path.join(ROOT, 'web-editor'), 'web-editor')],
    hiddenimports=['bridge', 'protocol', 'msusb', 'download', 'upload',
                   'bank', 'msmpl_bank'],
    excludes=['usb'],                    # pyusb (vendored, lazy) — never needed here
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name=APP_NAME,
    console=False,                       # windowed: no terminal; logs go to the
    icon=ICON,                           # user-data dir (see library_app.py)
    codesign_identity=None,              # signing happens in CI, post-build
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name=APP_NAME)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name=APP_NAME + '.app',
        icon=ICON,
        bundle_identifier='no.dehlimusikk.microsampler-library',
        version=VERSION,
        info_plist={
            # agent-style app: no Dock icon / menu bar — the browser tab IS the
            # UI, and its QUIT button stops the bridge (POST /api/shutdown)
            'LSUIElement': True,
            'NSHighResolutionCapable': True,
            'CFBundleShortVersionString': VERSION,
            'LSApplicationCategoryType': 'public.app-category.music',
        },
    )
