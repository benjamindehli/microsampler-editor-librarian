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
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('SMOKE_PORT', '8799'))
BASE = 'http://127.0.0.1:%d' % PORT


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


def run_checks():
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

        # every view renders without error
        for view in ('effect', 'patterns', 'utility', 'samples'):
            page.locator('.view-btn[data-view="%s"]' % view).click()
            page.wait_for_timeout(400)

        browser.close()
    return errors


def main():
    # If a bridge is already serving on PORT, reuse it (run against a live dev
    # bridge, or let CI start it separately); otherwise spawn a mock one.
    bridge = None
    if not wait_ready(timeout=1):
        bridge = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, 'native-tools', 'bridge.py'),
             '--mock', '--port', str(PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_ready():
            print('FAIL: mock bridge did not become ready on %s' % BASE)
            return 1
        errors = run_checks()
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


if __name__ == '__main__':
    sys.exit(main())
