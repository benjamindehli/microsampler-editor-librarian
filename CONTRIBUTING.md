# Contributing

Thanks for your interest in the **microSAMPLER Editor / Librarian**, an
independent, unofficial editor for the Korg microSAMPLER, reverse-engineered for
modern macOS. Contributions are welcome: bug reports, fixes, features, docs.

This is a small, single-maintainer hobby project, so please be patient with
review times.

## Ground rules

- **Independent & unofficial.** This project is not affiliated with Korg. The
  communication protocol was reverse-engineered for **interoperability** with
  hardware the user owns. Don't add Korg software, firmware, presets, or other
  copyrighted material to the repo.
- **License.** By contributing you agree your work is licensed under the
  project's [GNU GPL v3](LICENSE).
- **Security issues.** Please report privately (see [SECURITY.md](SECURITY.md)),
  not via a public issue or PR.

## Reporting issues

Use the **Bug report** / **Feature request** templates. For bugs, the most
useful thing you can do is say **whether it also reproduces in mock mode**
(`python3 src/native-tools/bridge.py --mock`). That tells us instantly whether it's
a UI bug or device/protocol-related. Please also paste the **bridge terminal
output** and **browser console** errors.

## Development setup

The app is **plain ES modules + per-component CSS with no build step**, so you
just run the bridge and open the page. You only need hardware deps for talking
to a real device.

```bash
# UI / app work — no hardware, no extra deps:
python3 src/native-tools/bridge.py --mock        # then open http://localhost:8765

# With a real microSAMPLER (sudo claims the USB iface; pyusb + libusb are
# bundled in src/native-tools/vendor/ — no pip or brew step):
sudo python3 src/native-tools/bridge.py
```

`--mock` serves fake data so you can develop and test almost everything without
the device. See the [README](README.md#repository-layout) for the repo layout,
and [ARCHITECTURE.md](ARCHITECTURE.md) for how the bridge, app, and device fit
together (data flow, the two transports, the module map).

## Before you open a PR

Please run the same checks CI runs. All are offline (no hardware, no network):

```bash
# Python: offline protocol/flow suite (3.8-compatible, dependency-free)
cd src/native-tools && python3 protocol.py && python3 test_download.py \
  && python3 test_upload.py && python3 test_bank.py && python3 test_bridge.py && cd ..

# JavaScript unit tests (Node's built-in runner, no deps)
npm test

# Linters (bug-focused — see below)
npm install        # one-time, for ESLint + TypeScript
npm run lint:js
npm run lint:types # JSDoc type check (tsc --checkJs, no emit, no TS in the app)
ruff check         # pip install ruff

# End-to-end browser smoke (boots the mock bridge, drives it headless)
pip install playwright && playwright install chromium
python3 test/e2e/smoke.py
```

CI (`.github/workflows/ci.yml`) runs the offline suite (Python 3.8 + 3.12), the
JS checks, both linters, and the e2e smoke. They must all pass.

## Code style & conventions

- **Match the surrounding code.** The linters (Ruff for Python, ESLint for JS)
  are configured as **bug catchers, not formatters**. They flag undefined
  names, unused imports, etc., but won't reformat. Keep the existing hand-tuned
  style. ESLint also auto-sorts import statements (`simple-import-sort`).
- **Python must stay 3.8-compatible** (the oldest interpreter we support): no
  `match` statements, no 3.9+ stdlib. `pyusb` is imported lazily so the offline
  suite stays dependency-free, and it should stay that way.
- **JavaScript** is browser ES modules (no transpile). Pure, testable logic
  (e.g. value encoders, the audio DSP) lives in modules that unit-test under
  `node:test` in `test/unit/`. Add coverage there when you touch them.
- **Types are JSDoc, checked but never compiled.** `npm run lint:types` runs
  `tsc --checkJs --noEmit` over `src/web-editor` (`tsconfig.json`);
  nothing is transpiled and no TypeScript reaches the browser.
  **Every module is checked, including new ones** — there is no per-file
  opt-in, so a new component has to satisfy it like the rest.
  The idioms that keep it quiet:
  - `$` / `$$` / `closestEl` from `functions/util.js` for DOM lookups, rather
    than `document.querySelector(All)` or `e.target.closest(…)` directly.
    They return a permissive element type, so `.value` / `.dataset` /
    `.showModal` need no cast.
  - `/** @type {HTMLInputElement} */ (ev.target)` when you do need the target
    of an event (`.files`, `.value`, `.checked`).
  - `/** @type {[number, string, number][]} */` on a heterogeneous array,
    or TS infers a useless union and every bit of arithmetic on it fails.
  - Put a property in the object literal if the object grows it later
    (`{ mode: "erase", erased: false }`), so a typo in the later
    assignment is caught.
  - `String(n)` when assigning a number to `.textContent`, `.value`,
    `dataset.*` or `input.max`. JS coerces; the check makes it explicit.
- **CSS** is split per component and themed via CSS custom properties
  (`--amber-rgb` etc. + `color-mix`) so the accent theming keeps working. Avoid
  hard-coding accent colours.

## Hardware vs. mock

Much of the device protocol can't be exercised offline, and the maintainer
can't packet-capture. So:

- Anything touching **`src/native-tools/bridge.py` / `protocol.py` / the transfer
  CLIs** is **hardware-critical and largely unverifiable in CI**. Change it
  conservatively, keep the offline tests green, and **call out in your PR what
  you could and couldn't test on a real device**.
- The `tools/re/` reverse-engineering toolkit needs Korg's original `.pkg`
  (gitignored, not distributed) and isn't required for most contributions.
- The **packaged desktop apps** live in `tools/bundle/` (PyInstaller specs,
  entry scripts, the Swift menu-bar shell) and are built/signed/notarized by
  `.github/workflows/package.yml`. Run that workflow manually to validate
  packaging changes before a release.

## Regenerating docs assets

The screenshots and demo video under `docs/assets/` are generated from the live
app, so don't hand-edit them. After a UI change, regenerate with:

```bash
pip install playwright pillow imageio-ffmpeg && playwright install chromium
python3 tools/capture_assets.py            # all screenshots + demo + Library shot
python3 tools/capture_assets.py --only samples   # or a subset: samples/screenshots/demo/library
```

It drives the mock bridge headless, so it needs no hardware. Screenshots depend on
headless Chromium's font rendering, so this is a regenerate-on-demand tool, not a CI
gate. (`og-cover.jpg` is a real photo and isn't regenerated.)

The author/copyright/location metadata (XMP + IPTC on the PNGs, Exif/GPS + XMP + IPTC
on the JPG) is **carried forward automatically**. The script copies the existing
stamp from the already-tagged assets, so you don't need to re-tag after a regen. To
change it, retag the assets once with any tool and the next run picks it up. Pass
`--no-metadata` to skip stamping.

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

- Korg's `.pkg` installer or the owner's manual PDF (copyright, gitignored).
- Personal bank backups / samples (`src/native-tools/backups/`, `*.wav`, etc. are
  gitignored).
- `node_modules/` or `dist/` (gitignored).

Thanks for helping keep an obsolete-by-the-vendor instrument usable! 🎛️
