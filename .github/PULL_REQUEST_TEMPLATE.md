<!-- Thanks for contributing! Keep PRs focused. See CONTRIBUTING.md. -->

## What & why
<!-- A short description of the change and the motivation. -->

Closes #

## Type of change
- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] Tooling / CI

## Area
- [ ] SAMPLES (pads, waveform, upload/download, parameters)
- [ ] EFFECT
- [ ] PATTERNS
- [ ] UTILITY (backup / restore)
- [ ] Bridge / device protocol (`native-tools/`)
- [ ] Other

## Checks (CI runs these — please run them locally too)
- [ ] Python offline suite passes (`protocol.py` + `test_*.py` in `native-tools/`)
- [ ] JS unit tests pass (`npm test`)
- [ ] Linters clean (`npm run lint:js` and `ruff check`)
- [ ] E2E smoke passes (`python3 e2e/smoke.py`)
- [ ] Tried it in mock mode (`python3 native-tools/bridge.py --mock`)

## Hardware testing
<!-- The device protocol is reverse-engineered and largely unverifiable in CI.
     If this touches the bridge/protocol/transfers, say what you tested on a real
     microSAMPLER — and what you couldn't. -->
- [ ] Tested on a real microSAMPLER
- [ ] Not applicable (UI/docs/tooling only)
- [ ] Couldn't test on hardware (explain below)

What I verified on hardware:

## Checklist
- [ ] No Korg-copyright material or personal banks/samples committed
- [ ] Any new dependency is flagged below with its license (or: none added)
- [ ] Docs updated if behaviour/usage changed (README / help overlay)

## Screenshots / notes
<!-- For UI changes, a before/after helps. Anything else for the reviewer. -->
