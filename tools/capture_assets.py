#!/usr/bin/env python3
"""Regenerate the docs/assets screenshots, demo video, and Library screenshot from
the live app — the single source of truth for the asset pipeline (previously only
described in prose).

It drives the mock bridge headless via Playwright at 1540x940 DSR=1, then
downscales LANCZOS to the published sizes. Full-colour PNGs (no 256-quantize — that
posterises the dark gradients); the demo gif uses a shared MAXCOVERAGE palette; the
mp4/webm are a 12 fps, 2 s-per-view slideshow.

The author/copyright/location metadata (XMP + IPTC on PNGs; Exif+GPS + XMP + IPTC on
the JPG) is carried forward — it reads the identical stamp from the already-tagged
committed assets and splices it into each regenerated file, so the manual tagging step
isn't needed after a regen (retag once to change it; --no-metadata to skip).

Dev-only — not shipped, not a runtime dependency. Needs (all permissively licensed):
    pip install playwright pillow imageio-ffmpeg && playwright install chromium

Usage (from anywhere):
    python3 tools/capture_assets.py                  # regenerate everything
    python3 tools/capture_assets.py --only samples   # just the SAMPLES screenshot
    python3 tools/capture_assets.py --only screenshots  # all 5 device screenshots
    python3 tools/capture_assets.py --only demo      # the gif/mp4/webm + poster
    python3 tools/capture_assets.py --only library   # just the Library screenshot
    python3 tools/capture_assets.py --out /tmp/check # write elsewhere (e.g. to verify)

It reuses a bridge already serving on the chosen port, otherwise spawns a mock one
(backups isolated to a temp dir). NOTE: screenshots depend on headless Chromium's
font rendering, so a CI pixel-diff would be flaky — this is a regenerate-on-demand
tool, not a CI gate.
"""
import argparse
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
from contextlib import contextmanager

import imageio_ffmpeg
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'docs', 'assets')
sys.path.insert(0, os.path.join(ROOT, 'native-tools'))

CAP = (1540, 940)        # capture viewport (rail needs ~1519px; DSR=1 keeps PNGs lean)
SHOT = (1000, 610)       # static screenshots + gif
VID = (1280, 782)        # demo poster + mp4/webm
DEMO_VIEWS = ['samples', 'effect', 'patterns', 'utility']
MOCK_PORT = 8801
LIB_PORT = 8806
HIDE = "#mock-badge,#update-toast,#preload{display:none!important}"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def lanczos(src, size):
    return Image.open(src).convert('RGB').resize(size, Image.LANCZOS)


# ── metadata carry-forward ────────────────────────────────────────────────────
# The author/copyright/location stamp (XMP + IPTC on PNGs; Exif+GPS + XMP + IPTC on
# the JPG) is identical on every committed asset, so we don't recreate it — we read
# the exact blocks from the already-tagged assets and splice them, byte-for-byte,
# into each regenerated file. No exiftool needed; nothing to re-enter by hand. To
# change the metadata, retag the assets once (any tool) and the next run carries the
# new stamp forward.
_PNG_META_TYPES = {b'tEXt', b'zTXt', b'iTXt', b'eXIf'}
_PNG_SOURCES = ['samples', 'effect', 'patterns', 'utility', 'upload', 'library']
STAMP = {'png': b'', 'jpg': b''}


def _read(path):
    with open(path, 'rb') as f:
        return f.read()


def _write(path, data):
    with open(path, 'wb') as f:
        f.write(data)


def _png_meta(path):
    """The metadata-bearing ancillary chunks (XMP/IPTC/Exif text) as raw bytes."""
    try:
        data = _read(path)
    except OSError:
        return b''
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return b''
    out = bytearray()
    i = 8
    while i + 8 <= len(data):
        ln = int.from_bytes(data[i:i + 4], 'big')
        typ = data[i + 4:i + 8]
        if typ in _PNG_META_TYPES:
            out += data[i:i + 12 + ln]               # length + type + data + CRC
        i += 12 + ln
        if typ == b'IEND':
            break
    return bytes(out)


def _jpg_meta(path):
    """The APP1 (Exif/XMP) + APP13 (Photoshop/IPTC) marker segments as raw bytes."""
    try:
        data = _read(path)
    except OSError:
        return b''
    if data[:2] != b'\xff\xd8':
        return b''
    out = bytearray()
    i = 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker == 0xDA:                           # start of scan → pixel data
            break
        seglen = int.from_bytes(data[i + 2:i + 4], 'big')
        if marker in (0xE1, 0xED):
            out += data[i:i + 2 + seglen]
        i += 2 + seglen
    return bytes(out)


def load_stamps():
    for name in _PNG_SOURCES:
        m = _png_meta(os.path.join(ASSETS, 'screenshots', name + '.png'))
        if m:
            STAMP['png'] = m
            break
    STAMP['jpg'] = _jpg_meta(os.path.join(ASSETS, 'demo-poster.jpg'))
    miss = [k for k in ('png', 'jpg') if not STAMP[k]]
    if miss:
        print('  ! no %s metadata stamp found in docs/assets — those stay untagged'
              % '/'.join(miss))


def save_png(img, path):
    img.save(path, optimize=True)
    if STAMP['png']:                                 # splice the chunks before IEND
        data = bytearray(_read(path))
        end = data.rfind(b'IEND')
        if end >= 4:
            data[end - 4:end - 4] = STAMP['png']
            _write(path, bytes(data))


def save_jpg(img, path, quality):
    img.save(path, quality=quality, optimize=True)
    if STAMP['jpg']:                                 # splice after SOI + any APP0/JFIF
        data = _read(path)
        i = 2
        while i + 4 <= len(data) and data[i] == 0xFF and data[i + 1] == 0xE0:
            i += 2 + int.from_bytes(data[i + 2:i + 4], 'big')
        _write(path, data[:i] + STAMP['jpg'] + data[i:])


def wait_ready(base, timeout):
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
def bridge(extra_args, port, banks_dir):
    """Reuse a bridge already on `port`, else spawn one (backups → banks_dir)."""
    base = 'http://127.0.0.1:%d' % port
    proc = None
    if not wait_ready(base, 1):
        proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, 'native-tools', 'bridge.py'),
             *extra_args, '--port', str(port)],
            env={**os.environ, 'MSMPL_BACKUP_DIR': banks_dir},
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


def make_wav(path):
    """A short mono WAV so the upload dialog enables its tools + SLICE button."""
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


def _prep_page(pg, base):
    pg.goto(base + '/app.html', wait_until='load')
    pg.wait_for_timeout(1300)
    pg.add_style_tag(content=HIDE)
    pg.evaluate("async () => { await document.fonts.ready; }")


def capture_device(base, wav_path, tmp):
    """Set every device view up, screenshot all 5 at 1540x940. Returns {view: png}."""
    frames = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': CAP[0], 'height': CAP[1]}, device_scale_factor=1)
        _prep_page(pg, base)

        # SAMPLES: select the first pad + arm the keyboard so its key map shows
        pg.locator('.pad[data-slot="0"]').click()
        pg.wait_for_timeout(700)
        pg.check('#qwerty-play')
        # EFFECT: pick Filter (matches the published screenshot)
        pg.locator('.view-btn[data-view="effect"]').click()
        pg.wait_for_timeout(300)
        pg.evaluate("""() => {
            const s = document.querySelector('#fx-type');
            const o = [...s.options].find(o => /filter/i.test(o.textContent));
            if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); }
        }""")
        pg.wait_for_timeout(400)
        # PATTERNS: receive
        pg.locator('.view-btn[data-view="patterns"]').click()
        pg.locator('#patterns-refresh').click()
        pg.wait_for_selector('.pattern-card:not(.is-empty)', timeout=10000)
        pg.wait_for_timeout(400)
        # UTILITY: make a backup so the list + terminal log are populated
        pg.locator('.view-btn[data-view="utility"]').click()
        pg.locator('#backup-btn').click()
        pg.wait_for_function(
            "() => [...document.querySelectorAll('#backup-list .hw-btn-cap')]"
            ".some(s => s.textContent.includes('SAMPLES'))", timeout=15000)
        pg.wait_for_timeout(500)

        # grab the four dialog-free views
        for view in DEMO_VIEWS:
            pg.locator('.view-btn[data-view="%s"]' % view).click()
            pg.wait_for_timeout(450)
            f = os.path.join(tmp, view + '.png')
            pg.screenshot(path=f)
            frames[view] = f
        # UPLOAD: open the dialog over the SAMPLES view with a WAV loaded (SLICE on)
        pg.locator('.view-btn[data-view="samples"]').click()
        pg.locator('.pad[data-slot="0"]').click()
        pg.locator('#upload-btn').click()
        pg.wait_for_selector('#upload-dialog[open]')
        pg.set_input_files('#ud-file', wav_path)
        pg.wait_for_function("() => !document.querySelector('#ud-slice').disabled", timeout=5000)
        pg.wait_for_timeout(300)
        f = os.path.join(tmp, 'upload.png')
        pg.screenshot(path=f)
        frames['upload'] = f
        b.close()
    return frames


def build_demo(frames, out):
    """poster (samples master) + gif (shared palette) + mp4/webm (12 fps slideshow)."""
    save_jpg(lanczos(frames['samples'], VID), os.path.join(out, 'demo-poster.jpg'), 88)

    gif = [lanczos(frames[v], SHOT) for v in DEMO_VIEWS]
    montage = Image.new('RGB', (SHOT[0], SHOT[1] * len(gif)))
    for i, im in enumerate(gif):
        montage.paste(im, (0, SHOT[1] * i))
    pal = montage.quantize(colors=256, method=Image.MAXCOVERAGE, dither=Image.NONE)
    gp = [im.quantize(palette=pal, dither=Image.NONE) for im in gif]
    gp[0].save(os.path.join(out, 'demo.gif'), save_all=True, append_images=gp[1:],
               duration=2000, loop=0, optimize=False, disposal=2)

    seq = tempfile.mkdtemp(prefix='seq-')
    n = 0
    for v in DEMO_VIEWS:
        im = lanczos(frames[v], VID)
        for _ in range(12 * 2):
            im.save(os.path.join(seq, 'f%04d.png' % n))
            n += 1
    inp = ['-y', '-framerate', '12', '-i', os.path.join(seq, 'f%04d.png')]
    subprocess.run([FFMPEG, *inp, '-c:v', 'libx264', '-crf', '26', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', os.path.join(out, 'demo.mp4')],
                   check=True, capture_output=True)
    subprocess.run([FFMPEG, *inp, '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0',
                    os.path.join(out, 'demo.webm')], check=True, capture_output=True)
    shutil.rmtree(seq, ignore_errors=True)


# ── synthetic Korg .msmpl_bank backups for the (hardware-free) Library shot ───
def _chunk(tag, payload):
    return (b'6150' + tag + struct.pack('<H', 32) + struct.pack('<I', len(payload))
            + b'\x00\x00' + struct.pack('<I', 3) + struct.pack('<I', 1)
            + struct.pack('<I', len(payload)) + b'\xff\xff\xff\xff' + payload)


def _sample_chunk(name, long_name, freq):
    n = 12000
    pcm = struct.pack('>' + 'h' * n,
                      *[int(9000 * math.sin(2 * math.pi * freq * i / 48000) * (1 - i / n))
                        for i in range(n)])
    p = bytearray(b'\xff' * 64)
    p[0:8] = name.encode().ljust(8)[:8]
    p[0x0c:0x14] = struct.pack('<II', 0, n - 2)
    p[0x14] = 127; p[0x15] = 20; p[0x17] = 101; p[0x18] = 64
    p[0x19] = 0x40; p[0x1a] = 0x40; p[0x1b] = 0x40
    p[0x20:0x40] = b'\x00' * 32
    p[0x20:0x20 + len(long_name)] = long_name.encode()[:32]
    return _chunk(b'SmpD', bytes(p) + struct.pack('<IHB', len(pcm), 1200, 0) + b'\xff' + pcm)


def _build_bank(name, samples, patterns):
    from test_msmpl import recorded_pattern_blob
    bnkp = _chunk(b'BnkP', name.encode().ljust(8)[:8] + struct.pack('<H', 1200) + b'\xff' * 54)
    smps = _chunk(b'SmpS', b''.join(_sample_chunk(*s) for s in samples))
    seqs = _chunk(b'SeqS', b''.join(
        _chunk(b'SeqD', recorded_pattern_blob(note=60 + i, name=nm))
        for i, nm in enumerate(patterns)))
    return _chunk(b'BnkD', bnkp + smps + seqs)


def capture_library(out, port):
    import msmpl_bank as M
    banks = tempfile.mkdtemp(prefix='libbanks-')
    drum = [('KICK', 'Kick', 60), ('SNARE', 'Snare', 180), ('HIHAT', 'Hi-Hat', 900),
            ('CLAP', 'Clap', 700), ('RIM', 'Rimshot', 500), ('TOM', 'Tom', 120),
            ('CRASH', 'Crash', 1100), ('SHAKER', 'Shaker', 1400)]
    keys = [('RHODES', 'Rhodes EP', 220), ('PIANO', 'Grand Piano', 262),
            ('WURLI', 'Wurlitzer', 330), ('CLAV', 'Clavinet', 196), ('ORGAN', 'Organ', 147),
            ('PAD', 'Warm Pad', 110), ('STRINGS', 'Strings', 294), ('BELL', 'Bell', 523),
            ('BRASS', 'Brass', 175)]
    M.extract_bytes(_build_bank('DRUMKIT', drum, ['INTRO', 'BEAT A', 'BEAT B', 'FILL']),
                    os.path.join(banks, 'DRUMKIT'))
    M.extract_bytes(_build_bank('KEYS', keys, ['VERSE', 'CHORUS', 'BRIDGE']),
                    os.path.join(banks, 'KEYS'))
    tmp = tempfile.mkdtemp(prefix='libshot-')
    with bridge(['--library'], port, banks) as base:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={'width': CAP[0], 'height': CAP[1]}, device_scale_factor=1)
            _prep_page(pg, base)
            pg.wait_for_selector('#view-library', state='visible', timeout=8000)
            pg.wait_for_selector('#lib-banks .lib-bank', timeout=8000)
            pg.evaluate("""() => { for (const b of document.querySelectorAll('#lib-banks .lib-bank'))
                if (/KEYS/.test(b.textContent)) { b.click(); break; } }""")
            pg.wait_for_function(
                "() => document.querySelectorAll('#lib-patterns .lib-pat').length > 0", timeout=8000)
            pg.wait_for_timeout(300)
            f = os.path.join(tmp, 'library.png')
            pg.screenshot(path=f)
            b.close()
    img = Image.open(f).convert('RGB')
    save_png(img.resize((SHOT[0], round(img.height * SHOT[0] / img.width)), Image.LANCZOS),
             os.path.join(out, 'screenshots', 'library.png'))
    shutil.rmtree(banks, ignore_errors=True)
    shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description='Regenerate docs/assets from the live app.')
    ap.add_argument('--only', default='all',
                    help='comma list of samples,screenshots,demo,library (default: all)')
    ap.add_argument('--out', default=ASSETS, help='output assets dir (default: docs/assets)')
    ap.add_argument('--no-metadata', action='store_true',
                    help='skip the XMP/IPTC/Exif/GPS stamp carried from the tagged assets')
    args = ap.parse_args()

    if not args.no_metadata:
        load_stamps()

    want = set()
    for tok in (t.strip() for t in args.only.split(',')):
        if tok == 'all':
            want.update({'screenshots', 'demo', 'library'})
        elif tok:
            want.add(tok)
    os.makedirs(os.path.join(args.out, 'screenshots'), exist_ok=True)

    written = []
    if want & {'samples', 'screenshots', 'demo'}:
        banks = tempfile.mkdtemp(prefix='cap-banks-')
        tmp = tempfile.mkdtemp(prefix='cap-')
        wav = os.path.join(tmp, 'demo.wav')
        make_wav(wav)
        with bridge(['--mock'], MOCK_PORT, banks) as base:
            frames = capture_device(base, wav, tmp)
        if want & {'samples', 'screenshots'}:
            save_png(lanczos(frames['samples'], SHOT),
                     os.path.join(args.out, 'screenshots', 'samples.png'))
            written.append('screenshots/samples.png')
        if 'screenshots' in want:
            for v in ('effect', 'patterns', 'utility', 'upload'):
                save_png(lanczos(frames[v], SHOT),
                         os.path.join(args.out, 'screenshots', v + '.png'))
                written.append('screenshots/%s.png' % v)
        if 'demo' in want:
            build_demo(frames, args.out)
            written += ['demo-poster.jpg', 'demo.gif', 'demo.mp4', 'demo.webm']
        shutil.rmtree(banks, ignore_errors=True)
        shutil.rmtree(tmp, ignore_errors=True)
    if 'library' in want:
        capture_library(args.out, LIB_PORT)
        written.append('screenshots/library.png')

    print('wrote %d asset(s) to %s:' % (len(written), args.out))
    for p in written:
        fp = os.path.join(args.out, p)
        size = Image.open(fp).size if fp.endswith(('png', 'jpg', 'gif')) else ''
        print('  %-28s %7.1f kB  %s' % (p, os.path.getsize(fp) / 1024, size))


if __name__ == '__main__':
    main()
