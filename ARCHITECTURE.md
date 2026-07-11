# Architecture

How the pieces fit together, for contributors. For *what* the app does see the
[README](README.md); for *how to contribute* see [CONTRIBUTING](CONTRIBUTING.md).

## The big picture

The microSAMPLER only speaks **USB**, and on macOS its USB-MIDI interface is claimed by CoreMIDI, so the browser can't reach it directly (WebUSB is blocked for audio-class interfaces).
The solution is a small **local bridge** that owns the device and exposes a plain HTTP/SSE API the browser app talks to.

``` text
   ┌───────────────────-──────┐        HTTP + SSE (localhost:8765)        ┌──────────────────────┐
   │   Browser app            │ ────────────────────────────-───────────▶ │  Bridge (Python)     │
   │   web-editor/  (ES mods) │   GET /api/bank, POST /api/param,         │  native-tools/       │
   │                          │ ◀──────  /api/sample/N.wav, …             │  bridge.py           │
   │   • views: SAMPLES /     │     SSE /api/events (panel edits,         │                      │
   │     EFFECT / PATTERNS /  │            op progress)                   │  single USB owner    │
   │     UTILITY              │                                           │  (RLock-serialised)  │
   └──────────────────-───────┘                                           └──────────┬───────────┘
                                                                                     │ libusb (msusb.py)
                                                                    USB-MIDI cable 1 │ bulk EP 0x01/0x82
                                                                                     ▼
                                                                          ┌──────────────────────┐
                                                                          │  Korg microSAMPLER   │
                                                                          │  VID 0944 PID 010C   │
                                                                          └──────────────────────┘
```

The bridge **serves the web app's static files too**, so there's nothing to
build or host — open `http://localhost:8765` and it's same-origin.

## Two transports, one pair of pipes

Everything rides the device's two bulk endpoints (OUT `0x01` / IN `0x82`,
64-byte packets, USB-MIDI **cable 1**), but in two modes:

- **Live parameter editing → MIDI SysEx.** A parameter change is one SysEx
  message (`F0 42 3g 7F 41 …`, three 14-bit little-endian values:
  object, param, value). Objects: `16 + slot` for samples, `0` for the bank,
  `80` for the effect.
- **Sample / bank / pattern transfer → raw USB bulk** on the same pipes
  (headers via SysEx, PCM as raw bytes).

The protocol was reverse-engineered from the original 32-bit editor; the codec
and message builders live in **`native-tools/protocol.py`** (pure, with an
offline self-test). The USB transport is **`native-tools/msusb.py`**.

## Components

| Path | Role |
| --- | --- |
| `native-tools/bridge.py` | HTTP/SSE server + device manager. Owns the USB session. |
| `native-tools/protocol.py` | Korg SysEx/bulk codec + builders (pure). |
| `native-tools/msusb.py` | libusb transport (USB-MIDI packetisation, inquiry). |
| `native-tools/{download,upload,bank}.py` | Single-sample + full-bank transfer flows (also CLIs). |
| `native-tools/msmpl_bank.py` | Reader for original Korg `.msmpl_bank` backups (library mode + CLI). |
| `web-editor/` | The browser app — ES modules, no build step: `app.js` entry, pure leaves in `functions/`, one folder per feature in `components/<name>/` (JS + CSS), globals in `styles/`. |
| `tools/bundle/` | The packaged desktop apps: PyInstaller specs + entry scripts, the Swift menu-bar shell for the macOS Editor app, AppImage/DMG/notarization scripts (built by `.github/workflows/package.yml`). |
| `tools/re/` | Reverse-engineering toolkit (needs Korg's `.pkg`; not distributed). |

### Bridge internals (`bridge.py`)

- A single **`Device`** instance owns the libusb handle. **One `RLock`
  serialises every USB operation** — the device can't be talked to
  concurrently.
- A **background reader thread** continuously reads the IN endpoint (it pauses
  whenever an operation holds the lock). Incoming SysEx (panel parameter edits)
  and Control Change (the FX-edit knobs) are parsed and pushed to clients over
  **SSE** (`/api/events`).
- **Sessions & dump mode:** every operation re-sends a Device Inquiry (an idle
  device refuses dump-mode requests otherwise), and dump-mode is always left in
  a `finally`. The sample-select state machine is finicky — see the comments in
  `bridge.py` / `download.py`.
- **`--mock`** swaps in a `MockDevice` that serves fake data with no hardware,
  so the whole UI (and the e2e smoke + most tests) run without a device.
- **`--library`** (port 8766) swaps in a `LibraryDevice`: no USB at all, just
  browsing/exporting bank backups — what the Library desktop app runs.
- **`--daemon`** is how the macOS Editor app's background service runs the
  bridge: the device starts **unclaimed**, is claimed lazily when the editor
  page opens, and is auto-released after a few idle minutes with no UI — so
  the always-on daemon doesn't hog the microSAMPLER from DAWs. `POST
  /api/release` releases it on demand (the menu bar's *Release Device*).

### Frontend (`web-editor/`)

Plain ES modules, loaded by `app.html`; **no bundler in dev**. Modules import
through bare aliases (`functions/…`, `components/…`, `app.js`), resolved by an
import map in `app.html` (dev), esbuild aliases (dist), and a Node hook
(tests) — so moving a file never touches its importers. Circular imports exist
but are runtime-only (used inside functions), so they're safe.

- `app.js` — entry: boot, view switching, `refreshBank()`, focus re-sync.
- `functions/` — pure leaves: `state` (the single shared mutable state),
  `util` (DOM/`api()` helpers), `events` (routes SSE messages onto the right
  module), `ticker`, `notes`, `audioTools` (upload DSP), `smfWrite`, and the
  **generated** `valueTables` + `fxData` (from `tools/re/` — don't hand-edit).
- `components/<name>/` — one folder per feature (`<name>.js` + `<name>.css`):
  `pads`, `sample-editor` (slot/waveform/sampleLoad/slotops/slice),
  `controls`, `meter`, `effect`, `patterns`, `pattern-editor`, `keyboard`,
  `dialogs`, `utility`, `library`, `update`, `ux`.
- `styles/` — global sheets: `base` (tokens), `layout`, `fonts`.

A production build (`npm run build`, esbuild) bundles/minifies into `dist/` for
releases, but it's optional — the source runs as-is.

### Packaged apps (`tools/bundle/`)

The same bridge + web app, frozen with PyInstaller into double-clickable apps
(built, signed and notarized by `.github/workflows/package.yml`):

- **microSAMPLER Library** — `library_app.py` + `library.spec`: the bridge in
  `--library` mode with a bundled runtime; macOS `.app` and Linux
  AppImage/tar.gz. No USB, no privileges.
- **microSAMPLER Editor Librarian** (macOS 13+) — a small Swift menu-bar app
  (`editor-app/main.swift`) that registers a root **launchd daemon** via
  `SMAppService` (one-time approval in Login Items); the daemon is the frozen
  bridge in `--daemon` mode (`editor_daemon.py` + `editor.spec`), so no typed
  `sudo` and no terminal. Both apps ship in one notarized DMG per
  architecture.

## Data flow

### Boot

`app.js` → `GET /api/status` (device inquiry) → `GET /api/bank` (name/BPM + 36
slot summaries, read from the bank blob) → subscribe `GET /api/events` (SSE).

### Live parameter edit (app → device)

control change → `controls.js` → `POST /api/param {obj,param,value}` → bridge
`send_sysex(parameter_change)` → device.

### Panel edit (device → app)

turn a knob on the device → it transmits SysEx → bridge reader thread parses it
→ SSE event → `events.js` → updates the cached value + reflects it in the UI.
(The device only transmits edits while on its SAMPLE-EDIT page; the app also
auto-re-reads the bank on window focus to resync.)

### Sample download / upload

`GET /api/sample/N.wav` → bridge runs the 3-phase receive (header `0x16` → PCM
`0x1F` → params `0x14`), byteswaps BE→LE, returns a WAV (+ `X-Sample-Tempo`
header) → browser decodes it for the waveform/meter.
`POST /api/sample/N` (WAV body) → bridge upload (`0x42` header → raw PCM → `0x44`
param blob); the browser may pre-process the WAV first (the AUDIO TOOLS panel).

### Bank backup / restore & patterns

Long operations (`/api/backup`, `/api/restore`, `/api/patterns`) run on a
background thread and stream progress over SSE. Patterns export/import as
Standard MIDI Files.

### Playback (everything is on the hardware)

- Audition / pad-play: `POST /api/note` → MIDI note on/off (`note = 48 + slot`).
- Pattern transport: `POST /api/pattern/N/play` selects the pattern (NRPN) and
  starts the sequencer, with the bridge streaming MIDI clock; `POST
  /api/transport/stop` stops it.

## Key constraints worth knowing

- **One USB owner at a time** — the bridge and any other MIDI software can't
  hold the device together.
- **RAM vs flash** — sample/parameter transfers target the device's *current
  bank (RAM)*, lost on power-off/bank-switch. Persisting means a panel WRITE or
  restoring to a user bank.
- **Hardware is largely unverifiable in CI.** The maintainer can't
  packet-capture; protocol changes are confirmed by hand on a real device. Lean
  on `--mock`, the offline suite, and call out hardware testing in PRs.

## Tests & CI

See [CONTRIBUTING](CONTRIBUTING.md). In short: a Python offline suite
(`native-tools/test_*.py`, mock device), JS unit tests for the pure modules
(`test/`, `node --test`), a Playwright browser smoke (`e2e/smoke.py`), and two
linters (Ruff + ESLint) — all run in `.github/workflows/ci.yml`.
