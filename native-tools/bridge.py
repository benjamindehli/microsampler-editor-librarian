#!/usr/bin/env python3
"""
microSAMPLER local bridge — owns the USB device and serves the web app.

While the bridge runs it is the SINGLE owner of the microSAMPLER (libusb), so
the browser does everything through it: live parameter edits, sample
transfer, bank summary, and a live event stream of panel edits (for Learn).
The web editor's pure Web-MIDI mode remains available when the bridge is NOT
running — never run both at once.

Stdlib only (Python 3.8 compatible). Run with sudo (CoreMIDI owns the
interface otherwise):

    sudo python3 bridge.py                # http://localhost:8765
    sudo python3 bridge.py --port 9000
    python3 bridge.py --mock              # UI development without hardware

API (JSON unless noted):
  GET  /api/status            device inquiry result + bridge state
  GET  /api/bank              bank name/BPM + 36 sample summaries (enters and
                              leaves dump mode; ~2 s)
  GET  /api/sample/N.wav      download slot N as a WAV (audio/wav)
  POST /api/sample/N          upload WAV body to slot N
                              (?name=XXXXXXXX&tempo=120.0) — CURRENT BANK/RAM!
  POST /api/param             {"obj":16,"param":16,"value":1} live edit
  GET  /api/events            text/event-stream of incoming parameter changes
"""
import argparse
import io
import json
import math
import os
import queue
import re
import struct
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import protocol as P
from msusb import MicroSampler, from_usb_midi
import download as DL
import upload as UL

WEB_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', 'web-editor'))
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
        '.wav': 'audio/wav', '.webp': 'image/webp', '.jpg': 'image/jpeg'}


# ---------------------------------------------------------------------------
# Device manager: one open session, one lock, a background event reader.
# ---------------------------------------------------------------------------
def _hexline(prefix, data):
    if data:
        sys.stderr.write('%s %s %s\n' % (time.strftime('%H:%M:%S'), prefix,
                                         ' '.join('%02X' % b for b in data)))


class Device:
    def __init__(self, reader=True, trace=False):
        self.trace = trace
        self.lock = threading.RLock()       # serializes all USB operations
        self.ms = None
        self.channel = 0
        self.cable = 1
        self.inquiry = None
        self.listeners = []                 # SSE queues
        self.reader_enabled = reader
        self._stop = threading.Event()
        self._reader = None

    # -- lifecycle ----------------------------------------------------------
    def open(self):
        with self.lock:
            if self.ms:
                return
            ms = MicroSampler().open()
            if self.trace:
                real_read, real_write = ms._read_raw, ms.dev.write

                def traced_read(timeout=300):
                    data = real_read(timeout=timeout)
                    # skip pure clock/active-sensing reads to keep trace usable
                    if data and not all(
                            data[i] & 0x0f == 0x0f and data[i+1] in (0xf8, 0xfe)
                            for i in range(0, len(data) - 3, 4)):
                        _hexline('<<', data)
                    return data

                def traced_write(ep, data, timeout=2000):
                    _hexline('>>', bytes(data))
                    return real_write(ep, data, timeout=timeout)

                ms._read_raw = traced_read
                ms.dev.write = traced_write
            reply, cable = ms.device_inquiry()
            if not reply:
                ms.close()
                raise RuntimeError('no inquiry reply — device off or wedged '
                                   '(power-cycle it)')
            self.ms, self.cable = ms, cable
            self.ms.cable = cable
            self.channel = reply[2] & 0x0f
            self.inquiry = {
                'family': reply[6] | (reply[7] << 8),
                'member': reply[8] | (reply[9] << 8),
                'channel': self.channel,
                'cable': cable,
            }
        if self.reader_enabled:
            self._reader = threading.Thread(target=self._read_loop, daemon=True)
            self._reader.start()

    def close(self):
        self._stop.set()
        with self.lock:
            if self.ms:
                self.ms.close()
                self.ms = None

    # -- background event reader (paused whenever an operation holds the lock)
    def _read_loop(self):
        while not self._stop.is_set():
            got = self.lock.acquire(timeout=0.2)
            if not got:
                continue
            try:
                if not self.ms:
                    return
                raw = self.ms._read_raw(timeout=60)
                for msg in self.ms.reasm.feed(from_usb_midi(raw)):
                    self._on_sysex(msg)
            finally:
                self.lock.release()
            time.sleep(0.005)

    def _on_sysex(self, msg):
        evt = P.parse_reply(msg)
        if evt.get('type') != 'parameter_change':
            return
        data = json.dumps(evt)
        for q in list(self.listeners):
            try:
                q.put_nowait(data)
            except queue.Full:
                pass

    # -- operations (all hold the lock) --------------------------------------
    def status(self):
        return {'connected': self.ms is not None, 'inquiry': self.inquiry,
                'mock': False}

    def _inquire(self):
        """Fresh Device Inquiry — the original editor opens EVERY session with
        one (DeviceInquiry at the top of each UsbSession::process); the device
        refuses dump-mode requests (func 0x29) without it. Caller holds lock."""
        reply, _ = self.ms.device_inquiry(timeout_ms=2000, cables=(self.cable,))
        if not reply:
            raise RuntimeError('device inquiry failed — device off or wedged '
                               '(power-cycle it)')
        self.channel = reply[2] & 0x0f

    def send_param(self, obj, param, value):
        with self.lock:
            self.ms.send_sysex(P.parameter_change(self.channel, obj, param, value))

    def bank_summary(self):
        """Bank blob only, then leave dump mode. NO per-slot header requests:
        func 0x16 opens a dump session that ONLY a data dump (0x1F) closes
        (hardware-traced 2026-06-05; the 0x14 param request does NOT close it
        — the original's Target=1 flow is dead code). Rate/length are filled
        in lazily by the client from the WAV when a sample is downloaded."""
        with self.lock:
            self._inquire()
            bank = self._fetch_bank_blob()
            try:
                slots = [self._slot_json(i, bank['sample_params'][i])
                         for i in range(36)]
            finally:
                # never strand the device in dump mode
                try:
                    self._leave_dump(commit=True)
                except Exception:
                    traceback.print_exc()
        return {'name': bank['name'], 'bpm': bank['bpm'], 'slots': slots}

    @staticmethod
    def _slot_json(i, par):
        # flags8 bit7 = empty/init slot flag (hardware-verified 2026-06-05)
        out = {'slot': i, 'empty': bool(par['flags8'] & 0x80) or par['u32_10'] == 0}
        if not out['empty']:
            out.update(
                name=par['name'], long_name=par['long_name'],
                start=par['u32_0c'], end=par['u32_10'],
                level=par['b17'], pan=par['b18'],
                semitone=par['semitone'], tune_byte=par['b1a'],
                decay=par['b14'], release=par['b15'],
                fx_sw=bool(par['flags8'] & 0x08),
            )
        return out

    def _fetch_bank_blob(self):
        from bank import fetch_bank_blob
        return fetch_bank_blob(self.ms, self.channel)

    def _leave_dump(self, commit=True):
        from bank import leave_dump_mode
        leave_dump_mode(self.ms, self.channel, commit=commit)

    def download_wav(self, slot):
        with self.lock:
            self._inquire()
            hdr = DL.fetch_header(self.ms, self.channel, slot)
            if hdr['data_size'] == 0:
                return None
            pcm = DL.fetch_pcm(self.ms, self.channel, hdr['data_size'],
                               progress=False)
        buf = io.BytesIO()
        samples = bytearray(pcm[:len(pcm) & ~1])
        samples[0::2], samples[1::2] = pcm[1::2], pcm[0::2]   # BE -> LE
        with wave.open(buf, 'wb') as w:
            w.setnchannels(2 if hdr['stereo'] else 1)
            w.setsampwidth(2)
            w.setframerate(hdr['rate_hz'])
            w.writeframes(bytes(samples))
        return buf.getvalue()

    def upload_wav(self, slot, wav_bytes, name, tempo):
        chans, rate = UL.load_wav(io.BytesIO(wav_bytes))
        target = min((48000, 24000, 12000, 6000), key=lambda r: abs(r - rate))
        pcm, frames = UL.to_device_pcm(chans, rate, target)
        blob = P.build_param_blob(name, name, 0, frames)
        with self.lock:
            self._inquire()
            UL.upload(self.ms, self.channel, slot, pcm, target,
                      len(chans) == 2, frames, blob, tempo)
        return {'slot': slot, 'frames': frames, 'rate_hz': target,
                'stereo': len(chans) == 2}


class MockDevice(Device):
    """Hardware-free stand-in for UI development (--mock)."""

    def __init__(self):
        super().__init__()
        self.inquiry = {'family': 0x7f, 'member': 0x0100, 'channel': 0, 'cable': 1}
        self._slots = {}
        for i, name in enumerate(['OCTSTRAT', 'OCARINA', 'TOYPIANO']):
            n = 24000 * (i + 1)
            pcm = b''.join(struct.pack('<h', int(12000 *
                           math.sin(j * (0.05 + 0.02 * i))))
                           for j in range(n))
            self._slots[i] = {'name': name, 'rate': 48000, 'stereo': False,
                              'pcm': pcm, 'tempo': 120.0}

    def open(self):
        pass

    def close(self):
        pass

    def status(self):
        return {'connected': True, 'inquiry': self.inquiry, 'mock': True}

    def send_param(self, obj, param, value):
        pass

    def bank_summary(self):
        slots = []
        for i in range(36):
            s = self._slots.get(i)
            if not s:
                slots.append({'slot': i, 'empty': True})
                continue
            frames = len(s['pcm']) // 2
            slots.append({'slot': i, 'empty': False, 'name': s['name'],
                          'long_name': s['name'].title(), 'rate_hz': s['rate'],
                          'stereo': s['stereo'], 'frames': frames,
                          'seconds': frames / s['rate'], 'tempo_bpm': s['tempo'],
                          'start': 0, 'end': frames - 2, 'level': 101,
                          'pan': 64, 'semitone': 0, 'tune_byte': 64,
                          'decay': 127, 'release': 0, 'fx_sw': i == 0})
        return {'name': 'MOCKBANK', 'bpm': 120.0, 'slots': slots}

    def download_wav(self, slot):
        s = self._slots.get(slot)
        if not s:
            return None
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(2 if s['stereo'] else 1)
            w.setsampwidth(2)
            w.setframerate(s['rate'])
            w.writeframes(s['pcm'])
        return buf.getvalue()

    def upload_wav(self, slot, wav_bytes, name, tempo):
        chans, rate = UL.load_wav(io.BytesIO(wav_bytes))
        target = min((48000, 24000, 12000, 6000), key=lambda r: abs(r - rate))
        pcm, frames = UL.to_device_pcm(chans, rate, target)
        # store as LE mono mixdown of channel 0 for simplicity
        le = bytearray(pcm)
        le[0::2], le[1::2] = pcm[1::2], pcm[0::2]
        self._slots[slot] = {'name': name, 'rate': target,
                             'stereo': len(chans) == 2, 'pcm': bytes(le),
                             'tempo': tempo}
        return {'slot': slot, 'frames': frames, 'rate_hz': target,
                'stereo': len(chans) == 2}


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------
DEVICE = None        # set in main()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # -- helpers --------------------------------------------------------------
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def _err(self, msg, code=500):
        self._json({'error': str(msg)}, code)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s  %s\n" % (time.strftime('%H:%M:%S'), fmt % args))

    # -- routing ---------------------------------------------------------------
    def do_GET(self):
        path = self.path.split('?')[0]
        try:
            if path == '/api/status':
                return self._json(DEVICE.status())
            if path == '/api/bank':
                return self._json(DEVICE.bank_summary())
            m = re.match(r'^/api/sample/(\d+)\.wav$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                data = DEVICE.download_wav(slot)
                if data is None:
                    return self._err('slot is empty', 404)
                return self._bytes(data, 'audio/wav')
            if path == '/api/events':
                return self._sse()
            return self._static(path)
        except BrokenPipeError:
            pass
        except Exception as e:          # surface everything to the browser + log
            traceback.print_exc()
            self._err(e)

    def do_POST(self):
        path, _, query = self.path.partition('?')
        params = dict(p.split('=', 1) for p in query.split('&') if '=' in p)
        try:
            if path == '/api/param':
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                DEVICE.send_param(int(body['obj']), int(body['param']),
                                  int(body['value']))
                return self._json({'ok': True})
            m = re.match(r'^/api/sample/(\d+)$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                n = int(self.headers.get('Content-Length', 0))
                wav = self.rfile.read(n)
                name = params.get('name', 'SAMPLE')[:8].upper()
                tempo = float(params.get('tempo', '120'))
                return self._json(DEVICE.upload_wav(slot, wav, name, tempo))
            return self._err('not found', 404)
        except Exception as e:
            traceback.print_exc()
            self._err(e)

    # -- SSE ---------------------------------------------------------------
    def _sse(self):
        q = queue.Queue(maxsize=256)
        DEVICE.listeners.append(q)
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            while True:
                try:
                    data = q.get(timeout=15)
                    self.wfile.write(('data: %s\n\n' % data).encode())
                except queue.Empty:
                    self.wfile.write(b': keepalive\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            DEVICE.listeners.remove(q)

    # -- static files ---------------------------------------------------------
    def _static(self, path):
        if path == '/':
            path = '/app.html'
        full = os.path.normpath(os.path.join(WEB_ROOT, path.lstrip('/')))
        if not full.startswith(WEB_ROOT) or not os.path.isfile(full):
            return self._err('not found', 404)
        with open(full, 'rb') as f:
            data = f.read()
        self._bytes(data, MIME.get(os.path.splitext(full)[1], 'application/octet-stream'))


def main():
    global DEVICE
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--mock', action='store_true',
                    help='serve fake data for UI development (no hardware)')
    ap.add_argument('--no-reader', action='store_true',
                    help='disable the background panel-edit reader (diagnostic; '
                         'the /api/events stream stays silent)')
    ap.add_argument('--trace', action='store_true',
                    help='hexdump every USB read/write to stderr (diagnostic)')
    args = ap.parse_args()

    DEVICE = MockDevice() if args.mock else Device(reader=not args.no_reader,
                                                   trace=args.trace)
    try:
        DEVICE.open()
    except Exception as e:
        print('device open failed: %s' % e)
        return 1
    if not args.mock:
        print('microSAMPLER claimed (cable %d, channel %d) — Web MIDI mode is '
              'unavailable until the bridge exits.'
              % (DEVICE.cable, DEVICE.channel + 1))

    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print('bridge ready: http://localhost:%d  (Ctrl+C to stop)' % args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        print('\nclosing device...')
        DEVICE.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
