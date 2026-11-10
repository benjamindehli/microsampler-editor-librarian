# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the bundled 'microSAMPLER Library' bridge (hardware-free
# librarian; no USB, no sudo). Build (from the repo, PyInstaller installed):
#
#   pyinstaller --noconfirm --distpath dist/bundle --workpath build/bundle \
#     tools/bundle/library.spec
#
# → dist/bundle/microSAMPLER Library/   onedir: the Linux AppImage payload, and
#                                       what make_library_app.sh embeds into the
#                                       macOS .app, where a Swift shell
#                                       supervises it (see library-app/main.swift).
#
# Bundles the RAW src/web-editor/ (no build step — served as-is like in dev) and
# the native-tools python modules. vendor/ (pyusb + libusb) is deliberately
# EXCLUDED: library mode never opens USB, and msusb only reaches for pyusb
# lazily when real hardware is opened.
import os

ROOT = os.path.normpath(os.path.join(SPECPATH, '..', '..'))      # repo root
NATIVE = os.path.join(ROOT, 'src', 'native-tools')
APP_NAME = 'microSAMPLER Library'

# optional .icns (generated in CI from assets/AppIcon.png; macOS only)
ICON = os.environ.get('MSMPL_ICNS') or None

a = Analysis(
    [os.path.join(SPECPATH, 'library_app.py')],
    pathex=[NATIVE],                     # so `import bridge` resolves
    datas=[(os.path.join(ROOT, 'src', 'web-editor'), 'web-editor')],
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
    # a supervised child process, not a GUI app; logs go to the user-data dir
    # (see library_app.py). Signing happens in CI, after assembly.
    console=True,
    icon=ICON,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name=APP_NAME)
