# Contributing

Thanks for your interest in the **microSAMPLER Editor / Librarian** — an
independent, unofficial editor for the Korg microSAMPLER, reverse-engineered for
modern macOS. Contributions are welcome: bug reports, fixes, features, docs.

This is a small, single-maintainer hobby project, so please be patient with
review times.

## Ground rules

- **Independent & unofficial** — not affiliated with Korg. The communication
  protocol was reverse-engineered for **interoperability** with hardware the
  user owns. Don't add Korg software, firmware, presets, or other copyrighted
  material to the repo.
- **License** — by contributing you agree your work is licensed under the
  project's [GNU GPL v3](LICENSE).
- **Security issues** — please report privately (see [SECURITY.md](SECURITY.md)),
  not via a public issue or PR.

## Reporting issues

Use the **Bug report** / **Feature request** templates. For bugs, the most
useful thing you can do is say **whether it also reproduces in mock mode**
(`python3 native-tools/bridge.py --mock`) — that tells us instantly whether it's
a UI bug or device/protocol-related — and paste the **bridge terminal output**
and **browser console** errors.

## Development setup

The app is **plain ES modules + per-component CSS with no build step** — just
run the bridge and open the page. You only need hardware deps for talking to a
real device.

```bash
# UI / app work — no hardware, no extra deps:
python3 native-tools/bridge.py --mock        # then open http://localhost:8765

# With a real microSAMPLER (needs pyusb + libusb, and sudo to claim the USB iface):
pip3 install pyusb       # brew install libusb
sudo python3 native-tools/bridge.py
```

`--mock` serves fake data so you can develop and test almost everything without
the device. See the [README](README.md#repository-layout) for the repo layout.

## Before you open a PR

Please run the same checks CI runs. All are offline (no hardware, no network):

```bash
# Python: offline protocol/flow suite (3.8-compatible, dependency-free)
cd native-tools && python3 protocol.py && python3 test_download.py \
  && python3 test_upload.py && python3 test_bank.py && python3 test_bridge.py && cd ..

# JavaScript unit tests (Node's built-in runner, no deps)
npm test

# Linters (bug-focused — see below)
npm install        # one-time, for ESLint
npm run lint:js
ruff check         # pip install ruff

# End-to-end browser smoke (boots the mock bridge, drives it headless)
pip install playwright && playwright install chromium
python3 e2e/smoke.py
```

CI (`.github/workflows/ci.yml`) runs the offline suite (Python 3.8 + 3.12), the
JS checks, both linters, and the e2e smoke — they must pass.

## Code style & conventions

- **Match the surrounding code.** The linters (Ruff for Python, ESLint for JS)
  are configured as **bug catchers, not formatters** — they flag undefined
  names, unused imports, etc., but won't reformat. Keep the existing hand-tuned
  style; ESLint also auto-sorts import statements (`simple-import-sort`).
- **Python must stay 3.8-compatible** (the oldest interpreter we support): no
  `match` statements, no 3.9+ stdlib. `pyusb` is imported lazily so the offline
  suite stays dependency-free — keep it that way.
- **JavaScript** is browser ES modules (no transpile). Pure, testable logic
  (e.g. value encoders, the audio DSP) lives in modules that unit-test under
  `node:test` in `test/` — add coverage there when you touch them.
- **CSS** is split per component and themed via CSS custom properties
  (`--amber-rgb` etc. + `color-mix`) so the accent theming keeps working — avoid
  hard-coding accent colours.

## Hardware vs. mock

Much of the device protocol can't be exercised offline, and the maintainer
can't packet-capture. So:

- Anything touching **`native-tools/bridge.py` / `protocol.py` / the transfer
  CLIs** is **hardware-critical and largely unverifiable in CI** — change it
  conservatively, keep the offline tests green, and **call out in your PR what
  you could and couldn't test on a real device**.
- The `tools/re/` reverse-engineering toolkit needs Korg's original `.pkg`
  (gitignored, not distributed) and isn't required for most contributions.

## Dependencies

The shipped app has **no runtime npm dependencies** and only **pyusb (BSD) +
libusb (LGPL)** at runtime. Dev/CI tools (esbuild, ESLint, Ruff, Playwright) are
all permissively licensed. Please **prefer official, well-maintained,
permissively-licensed packages, and flag any new dependency in your PR** (with
its license) before adding it.

## Submitting changes

1. Fork and branch off `main`.
2. Make focused commits with clear messages.
3. Run the checks above.
4. Open a PR against `main` describing the change and (for device-related work)
   what you tested on hardware.

## Don't commit

- Korg's `.pkg` installer or the owner's manual PDF (copyright — gitignored).
- Personal bank backups / samples (`native-tools/backups/`, `*.wav`, etc. are
  gitignored).
- `node_modules/` or `dist/` (gitignored).

Thanks for helping keep an obsolete-by-the-vendor instrument usable! 🎛️
