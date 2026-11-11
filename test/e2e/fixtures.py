"""Shared fixtures for the browser-driven dev tools: the e2e smoke test
(test/e2e/smoke.py) and the asset pipeline (tools/capture_assets.py)."""
import math
import os
import struct
import subprocess
import sys
import time
import urllib.request
import wave
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def make_wav(path):
    """A 2 s mono 48 kHz WAV with four spaced, decaying 220 Hz bursts: enough for
    the upload dialog's tools and for both equal and transient auto-slicing."""
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


def msmpl_chunk(tag, payload):
    """One 32-byte-header '6150' chunk of an original Korg .msmpl_bank file."""
    return (b'6150' + tag + struct.pack('<H', 32) + struct.pack('<I', len(payload))
            + b'\x00\x00' + struct.pack('<I', 3) + struct.pack('<I', 1)
            + struct.pack('<I', len(payload)) + b'\xff\xff\xff\xff' + payload)


def wait_ready(base, timeout):
    """True once `base`/api/status answers 200, False after `timeout` seconds."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + '/api/status', timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


@contextmanager
def bridge(extra_args, port, backup_dir):
    """Yield the base URL of a bridge on `port`: reuse one that's already running,
    else start one (`extra_args`, e.g. ['--mock']) with its backups in
    `backup_dir`, and stop it afterwards. Raises RuntimeError if it never
    becomes ready."""
    base = 'http://127.0.0.1:%d' % port
    proc = None
    if not wait_ready(base, 1):
        proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, 'src', 'native-tools', 'bridge.py'),
             *extra_args, '--port', str(port)],
            env={**os.environ, 'MSMPL_BACKUP_DIR': backup_dir},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_ready(base, 20):
            raise RuntimeError('bridge did not become ready on %s' % base)
        yield base
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
