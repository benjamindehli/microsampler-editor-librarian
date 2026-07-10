# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the DEVICE bridge daemon that ships INSIDE
# "microSAMPLER Editor Librarian.app" (assembled by make_editor_app.sh).
#
#   pyinstaller --noconfirm --distpath dist/bundle --workpath build/bundle \
#     tools/bundle/editor.spec
#
# → dist/bundle/msmpl-bridge/            (onedir; NOT itself an .app — it becomes
#                                         Contents/Resources/bridge/ of the app)
#
# Unlike library.spec this DOES bundle native-tools/vendor/ — the daemon opens
# real USB, so the vendored pyusb (pure python, loaded via a runtime sys.path
# append in msusb) and the per-arch libusb dylibs ride along as data files.
# console=True: it's a launchd daemon; stdout/err go where the plist points.
import json
import os

ROOT = os.path.normpath(os.path.join(SPECPATH, '..', '..'))      # repo root
NATIVE = os.path.join(ROOT, 'native-tools')
with open(os.path.join(ROOT, 'package.json')) as f:
    VERSION = json.load(f)['version']

a = Analysis(
    [os.path.join(SPECPATH, 'editor_daemon.py')],
    pathex=[NATIVE],
    datas=[(os.path.join(ROOT, 'web-editor'), 'web-editor'),
           (os.path.join(NATIVE, 'vendor'), 'vendor')],
    hiddenimports=['bridge', 'protocol', 'msusb', 'download', 'upload',
                   'bank', 'msmpl_bank',
                   # the vendored pyusb rides as DATA (runtime sys.path append),
                   # so the analyzer never sees ITS imports — pull in the stdlib
                   # pieces it needs at runtime
                   'ctypes', 'ctypes.util'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name='msmpl-bridge',
    console=True,
    codesign_identity=None,              # signing happens in CI, post-assembly
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name='msmpl-bridge')
