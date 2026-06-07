# microSAMPLER Editor / Librarian

![CI](https://github.com/benjamindehli/microsampler-editor-librarian/actions/workflows/ci.yml/badge.svg)

A modern editor/librarian for the **Korg microSAMPLER**, replacing Korg's
original 32-bit application (PPC/i386) that no longer runs on macOS 10.15+.
The hardware protocol was reverse-engineered from the original binary and
verified against a real device.
This app covers everything the original did, plus a few things it didn't.

## Features

- **SAMPLES**: 36-slot bank overview, audition (honors start/end points),
  WAV download/upload (auto-resample to 48/24/12/6 kHz), live editing of all
  sample parameters, draggable START/END markers on the waveform, renaming,
  device memory meters
- **EFFECT**: All 22 effect types with their full parameter sets, the two
  assignable FX knobs (panel knob movements tracked live), conditional
  parameter graying/swapping exactly like the hardware
- **PATTERNS**: Receive all 16 patterns, mini piano-roll preview, export as
  Standard MIDI Files, import edited SMFs back to the device (DAW round-trip
  tested with Logic Pro)
- **UTILITY**: Full bank backup/restore (RAM or persistent user banks)
- **Live two-way sync**: panel edits on the device show up in the app instantly

## Requirements

- macOS (tested) — Linux should work, Windows untested
- Python 3.8+ with [pyusb](https://github.com/pyusb/pyusb) (BSD):
  `pip3 install pyusb`
- [libusb](https://libusb.info/) (LGPL): `brew install libusb`
- Chrome/Chromium recommended (any modern should work)
- A Korg microSAMPLER on USB

## Run

**macOS:** double-click **`microSAMPLER Editor Librarian.command`** — it starts the
bridge (asks for your password; root is required to claim the USB interface
from CoreMIDI) and opens the editor window automatically.

**Manual / other OS:**

```bash
sudo python3 native-tools/bridge.py     # then open http://localhost:8765
```

**UI development without hardware:**

```bash
python3 native-tools/bridge.py --mock
```

Bank backups land in `native-tools/backups/` (gitignored — they're your
data). Note that sample/parameter transfers target the device's **current
bank (RAM)**; save on the device or restore to a user bank to persist.

## Repository layout

```text
microSAMPLER Editor Librarian.command   double-clickable launcher (macOS)
web-editor/                   the browser app (served by the bridge)
native-tools/                 Python bridge + CLI tools (libusb USB-MIDI):
  bridge.py                     HTTP/SSE server the app talks to
  download.py / upload.py       single-sample transfer CLIs
  bank.py                       full-bank backup/restore CLI
  msusb.py                      transport + diagnostics (inquiry/monitor/…)
  protocol.py                   Korg SysEx/bulk protocol (offline self-test)
  test_*.py                     offline regression suite (mock device)
tools/re/                     reverse-engineering toolkit (needs the original
                              Korg installer, not included) — regenerates
                              web-editor/js/fxData.js etc.
tools/make_app_icon.sh        give the launcher its icon (run once, macOS)
```

## Development

Run the offline test suite (no hardware needed):

```bash
cd native-tools
python3 protocol.py && python3 test_download.py && python3 test_upload.py \
  && python3 test_bank.py && python3 test_bridge.py
```

## Disclaimer

This is an **independent, unofficial project**. It is not affiliated with,
endorsed, sponsored, or supported by Korg Inc. *microSAMPLER* and *Korg* are
trademarks of Korg Inc., used here only to identify the hardware this
software interoperates with.

This repository contains **no Korg software, firmware, or other Korg
copyrighted material**. The communication protocol was independently
reverse-engineered for the sole purpose of **interoperability** with
hardware owned by the user (as permitted by, e.g., Directive 2009/24/EC
art. 6 in the EU/EEA).

**Use at your own risk.** This software is provided *“as is”*, without
warranty of any kind, as set out in sections 15–16 of the
[GNU GPL v3](LICENSE). The author accepts **no responsibility or liability**
for any damage to your device, loss of samples, patterns or other data, or
any other consequence of using this software. It writes to the device's
memory — **back up your bank** (UTILITY → BACKUP) before bulk operations,
and never disconnect the device mid-transfer.

---

<img src="web-editor/assets/svg/DehliMusikkLogoInverse.svg" alt="Dehli Musikk" width="160">

Made by Benjamin Dehli / Dehli Musikk (not affiliated with Korg).

Licensed under the [GNU GPL v3](LICENSE).

microSAMPLER is a trademark of Korg Inc.
