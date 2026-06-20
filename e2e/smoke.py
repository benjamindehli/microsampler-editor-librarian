#!/usr/bin/env python3
"""End-to-end smoke test: boot the mock bridge, drive the web app in a headless
browser, and assert it loads and the core interactions work with NO page or
console errors. Catches frontend regressions the unit/offline suites can't —
e.g. a module that throws at import time (the missing `api` import once did).

Dev/CI only — needs Playwright:
    pip install playwright && playwright install chromium

Run from anywhere:
    python3 e2e/smoke.py            # (override port with SMOKE_PORT)
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('SMOKE_PORT', '8799'))
BASE = 'http://127.0.0.1:%d' % PORT


def make_wav(path):
    """A 2 s mono WAV with four spaced bursts — works for both equal and
    transient auto-slicing."""
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        frames = bytearray()
        for t in range(96000):
            v = 0.0
            for at in (0, 24000, 48000, 72000):
                d = t - at
                if 0 <= d < 8000:
                    v += 0.7 * math.sin(2 * math.pi * 220 * d / 48000) * math.exp(-d / 4000)
            frames += struct.pack('<h', max(-32768, min(32767, int(v * 32767))))
        w.writeframes(bytes(frames))


def wait_ready(timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + '/api/status', timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def run_checks(wav_path):
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={'width': 1340, 'height': 820}).new_page()
        page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
        page.on('console', lambda m: errors.append('console.error: %s' % m.text)
                if m.type == 'error' else None)

        page.goto(BASE, wait_until='load')
        page.wait_for_timeout(1200)

        # booted and connected to the (mock) device
        assert page.is_hidden('#offline'), 'offline curtain should be hidden'
        assert page.text_content('#bank-name').strip() == 'MOCKBANK', 'bank name'

        # selecting a pad populates the editor
        page.locator('.pad[data-slot="0"]').click()
        page.wait_for_timeout(900)
        assert page.text_content('#sel-name').strip(), 'editor shows a sample name'

        # a live param edit reaches the bridge (the ticker reflects it)
        page.eval_on_selector('#ctl-decay', "e => { e.value = 55;"
                              " e.dispatchEvent(new Event('input'));"
                              " e.dispatchEvent(new Event('change')); }")
        page.wait_for_timeout(300)
        assert '#21' in page.text_content('#ticker-log'), 'decay edit should tick'

        # audition triggers the device (note on/off) + shows the playhead overlay
        page.locator('#audition-btn').click()
        page.locator('#playhead').wait_for(state='visible', timeout=3000)
        page.locator('#audition-btn').click()      # stop

        # every view renders without error
        for view in ('effect', 'patterns', 'utility', 'samples'):
            page.locator('.view-btn[data-view="%s"]' % view).click()
            page.wait_for_timeout(400)

        # patterns: receive, then play a recorded one on the device (transport)
        page.locator('.view-btn[data-view="patterns"]').click()
        page.locator('#patterns-refresh').click()
        page.wait_for_selector('.pattern-card:not(.is-empty)', timeout=10000)
        play = page.locator('.pattern-card:not(.is-empty) .p-actions .hw-btn').first
        play.click()
        # reaches the playing state (button gets .playing, swapping ▶→■ icon)
        page.wait_for_function(
            "() => { const b = document.querySelector("
            "'.pattern-card:not(.is-empty) .p-actions .hw-btn');"
            " return b && b.classList.contains('playing'); }", timeout=6000)
        play.click()                               # stop

        # auto-slice: chop a WAV across 4 consecutive pads, which then auto-load
        page.locator('.view-btn[data-view="samples"]').click()
        page.locator('.pad[data-slot="10"]').click()
        page.wait_for_timeout(200)
        page.locator('#upload-btn').click()
        page.wait_for_selector('#upload-dialog[open]')
        page.set_input_files('#ud-file', wav_path)
        page.wait_for_function("() => !document.querySelector('#ud-slice').disabled",
                               timeout=5000)
        page.locator('#ud-slice').click()
        page.wait_for_selector('#slice-dialog[open]')
        page.fill('#sl-count', '4')
        page.dispatch_event('#sl-count', 'input')
        page.locator('#sl-go').click()
        page.wait_for_function("() => !document.querySelector('#slice-dialog').open",
                               timeout=10000)
        page.wait_for_function(
            "() => [10,11,12,13].every(s => { const p = document.querySelector("
            "`.pad[data-slot='${s}']`);"
            " return p && p.classList.contains('used') && p.classList.contains('loaded'); })",
            timeout=15000)

        # cherry-pick: back up the bank, then copy one sample out of it into a pad
        page.locator('.view-btn[data-view="utility"]').click()
        page.locator('#backup-btn').click()
        page.wait_for_function(
            "() => [...document.querySelectorAll('#backup-list .hw-btn-cap')]"
            ".some(s => s.textContent.includes('SAMPLES'))", timeout=15000)
        page.locator('text=SAMPLES…').first.click()
        page.wait_for_selector('#cherry-dialog[open]')
        page.select_option('#cp-dst', '30')
        page.locator('#cp-copy').click()
        page.wait_for_function(
            "() => { const p = document.querySelector(`.pad[data-slot='30']`);"
            " return p && p.classList.contains('used'); }", timeout=8000)

        # connection helper: a wedged device (status connected:false) shows the
        # Retry panel, and a successful Retry (/api/connect) recovers the app.
        ctx = browser.new_context(viewport={'width': 1340, 'height': 820})
        pg2 = ctx.new_page()
        pg2.on('pageerror', lambda e: errors.append('pageerror(helper): %s' % e))
        pg2.on('console', lambda m: errors.append('console.error(helper): %s' % m.text)
               if m.type == 'error' else None)
        wedged = json.dumps({'connected': False, 'mock': True, 'version': '0',
                             'error': 'no inquiry reply — device off or wedged'})
        ok = json.dumps({'connected': True, 'mock': True, 'version': '0', 'error': None})
        pg2.route('**/api/status', lambda r: r.fulfill(
            status=200, content_type='application/json', body=wedged))
        pg2.route('**/api/connect', lambda r: r.fulfill(
            status=200, content_type='application/json', body=ok))
        pg2.goto(BASE, wait_until='load')
        pg2.locator('#device-help').wait_for(state='visible', timeout=5000)
        assert pg2.is_hidden('#offline'), 'device-help is a distinct state from offline'
        pg2.locator('#device-help-retry').click()
        pg2.locator('#device-help').wait_for(state='hidden', timeout=8000)
        assert pg2.text_content('#bank-name').strip() == 'MOCKBANK', 'recovered after retry'
        ctx.close()

        browser.close()
    return errors


def main():
    tmp = tempfile.mkdtemp(prefix='msmpl-smoke-')
    wav_path = os.path.join(tmp, 'break.wav')
    make_wav(wav_path)
    # If a bridge is already serving on PORT, reuse it (run against a live dev
    # bridge, or let CI start it separately); otherwise spawn a mock one — with
    # backups isolated to the temp dir so the cherry-pick check stays self-contained.
    bridge = None
    if not wait_ready(timeout=1):
        bridge = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, 'native-tools', 'bridge.py'),
             '--mock', '--port', str(PORT)],
            env={**os.environ, 'MSMPL_BACKUP_DIR': os.path.join(tmp, 'backups')},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_ready():
            print('FAIL: mock bridge did not become ready on %s' % BASE)
            return 1
        errors = run_checks(wav_path)
        if errors:
            print('FAIL: page/console errors during smoke:')
            for e in errors:
                print('  ', e)
            return 1
        print('e2e smoke: OK')
        return 0
    finally:
        if bridge is not None:
            bridge.terminate()
            try:
                bridge.wait(timeout=5)
            except Exception:
                bridge.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
