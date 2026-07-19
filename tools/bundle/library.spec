# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the BUNDLED 'microSAMPLER Library' bridge (hardware-free
# librarian; no USB, no sudo). Build (from the repo, PyInstaller installed):
#
#   pyinstaller --noconfirm tools/bundle/library.spec
#
# → dist/bundle/microSAMPLER Library/   onedir: the Linux AppImage payload, AND
#                                       what make_library_app.sh embeds into the
#                                       macOS .app. A Swift shell supervises it
#                                       there — a plain frozen process has no
#                                       macOS app lifecycle: no reopen handling,
#                                       no ⌘Q, ghost "not open anymore" states.
#
# Bundles the RAW web-editor/ (no build step — served as-is like in dev) and
# the native-tools python modules. vendor/ (pyusb + libusb) is deliberately
# EXCLUDED: library mode never opens USB, and msusb only reaches for pyusb
# lazily when real hardware is opened.
import json
import os

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
    console=True,                        # a supervised child process, not a GUI
    icon=ICON,                           # app; logs go to the user-data dir
    codesign_identity=None,              # (see library_app.py). Signing happens
    entitlements_file=None,              # in CI, post-assembly.
)
coll = COLLECT(exe, a.binaries, a.datas, name=APP_NAME)
