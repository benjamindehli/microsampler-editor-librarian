# Security Policy

**microSAMPLER Editor / Librarian** is a locally-run, open-source desktop tool:
a Python bridge (`src/native-tools/bridge.py`) that serves a browser UI on
`http://localhost:8765` (8766 in library mode) and talks to a Korg microSAMPLER
over USB. It is not a hosted service, and it runs entirely on the user's own
machine.
It does, however, open a local HTTP server,
claim the USB interface with elevated rights (typed `sudo` for the classic
launchers; the macOS app uses a one-time-approved background helper instead),
and process untrusted input:
imported backups (`.zip` and Korg `.msmpl_bank` files), uploaded `.wav` files,
imported `.mid` patterns and effect-preset JSON.
Security reports are welcome.

## Supported Versions

This is a single-maintainer project. Security fixes are applied to the `main`
branch and rolled into the next tagged release. There are no separately
maintained release branches, and older releases are not back-patched.

| Version                  | Supported          |
| ------------------------ | ------------------ |
| latest release           | :white_check_mark: |
| latest `main`            | :white_check_mark: |
| older releases / commits | :x:                |

Always run the [latest release](../../releases/latest) (or the most recent
commit on `main`) to be sure you have the latest fixes.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's built-in advisory flow:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (under _Advisories_) to open a private
   draft only you and the maintainer can see.
3. Include as much detail as you can: affected file/endpoint, reproduction
   steps, impact, and a proof-of-concept if you have one.

If you can't use that flow, open a regular issue asking the maintainer to reach
out, **without any vulnerability details**, and the conversation can move to a
private channel.

### What to expect

This is a hobby project maintained in spare time, so timelines are best-effort:

- **Acknowledgement:** typically within about a week.
- **Assessment:** once acknowledged, you'll get an initial view on whether the
  report is accepted, needs more information, or is considered out of scope.
- **Fix & disclosure:** accepted issues are fixed on `main` as soon as
  practical. With your agreement, a GitHub Security Advisory will be published
  once a fix is available, and you'll be credited unless you prefer to remain
  anonymous.
- **Declined reports:** if a report is out of scope or working as intended,
  you'll get an explanation.

## Scope

Because the app runs locally, the most relevant concerns are things reachable
without already having control of the machine, for example:

- **In scope:** path traversal or arbitrary file write/read via the bridge's
  HTTP endpoints. Unsafe handling of imported backup `.zip` archives (e.g.
  zip-slip) or uploaded audio files. The local server unintentionally accepting
  requests from other hosts or from untrusted web origins (CSRF/DNS-rebinding).
- **Out of scope:** issues that require an attacker to already have root/local
  access to the machine running the bridge. Vulnerabilities in third-party
  dependencies (report those upstream, since our only runtime deps are
  [pyusb](https://github.com/pyusb/pyusb) and libusb). Anything in the
  original Korg `.pkg`, which is not part of this project.

Thank you for helping keep the project and its users safe.
