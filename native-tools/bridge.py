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
BACKUP_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backups')
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
        '.wav': 'audio/wav', '.webp': 'image/webp', '.jpg': 'image/jpeg',
        '.woff2': 'font/woff2', '.txt': 'text/plain'}


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
        self.op = None                      # current/last backup or restore
        self.pattern_cache = {}             # q -> raw 1308B blob
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
                midi = from_usb_midi(raw)
                for msg in self.ms.reasm.feed(midi):
                    self._on_sysex(msg)
                self._scan_cc(midi)
            finally:
                self.lock.release()
            time.sleep(0.005)

    def _scan_cc(self, midi):
        """Forward Control Change messages as SSE events. The panel's FX EDIT
        1/2 knobs transmit plain CC (not SysEx param changes) — the app maps
        them onto the knob-assigned effect params. Safe to scan the flat
        stream: status bytes (>=0x80) cannot occur inside SysEx bodies."""
        i, n = 0, len(midi)
        while i < n:
            if midi[i] & 0xf0 == 0xb0 and i + 2 < n \
                    and midi[i + 1] < 0x80 and midi[i + 2] < 0x80:
                self._emit({'type': 'cc', 'ch': midi[i] & 0x0f,
                            'cc': midi[i + 1], 'value': midi[i + 2]})
                i += 3
            else:
                i += 1

    def _emit(self, obj):
        data = json.dumps(obj)
        for q in list(self.listeners):
            try:
                q.put_nowait(data)
            except queue.Full:
                pass

    def _on_sysex(self, msg):
        evt = P.parse_reply(msg)
        if evt.get('type') == 'parameter_change':
            self._emit(evt)

    # -- long-running ops (backup/restore): one at a time, progress over SSE --
    def start_op(self, name, fn):
        if self.op and not self.op['done']:
            raise RuntimeError('another operation is already running')
        self.op = {'name': name, 'lines': [], 'done': False, 'ok': None}

        def run():
            ok = False
            try:
                with self.lock:
                    self._inquire()
                    fn(self.op_log)
                ok = True
            except Exception as e:
                traceback.print_exc()
                self.op_log('ERROR: %s' % e)
            finally:
                self.op['ok'] = ok
                self.op['done'] = True
                self._emit({'type': 'op_done', 'name': name, 'ok': ok})

        threading.Thread(target=run, daemon=True).start()

    def op_log(self, line):
        line = str(line)
        print(line)
        self.op['lines'].append(line)
        self._emit({'type': 'op', 'name': self.op['name'], 'line': line})

    def op_status(self):
        return self.op or {'name': None, 'lines': [], 'done': True, 'ok': None}

    def patterns_summary(self):
        """Fetch all 16 patterns (single-sequence receive per pattern — the
        original's standalone SequenceReceive flow) and parse. Each fetch's
        data dump closes its own select session; patterns are a fixed 1308
        bytes on this hardware so the data phase always runs."""
        from bank import fetch_sequence
        with self.lock:
            self._inquire()
            out = []
            for q in range(16):
                # progress over SSE — the GET blocks until all 16 are read,
                # but the event stream (separate thread) delivers these live
                self._emit({'type': 'progress', 'op': 'patterns',
                            'done': q, 'total': 16})
                blob = fetch_sequence(self.ms, self.channel, q)
                self.pattern_cache[q] = blob
                out.append(_pattern_json(q, blob))
            self._emit({'type': 'progress', 'op': 'patterns',
                        'done': 16, 'total': 16})
        return {'patterns': out}

    def pattern_mid(self, q):
        blob = self.pattern_cache.get(q)
        if blob is None:
            from bank import fetch_sequence
            with self.lock:
                self._inquire()
                blob = fetch_sequence(self.ms, self.channel, q)
                self.pattern_cache[q] = blob
        if not blob:
            return None
        return P.pattern_to_smf(blob)

    def pattern_write(self, q, blob):
        """Write a pattern blob (standalone SequenceWrite flow), update cache."""
        from bank import send_sequence
        with self.lock:
            self._inquire()
            send_sequence(self.ms, self.channel, q, blob)
            self.pattern_cache[q] = blob
        return _pattern_json(q, blob)

    def start_backup(self):
        import bank as BK
        os.makedirs(BACKUP_ROOT, exist_ok=True)
        label = time.strftime('%Y%m%d-%H%M%S')
        out = os.path.join(BACKUP_ROOT, label)
        self.start_op('backup',
                      lambda log: BK.backup(self.ms, self.channel, None, out,
                                            log=log))
        return {'dir': label}

    def start_restore(self, dirname, bank):
        import bank as BK
        src = backup_dir(dirname)
        if not os.path.isfile(os.path.join(src, 'manifest.json')):
            raise RuntimeError('unknown backup: %s' % dirname)
        self.start_op('restore',
                      lambda log: BK.restore(self.ms, self.channel, bank, src,
                                             log=log))
        return {'dir': dirname,
                'target': 'current' if bank is None else bank + 1}

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

    def set_bank_settings(self, name, bpm):
        """Bank name + BPM in ONE lock acquisition (object 0: name chars as
        params 0..7, BPM*10 as param 16 — from EditBankParameterAction).
        Batched because 9 separate /api/param round-trips each contend with
        the background reader's lock cycle — user-visibly sluggish."""
        padded = name[:8].ljust(8)
        with self.lock:
            for i, c in enumerate(padded):
                self.ms.send_sysex(P.parameter_change(self.channel, 0, i,
                                                      ord(c) & 0x7f))
            self.ms.send_sysex(P.parameter_change(self.channel, 0, 16,
                                                  int(round(bpm * 10))))
        return {'name': padded.rstrip(), 'bpm': round(bpm, 1)}

    def receive_sample(self, slot):
        """Read a whole sample (the proven download.py 3-phase flow:
        header 0x16 → PCM 0x1F → params 0x14) into memory."""
        with self.lock:
            self._inquire()
            hdr = DL.fetch_header(self.ms, self.channel, slot)
            if hdr['data_size'] == 0:
                return {'empty': True}
            pcm = DL.fetch_pcm(self.ms, self.channel, hdr['data_size'],
                               progress=False)
            par = DL.fetch_params(self.ms, self.channel, slot)
        return {'empty': False, 'pcm': pcm, 'rate': hdr['rate_hz'],
                'stereo': hdr['stereo'], 'tempo': hdr['tempo_bpm'],
                'blob': par['raw']}

    def write_sample(self, slot, d):
        """Write a sample read by receive_sample (proven upload.py flow:
        header 0x42 → PCM → param blob 0x44). Empty = dataSize-0 header only
        (the restore-empty path that clears a slot)."""
        with self.lock:
            self._inquire()
            if d.get('empty'):
                DL._drain(self.ms)
                self.ms.send_sysex(P.sample_header(self.channel, slot, 0, 48000, False))
                DL._wait_korg_reply(self.ms, P.UPLOAD_HDR_OK, P.UPLOAD_HDR_ERR,
                                    timeout_ms=8000, what='clear header ACK')
            else:
                UL.upload(self.ms, self.channel, slot, d['pcm'], d['rate'],
                          d['stereo'], 0, d['blob'], d['tempo'])
        return {'slot': slot, 'empty': bool(d.get('empty'))}

    def copy_sample(self, frm, to):
        return self.write_sample(to, self.receive_sample(frm))

    def swap_samples(self, a, b):
        da, db = self.receive_sample(a), self.receive_sample(b)
        self.write_sample(b, da)
        self.write_sample(a, db)
        return {'a': a, 'b': b}

    def clear_sample(self, slot):
        return self.write_sample(slot, {'empty': True})

    def set_effect(self, fx_type, knobs, params):
        """Apply a whole effect preset in ONE lock grab (object 80): FX type
        (param 1) — the device re-inits its params on type change, so we then
        send the 2 knob assigns (params 2-3) + every effect param (16+i) to
        override. Batched for the same reason bank settings are (per-message
        round-trips contend the reader lock = sluggish)."""
        ch = self.channel
        with self.lock:
            self.ms.send_sysex(P.parameter_change(ch, 80, 1, int(fx_type)))
            for k in (0, 1):
                self.ms.send_sysex(P.parameter_change(ch, 80, 2 + k,
                                                      int(knobs[k])))
            for i, v in enumerate(params):
                self.ms.send_sysex(P.parameter_change(ch, 80, 16 + i, int(v)))
        return {'type': int(fx_type)}

    def play_note(self, slot, on, velocity=100):
        """Trigger a sample pad on the DEVICE via MIDI note. Sample-mode note
        map (same numbering the pattern engine uses for sample-mode tracks):
        note = 48 (C3) + slot, on the device's global channel, cable 1."""
        note = 48 + max(0, min(35, int(slot)))
        status = (0x90 if on else 0x80) | (self.channel & 0x0f)
        with self.lock:
            self.ms.send_short(status, note, max(1, min(127, int(velocity))),
                               cable=self.cable)

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
        return {'name': bank['name'], 'bpm': bank['bpm'], 'slots': slots,
                'effect': self._effect_json(bank['effect']),
                # pattern storage, 0x200-byte units per pattern (= the
                # 0x800-block-rounded size; device pool = 0x60000 bytes)
                'seq_lengths': bank['seq_lengths']}

    @staticmethod
    def _effect_json(packed):
        # 36B packed effect data (bank blob @0x950) maps onto EffectData
        # bytes 4..0x27: [0]=fx type, [2]/[3]=knob assigns, [4+i]=param i
        # byte (= display value + descriptor center; client de-centers).
        return {'type': packed[0], 'knobs': [packed[2], packed[3]],
                'params': list(packed[4:36])}

    @staticmethod
    def _slot_json(i, par):
        # empty/init slots have END == 0 (name 'INITSMPL', hardware-dumped
        # 2026-06-08). NOT flags8 bit7 — that is LOOP, which merely defaults
        # ON for initialized slots (the old bit7 test hid looping samples!).
        out = {'slot': i,
               'empty': par['u32_10'] in (0, 0xFFFFFFFF)}
        if not out['empty']:
            raw = par['raw']
            # bipolar params are stored byte-centred at 0x40 in the blob (the
            # live message uses signed 14-bit; the app slider works in signed
            # model space, so send signed models here). Confirmed offsets:
            # 0x17 level, 0x18 pan, 0x19 semitone, 0x1a tune, 0x1b velo int.
            out.update(
                name=par['name'], long_name=par['long_name'],
                start=par['u32_0c'], end=par['u32_10'],
                level=raw[0x17], pan=raw[0x18],
                semitone=raw[0x19] - 0x40, tune=raw[0x1a],  # tune = wire 0..127
                velo_int=raw[0x1b] - 0x40,
                decay=raw[0x14], release=raw[0x15],
                loop=par['loop'], reverse=par['reverse'],
                bpm_sync=par['bpm_sync'], fx_sw=par['fx_sw'],
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

    def rename(self, slot, name, long_name):
        """Rename a sample: fetch the CURRENT param blob (func 0x14,
        session-safe), patch name[0:8] (space-padded) + long name
        [0x20:0x40] (UTF-8 <=32B, 0xFF-padded), send func 0x44."""
        with self.lock:
            self._inquire()
            par = DL.fetch_params(self.ms, self.channel, slot)
            blob = bytearray(par['raw'])
            blob[0:8] = name[:8].ljust(8).encode('latin1', 'replace')
            ln = (long_name or name).encode('utf-8')[:32]
            blob[0x20:0x40] = ln.ljust(32, b'\xff')
            self.ms.send_sysex(P.sample_param_send(self.channel, slot,
                                                   bytes(blob)))
            DL._wait_korg_reply(self.ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                                what='param write ACK (func 0x44)')
        return {'slot': slot, 'name': name[:8].strip(),
                'long_name': (long_name or name)[:32]}

    def sample_params(self, slot):
        """Diagnostic: fetch a sample's raw 64-byte param blob (standalone
        func 0x14, session-safe). Use THIS instead of `msusb.py params` for
        repeated dumps — one-shot CLI sessions wedge the device's TX FIFO
        (nothing drains the clock stream after exit); the bridge's reader
        keeps draining."""
        with self.lock:
            self._inquire()
            par = DL.fetch_params(self.ms, self.channel, slot)
        return {'slot': slot, 'name': par['name'],
                'raw': par['raw'].hex(), 'flags8': par['flags8'],
                'empty': par['u32_10'] in (0, 0xFFFFFFFF),
                'loop': par['loop'], 'reverse': par['reverse'],
                'bpm_sync': par['bpm_sync'], 'fx_sw': par['fx_sw']}

    def set_points(self, slot, start, end):
        """Set START/END points. These are u32 frame counts — they don't fit a
        live 0x41 value (14-bit), and the editor binary's id converter refuses
        them — so (like the original) they go via the 64-byte param blob:
        fetch the CURRENT blob (func 0x14, session-safe — does not open or
        close a select session), patch the two u32s, send it back (func 0x44).
        Fetching first means panel edits made since the bank read survive."""
        with self.lock:
            self._inquire()
            par = DL.fetch_params(self.ms, self.channel, slot)
            blob = bytearray(par['raw'])
            blob[0x0c:0x10] = int(start).to_bytes(4, 'little')
            blob[0x10:0x14] = int(end).to_bytes(4, 'little')
            self.ms.send_sysex(P.sample_param_send(self.channel, slot,
                                                   bytes(blob)))
            DL._wait_korg_reply(self.ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                                what='param write ACK (func 0x44)')
        return {'slot': slot, 'start': int(start), 'end': int(end)}


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
        # stateful effect for UI dev: Filter w/ a few non-default bytes
        self._effect = {'type': 2, 'knobs': [2, 3],
                        'params': [100, 2, 63, 20, 64, 0, 30, 1, 20, 2,
                                   0, 0, 0, 0] + [0] * 18}
        self._bank_name = 'MOCKBANK'
        self._bank_bpm = 120.0

    def open(self):
        pass

    def close(self):
        pass

    def status(self):
        return {'connected': True, 'inquiry': self.inquiry, 'mock': True}

    def play_note(self, slot, on, velocity=100):
        self._last_note = (int(slot), bool(on), int(velocity))

    def copy_sample(self, frm, to):
        import copy as _c
        if frm in self._slots:
            self._slots[to] = _c.deepcopy(self._slots[frm])
        else:
            self._slots.pop(to, None)
        return {'slot': to, 'empty': frm not in self._slots}

    def swap_samples(self, a, b):
        sa, sb = self._slots.get(a), self._slots.get(b)
        if sb is not None: self._slots[a] = sb
        else: self._slots.pop(a, None)
        if sa is not None: self._slots[b] = sa
        else: self._slots.pop(b, None)
        return {'a': a, 'b': b}

    def clear_sample(self, slot):
        self._slots.pop(slot, None)
        return {'slot': slot, 'empty': True}

    def set_effect(self, fx_type, knobs, params):
        self._effect = {'type': int(fx_type), 'knobs': [int(k) for k in knobs],
                        'params': [int(v) for v in params]}
        return {'type': int(fx_type)}

    def set_bank_settings(self, name, bpm):
        self._bank_name = name[:8].strip()
        self._bank_bpm = round(bpm, 1)
        return {'name': self._bank_name, 'bpm': self._bank_bpm}

    def send_param(self, obj, param, value):
        # bank object 0: name chars (params 0..7) + BPM*10 (param 16)
        if obj == 0:
            if param == 16:
                self._bank_bpm = value / 10.0
            elif 0 <= param <= 7:
                n = list(self._bank_name.ljust(8))
                n[param] = chr(value & 0x7f)
                self._bank_name = ''.join(n).rstrip()
            return
        # keep the mock's effect state live so the page round-trips in UI dev
        if obj == 80:
            e = self._effect
            sval = value - 16384 if value >= 8192 else value   # signed-14
            if param == 1:
                e['type'] = sval
                e['params'] = [0] * 32          # device re-inits on type change
            elif param in (2, 3):
                e['knobs'][param - 2] = sval
            elif 16 <= param <= 47:
                e['params'][param - 16] = sval & 0xff

    def _inquire(self):
        pass

    def _mock_patterns(self):
        if self.pattern_cache:
            return
        for q in range(16):
            blob = bytearray(P.build_init_pattern())
            blob[0x1e0] = q % 3                       # sample assignment
            if q == 0:                                # one "recorded" pattern
                blob[0x1e8:0x1f0] = b'MOCKPTRN'
                ev = bytearray()
                for bar in range(4):
                    ev += bytes([0xff, bar, 0, 0])
                    ev += bytes([0x91, 64 + bar * 3, 90, 0])   # kbd-track note
                    for step in range(4):             # four quarter hits/bar
                        note = 48 + (bar * 4 + step) % 12
                        ev += bytes([0x90, note, 100 - step * 8, 0])
                        ev += bytes([0xf0, 0, 0, 48])
                        ev += bytes([0x80, note, 0, 0])
                        ev += bytes([0xf0, 0, 0, 48])
                    ev += bytes([0x81, 64 + bar * 3, 0, 0])    # kbd note off
                ev += bytes([0xff, 4, 0, 0])
                blob[0x200:0x200 + len(ev)] = ev
            self.pattern_cache[q] = bytes(blob)

    def patterns_summary(self):
        self._mock_patterns()
        for q in range(16):                       # emit progress like real HW
            self._emit({'type': 'progress', 'op': 'patterns',
                        'done': q, 'total': 16})
            time.sleep(.03)
        self._emit({'type': 'progress', 'op': 'patterns', 'done': 16, 'total': 16})
        return {'patterns': [_pattern_json(q, self.pattern_cache[q])
                             for q in range(16)]}

    def pattern_mid(self, q):
        self._mock_patterns()
        return P.pattern_to_smf(self.pattern_cache[q])

    def pattern_write(self, q, blob):
        self._mock_patterns()
        self.pattern_cache[q] = blob
        return _pattern_json(q, blob)

    def start_backup(self):
        os.makedirs(BACKUP_ROOT, exist_ok=True)
        label = time.strftime('%Y%m%d-%H%M%S') + '-mock'
        out = os.path.join(BACKUP_ROOT, label)

        def fake(log):
            os.makedirs(out, exist_ok=True)
            manifest = {'name': 'MOCKBANK', 'bpm': 120.0,
                        'samples': [{'slot': i, 'empty': i not in self._slots,
                                     'name': self._slots.get(i, {}).get('name')}
                                    for i in range(36)],
                        'sequences': [{'pattern': q, 'empty': q > 3, 'size': 1308}
                                      for q in range(16)]}
            log("bank 'MOCKBANK'  BPM 120.0")
            for i, s in self._slots.items():
                time.sleep(.25)
                log("  s%02d: '%s' %d bytes" % (i, s['name'], len(s['pcm'])))
            with open(os.path.join(out, 'manifest.json'), 'w') as f:
                json.dump(manifest, f)
            log('backup complete: %d samples -> %s/' % (len(self._slots), label))

        self.start_op('backup', fake)
        return {'dir': label}

    def start_restore(self, dirname, bank):
        src = backup_dir(dirname)
        if not os.path.isfile(os.path.join(src, 'manifest.json')):
            raise RuntimeError('unknown backup: %s' % dirname)

        def fake(log):
            log("bank blob ACKed ('MOCKBANK')")
            for i in range(3):
                time.sleep(.3)
                log('  s%02d: restored' % i)
            log('restore complete -> %s'
                % ('current bank (RAM)' if bank is None else 'user bank %d' % (bank + 1)))

        self.start_op('restore', fake)
        return {'dir': dirname, 'target': 'current' if bank is None else bank + 1}

    def bank_summary(self):
        slots = []
        for i in range(36):
            s = self._slots.get(i)
            if not s:
                slots.append({'slot': i, 'empty': True})
                continue
            frames = len(s['pcm']) // 2
            start, end = s.get('points', (0, frames - 2))
            # NB: like the real bank summary, do NOT include rate/stereo/
            # frames/seconds — those aren't in the bank blob and only become
            # known once a sample's WAV is loaded (so the meter starts
            # estimated and LOAD ALL is offered, matching hardware).
            slots.append({'slot': i, 'empty': False, 'name': s['name'],
                          'long_name': s['name'].title(), 'tempo_bpm': s['tempo'],
                          'start': start, 'end': end, 'level': 101,
                          'pan': 64, 'semitone': i, 'tune': 64, 'velo_int': 0,
                          'decay': 127, 'release': 0, 'fx_sw': i == 0,
                          'loop': i == 1, 'reverse': False, 'bpm_sync': 0})
        return {'name': self._bank_name, 'bpm': self._bank_bpm,
                'slots': slots,
                'effect': {'type': self._effect['type'],
                           'knobs': list(self._effect['knobs']),
                           'params': list(self._effect['params'])},
                'seq_lengths': [4] * 16}

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

    def set_points(self, slot, start, end):
        s = self._slots.get(slot)
        if not s:
            raise RuntimeError('slot is empty')
        s['points'] = (int(start), int(end))
        return {'slot': slot, 'start': int(start), 'end': int(end)}

    def rename(self, slot, name, long_name):
        s = self._slots.get(slot)
        if not s:
            raise RuntimeError('slot is empty')
        s['name'] = name[:8].strip()
        return {'slot': slot, 'name': s['name'],
                'long_name': (long_name or name)[:32]}

    def sample_params(self, slot):
        s = self._slots.get(slot)
        blob = bytearray([0xff]) * 64 if not s else bytearray(64)
        if s:
            blob[0:8] = s['name'][:8].ljust(8).encode('latin1')
        return {'slot': slot, 'name': s['name'] if s else '',
                'raw': bytes(blob).hex(), 'flags8': blob[8],
                'empty': not s,
                'loop': slot == 1, 'reverse': False,   # mirror bank_summary
                'bpm_sync': 0, 'fx_sw': slot == 0}


def _pattern_json(q, blob):
    p = P.parse_pattern(blob) if blob else None
    if p is None:
        return {'pattern': q, 'valid': False}
    smp = sum(1 for n in p['notes'] if n[1] == 0)
    return {
        'pattern': q, 'valid': True,
        'name': p['name'], 'sample': p['sample'],
        'bars': p['bars'], 'spec_bars': p['spec_bars'],
        'ticks': p['ticks'], 'note_count': len(p['notes']),
        'smp_notes': smp,                    # ch bit0=0: sample-mode track
        'kbd_notes': len(p['notes']) - smp,  # ch bit0=1: keyboard-mode track
        # compact note list for the mini preview: [tick, ch, note, vel, dur]
        'notes': [list(n) for n in p['notes'][:199]],
    }


def backup_dir(dirname):
    """Resolve a backup name (arrives in an HTTP body — untrusted) to a
    directory STRICTLY inside BACKUP_ROOT. Allowlist the characters, reject
    dot-names, and verify realpath containment (also defuses symlinks). The
    realpath + `startswith(root + os.sep)` prefix guard is the form static
    analysis recognises as a path-traversal sanitizer."""
    name = str(dirname)
    if not re.match(r'^[A-Za-z0-9._-]+$', name) or name.strip('.') == '':
        raise RuntimeError('invalid backup name: %r' % dirname)
    root = os.path.realpath(BACKUP_ROOT)
    src = os.path.realpath(os.path.join(root, name))
    # contained inside BACKUP_ROOT AND a direct child (no deeper nesting)
    if not src.startswith(root + os.sep) or os.path.dirname(src) != root:
        raise RuntimeError('invalid backup name: %r' % dirname)
    return src


def backup_zip(name):
    """Zip a backup directory into memory for download. `name` is validated
    by backup_dir() (untrusted HTTP input)."""
    import zipfile
    src = backup_dir(name)
    if not os.path.isdir(src):
        raise RuntimeError('unknown backup: %s' % name)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(src):
            for f in files:
                full = os.path.join(root, f)
                z.write(full, os.path.join(name, os.path.relpath(full, src)))
    return buf.getvalue()


def import_backup_zip(data):
    """Unpack an uploaded backup .zip into a fresh BACKUP_ROOT/<name>.
    Zip-slip safe (every member must stay inside the target) and validated
    (must carry a manifest.json). Returns the new directory name."""
    import zipfile
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist() if not n.endswith('/')]
        if not any(n.endswith('manifest.json') for n in names):
            raise RuntimeError('not a backup zip (no manifest.json)')
        # derive a name: the zip's common top folder, else a timestamp
        tops = {n.split('/', 1)[0] for n in names if '/' in n}
        base = tops.pop() if len(tops) == 1 else 'import'
        dest = backup_dir(base)
        n = 1
        while os.path.exists(dest):
            dest = backup_dir('%s-%d' % (base, n)); n += 1
        root = os.path.realpath(dest) + os.sep
        for member in names:
            out = os.path.realpath(os.path.join(dest, os.path.relpath(
                member, base) if member.startswith(base + '/') else member))
            if not out.startswith(root):
                raise RuntimeError('unsafe path in zip: %r' % member)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(member) as fsrc, open(out, 'wb') as fdst:
                fdst.write(fsrc.read())
    return os.path.basename(dest)


def list_backups():
    out = []
    if os.path.isdir(BACKUP_ROOT):
        for d in sorted(os.listdir(BACKUP_ROOT), reverse=True):
            mf = os.path.join(BACKUP_ROOT, d, 'manifest.json')
            if not os.path.isfile(mf):
                continue
            try:
                with open(mf) as f:
                    m = json.load(f)
            except Exception:
                continue
            out.append({
                'dir': d, 'name': m.get('name', '?'), 'bpm': m.get('bpm'),
                'samples': sum(1 for s in m.get('samples', []) if not s['empty']),
                'patterns': sum(1 for s in m.get('sequences', []) if not s['empty']),
            })
    return out


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
            if path == '/api/backups':
                return self._json({'backups': list_backups()})
            m = re.match(r'^/api/backup/(.+)\.zip$', path)
            if m:
                return self._bytes(backup_zip(m.group(1)), 'application/zip')
            if path == '/api/op':
                return self._json(DEVICE.op_status())
            if path == '/api/patterns':
                return self._json(DEVICE.patterns_summary())
            m = re.match(r'^/api/pattern/(\d+)\.mid$', path)
            if m:
                q = int(m.group(1))
                if not 0 <= q <= 15:
                    return self._err('pattern 0..15', 400)
                data = DEVICE.pattern_mid(q)
                if data is None:
                    return self._err('pattern is empty', 404)
                return self._bytes(data, 'audio/midi')
            m = re.match(r'^/api/sample/(\d+)/params$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                return self._json(DEVICE.sample_params(slot))
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
            if path == '/api/bank/settings':
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                name = str(body.get('name', '')).strip()[:8]
                if not name or not all(0x20 <= ord(c) <= 0x7e for c in name):
                    return self._err('name: 1..8 printable ASCII chars', 400)
                bpm = float(body.get('bpm', 120))
                if not 20 <= bpm <= 300:
                    return self._err('bpm 20..300', 400)
                return self._json(DEVICE.set_bank_settings(name, bpm))
            if path in ('/api/sample/copy', '/api/sample/swap'):
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                if path.endswith('copy'):
                    frm, to = int(body['from']), int(body['to'])
                    if not (0 <= frm <= 35 and 0 <= to <= 35) or frm == to:
                        return self._err('need distinct slots 0..35', 400)
                    return self._json(DEVICE.copy_sample(frm, to))
                a, bb = int(body['a']), int(body['b'])
                if not (0 <= a <= 35 and 0 <= bb <= 35) or a == bb:
                    return self._err('need distinct slots 0..35', 400)
                return self._json(DEVICE.swap_samples(a, bb))
            m = re.match(r'^/api/sample/(\d+)/clear$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                return self._json(DEVICE.clear_sample(slot))
            if path == '/api/effect':
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                knobs = body.get('knobs', [0, 0])
                params = body.get('params', [])
                if len(params) != 32 or len(knobs) != 2:
                    return self._err('need knobs[2] + params[32]', 400)
                return self._json(DEVICE.set_effect(int(body['type']), knobs, params))
            if path == '/api/note':
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                slot = int(body['slot'])
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                DEVICE.play_note(slot, bool(body.get('on', True)),
                                 int(body.get('velocity', 100)))
                return self._json({'ok': True})
            if path == '/api/backup':
                return self._json(DEVICE.start_backup())
            if path == '/api/backup/import':
                n = int(self.headers.get('Content-Length', 0))
                name = import_backup_zip(self.rfile.read(n))
                return self._json({'dir': name})
            if path == '/api/restore':
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                bank = body.get('bank')          # null = current, 0..7 = user
                if bank is not None:
                    bank = int(bank)
                    if not 0 <= bank <= 7:
                        return self._err('bank must be null or 0..7', 400)
                return self._json(DEVICE.start_restore(str(body['dir']), bank))
            m = re.match(r'^/api/pattern/(\d+)(/init)?$', path)
            if m:
                q = int(m.group(1))
                if not 0 <= q <= 15:
                    return self._err('pattern 0..15', 400)
                if m.group(2):                       # /init: factory pattern,
                    old = DEVICE.pattern_cache.get(q)  # keep sample assignment
                    keep = P.parse_pattern(old)['sample'] if old else None
                    blob = bytearray(P.build_init_pattern())
                    blob[0x1e0] = 0xff if keep is None else keep
                    return self._json(DEVICE.pattern_write(q, bytes(blob)))
                n = int(self.headers.get('Content-Length', 0))
                smf = self.rfile.read(n)
                blob = P.smf_to_pattern(smf)
                return self._json(DEVICE.pattern_write(q, blob))
            m = re.match(r'^/api/sample/(\d+)/name$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                name = str(body.get('name', '')).strip()
                if not name:
                    return self._err('name required', 400)
                long_name = str(body.get('long_name', '')).strip() or None
                return self._json(DEVICE.rename(slot, name, long_name))
            m = re.match(r'^/api/sample/(\d+)/points$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                n = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(n) or b'{}')
                start, end = int(body['start']), int(body['end'])
                if not 0 <= start < end:
                    return self._err('need 0 <= start < end', 400)
                return self._json(DEVICE.set_points(slot, start, end))
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
        full = os.path.realpath(os.path.join(WEB_ROOT, path.lstrip('/')))
        root = os.path.realpath(WEB_ROOT)
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
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
