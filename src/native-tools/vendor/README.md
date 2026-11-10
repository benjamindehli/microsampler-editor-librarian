# Vendored dependencies

These are bundled so the app runs on **just Python 3**, with no `pip install pyusb` and no `brew install libusb`.
`msusb.py` adds `pyusb/` to `sys.path` (as a fallback, so a system pyusb still wins) and points pyusb's libusb1 backend straight at the matching `libusb/<os>-<arch>/` binary.

## pyusb/: pyusb 1.2.1

Pure-Python USB access library.
**BSD-3-Clause** (see `pyusb/LICENSE`).
Source: <https://github.com/pyusb/pyusb> · PyPI `pyusb==1.2.1`.

> Pinned to **1.2.1** on purpose: it's the last release supporting **Python 3.8** (the oldest Python the launchers support).
> 1.3.x requires Python ≥ 3.9.

## libusb/: libusb 1.0.26 (native binaries)

Prebuilt libusb shared libraries, one per OS + CPU architecture:

| Folder           | File              | Platform                |
|------------------|-------------------|-------------------------|
| `darwin-x86_64`  | `libusb-1.0.dylib`| macOS, Intel            |
| `darwin-arm64`   | `libusb-1.0.dylib`| macOS, Apple Silicon    |
| `linux-x86_64`   | `libusb-1.0.so`   | Linux, x86-64           |
| `linux-aarch64`  | `libusb-1.0.so`   | Linux, ARM64            |
| `win-amd64`      | `libusb-1.0.dll`  | Windows, 64-bit         |

The binaries are libusb (**LGPL-2.1-or-later**), taken from the [`libusb-package`](https://github.com/pyocd/libusb-package) project.
Its Python wrapper is Apache-2.0, and only the libusb libraries are vendored, not the wrapper.
See `libusb/LICENSE`. libusb source: <https://github.com/libusb/libusb>.
As LGPL, the library may be replaced: drop a compatible `libusb-1.0.*` into the matching folder.

**A system libusb is preferred when present** (`msusb.py` uses the bundled copy only as a fallback).
A newer system build (`brew install libusb` or `apt install libusb-1.0-0`) tends to survive more device reconnect cycles than the bundled 1.0.26 before the microSAMPLER's USB stack wedges (a device-side limit, not a libusb bug).
`MSAMPLER_BUNDLED_LIBUSB=1` forces the bundled one.

**Verifying the binaries:** `libusb/CHECKSUMS.txt` records the SHA-256 of each shipped library.
These are the only opaque blobs in the repo, and they load into a root-privileged bridge.
Check them with:

```bash
cd libusb && sha256sum -c CHECKSUMS.txt
```

Regenerate the list whenever the binaries are refreshed (see below):

```bash
cd libusb && sha256sum */libusb-1.0.* > CHECKSUMS.txt   # then re-add the header
```

## Refreshing these

```bash
# pyusb (must stay ≤ 1.2.1 while Python 3.8 is supported)
pip download pyusb==1.2.1 --no-deps -d /tmp/v && unzip -o /tmp/v/pyusb-*.whl -d /tmp/pu
#   -> copy /tmp/pu/usb/ here, plus its dist-info/LICENSE as pyusb/LICENSE

# libusb binaries: one wheel per platform tag, e.g.:
pip download libusb-package==1.0.26.3 --no-deps --only-binary=:all: \
  --platform macosx_11_0_arm64 --python-version 3.8 -d /tmp/lp
#   -> copy libusb_package/libusb-1.0.dylib into darwin-arm64/, etc.
```
