---
name: Bug report
about: Report a problem with the editor, the bridge, or device communication
title: "[Bug] "
labels: bug
assignees: ''

---

<!-- Independent, unofficial project — not affiliated with Korg. Please DON'T
     attach copyrighted samples or full bank backups. -->

**Describe the bug**
A clear and concise description of what goes wrong.

**To reproduce**
Which view (SAMPLES / EFFECT / PATTERNS / UTILITY) and the steps:
1. …
2. …
3. See the problem

**Expected behavior**
What you expected to happen instead.

**Does it also happen in mock mode?**
Run the bridge without hardware — `python3 native-tools/bridge.py --mock` — and try
the same thing. This tells us whether it's a UI bug or device/protocol-related.
- [ ] Reproduces in `--mock`
- [ ] Only with the real device
- [ ] Haven't tried

**Bridge terminal output**
The bridge prints errors to the terminal it runs in — paste anything relevant
(especially Python tracebacks). For a transfer-related issue, `--trace` adds a
USB-MIDI dump.
```
(paste here)
```

**Browser console output**
Open the browser dev console (F12 → Console) and paste any errors.
```
(paste here)
```

**Screenshots**
If it's visual, a screenshot of the editor helps.

**Environment**
- OS + version: <!-- e.g. macOS 14.5 / Ubuntu 24.04 / Windows 11 -->
- Python version (`python3 --version`): <!-- 3.8+ required -->
- Browser + version: <!-- e.g. Chrome 126 -->
- How you launched it: <!-- double-click .command / `sudo python3 native-tools/bridge.py` / `--mock` -->
- microSAMPLER connected over USB: <!-- yes / no -->

**Additional context**
Anything else — e.g. did power-cycling the device help? Which sample / bank /
pattern? Did it follow another action (upload, backup, switching banks on the
hardware)?
