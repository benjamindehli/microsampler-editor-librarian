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
import copy
import io
import json
import math
import os
import queue
import re
import signal
import struct
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from urllib.parse import unquote

import protocol as P
from msusb import MicroSampler, from_usb_midi
import download as DL
import upload as UL


class DeviceGone(RuntimeError):
    """A device op was attempted while open() had failed (no USB device
    claimed) — mapped to HTTP 503 so the UI can tell 'not connected' from a
    bad request."""

VERSION = '1.14.1'   # current app version; kept in sync by tools/stamp-docs-version.mjs
# static root; MSMPL_WEB_ROOT overrides for the bundled app (PyInstaller datas)
WEB_ROOT = os.environ.get('MSMPL_WEB_ROOT') or \
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  '..', 'web-editor'))
# where bank backups live; override with MSMPL_BACKUP_DIR (e.g. an external drive)
BACKUP_ROOT = os.environ.get('MSMPL_BACKUP_DIR') or \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backups')
# the bundled app (no terminal to Ctrl+C) may enable POST /api/shutdown so the
# web UI can stop the bridge; advertised to the app via /api/status "shutdown"
ALLOW_SHUTDOWN = os.environ.get('MSMPL_ALLOW_SHUTDOWN') == '1'
SRV = None           # the running HTTP server (set in main; /api/shutdown stops it)
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
        self.open_error = None              # last device-open failure (for the UI)
        self.listeners = []                 # SSE queues
        self.reader_enabled = reader
        self.op = None                      # current/last backup or restore
        self.op_lock = threading.Lock()     # start_op check-then-set atomicity
        self.pattern_cache = {}             # q -> raw 1308B blob
        self._stop = threading.Event()
        self._reader = None
        self._clock_stop = None             # threading.Event while sending MIDI clock

    # -- lifecycle ----------------------------------------------------------
    def open(self):
        with self.lock:
            if self.ms:
                return
            def _fresh_ms():
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
                return ms

            def _inquire(ms):
                # A prior bridge that exited abruptly (closing the Terminal
                # window sends SIGHUP, not a clean shutdown) leaves the device
                # streaming MIDI clock into a pipe nobody drained — so a single
                # un-drained inquiry reads stale bytes and times out, even though
                # the device is fine. Drain first, and retry a few times.
                for _ in range(3):
                    DL._drain(ms, ms_quiet=300)
                    reply, cable = ms.device_inquiry()
                    if reply:
                        return reply, cable
                return None, None

            ms = _fresh_ms()
            reply, cable = _inquire(ms)
            if not reply:
                # Last-resort recovery: a USB port reset re-enumerates the device
                # and clears a stuck endpoint, so an intermittently wedged device
                # often comes back WITHOUT a physical power-cycle. Only runs once
                # the drained retries above have failed, so the normal open path
                # is untouched. A deeper wedge can need a SECOND reset and a
                # longer settle for macOS to finish re-enumerating; some still
                # need a real power-cycle (the firmware, not USB, is stuck) — the
                # final message says so. Reset invalidates the handle → reopen.
                for settle in (0.7, 1.5):
                    try:
                        ms.dev.reset()
                    except Exception:
                        pass
                    try:
                        ms.close()
                    except Exception:
                        pass
                    time.sleep(settle)               # let macOS re-enumerate
                    try:
                        ms = _fresh_ms()
                    except Exception:
                        continue                     # not back yet — wait longer
                    DL._drain(ms, ms_quiet=800)      # clear a larger backlog
                    reply, cable = _inquire(ms)
                    if reply:
                        break
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
        self._stop_clock()
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
                self._scan_notes(midi)
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

    def _scan_notes(self, midi):
        """Forward SAMPLE-mode note-ons (note = 48 + slot on the global channel,
        the inverse of play_note) as SSE 'note' events so the app can follow the
        last-triggered sample. Emits ALL of them — the app gates this behind its
        FOLLOW toggle (on → manual plays AND pattern playback, app- or device-
        driven, move the selection; off → nothing follows). Device-panel pattern
        notes are indistinguishable from manual pad notes at the MIDI level
        (same channel, the device streams clock continuously as master and sends
        no Start), so the toggle is the only control. Note-offs, velocity-0,
        off-range and keyboard-channel notes are ignored. Flat scan like
        _scan_cc (status bytes can't occur inside a 7-bit SysEx body)."""
        i, n = 0, len(midi)
        while i < n:
            hi = midi[i] & 0xf0
            if hi in (0x90, 0x80) and i + 2 < n \
                    and midi[i + 1] < 0x80 and midi[i + 2] < 0x80:
                if hi == 0x90 and (midi[i] & 0x0f) == (self.channel & 0x0f):
                    note, vel = midi[i + 1], midi[i + 2]
                    if vel > 0 and 48 <= note <= 83:        # 48..83 -> slot 0..35
                        self._emit({'type': 'note', 'slot': note - 48,
                                    'note': note, 'velocity': vel})
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
        with self.op_lock:                  # atomic check-then-set: two racing
            if self.op and not self.op['done']:   # POSTs can't both start
                raise RuntimeError('another operation is already running')
            self.op = op = {'name': name, 'lines': [], 'done': False, 'ok': None}

        def run():                          # writes ITS op dict, not self.op —
            ok = False                      # which a later op may have replaced
            try:
                with self.lock:
                    self._inquire()
                    fn(self.op_log)
                ok = True
            except Exception as e:
                traceback.print_exc()
                self.op_log('ERROR: %s' % e)
            finally:
                op['ok'] = ok
                op['done'] = True
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
        # the device answers dump requests with err 0x29 while its sequencer is
        # playing — stop it (no-op if idle) and let it settle before the dump
        self.stop_pattern()
        time.sleep(0.06)
        with self.lock:
            self._inquire()
            out = []
            try:
                for q in range(16):
                    # progress over SSE — the GET blocks until all 16 are read,
                    # but the event stream (separate thread) delivers these live
                    self._emit({'type': 'progress', 'op': 'patterns',
                                'done': q, 'total': 16})
                    blob = fetch_sequence(self.ms, self.channel, q)
                    self.pattern_cache[q] = blob
                    out.append(_pattern_json(q, blob))
            except Exception:
                self._abort_dump()   # a failed 0x13 select may be left open
                raise
            self._emit({'type': 'progress', 'op': 'patterns',
                        'done': 16, 'total': 16})
        return {'patterns': out}

    def pattern_mid(self, q):
        blob = self.pattern_cache.get(q)
        if blob is None:
            from bank import fetch_sequence
            with self.lock:
                self._inquire()
                try:
                    blob = fetch_sequence(self.ms, self.channel, q)
                except Exception:
                    self._abort_dump()   # a failed 0x13 select may be left open
                    raise
                self.pattern_cache[q] = blob
        if not blob:
            return None
        return P.pattern_to_smf(blob)

    def pattern_write(self, q, blob):
        """Write a pattern blob (standalone SequenceWrite flow), update cache."""
        from bank import send_sequence
        # the device errs 0x29 on a write while its sequencer is playing (same as
        # the dumps) — stop it (no-op if idle) and let it settle first
        self.stop_pattern()
        time.sleep(0.06)
        with self.lock:
            self._inquire()
            try:
                send_sequence(self.ms, self.channel, q, blob)
            except Exception:
                self._abort_dump()   # a failed write session may be left open
                raise
            self.pattern_cache[q] = blob
        return _pattern_json(q, blob)

    def start_backup(self):
        import bank as BK
        os.makedirs(BACKUP_ROOT, exist_ok=True)
        _own_backups_to_invoker()    # if sudo: keep backups/ user-owned so a
        #                              non-root library bridge can write here too
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
                'mock': False, 'version': VERSION, 'error': self.open_error}

    def _require_device(self):
        """Every device op calls this (via _inquire or directly): when open()
        failed the bridge still serves, so ops must fail with a clear 503
        instead of an opaque NoneType AttributeError."""
        if self.ms is None:
            raise DeviceGone('device not connected%s — power-cycle it and '
                             'press RETRY' % (' (%s)' % self.open_error
                                              if self.open_error else ''))

    def _inquire(self):
        """Fresh Device Inquiry — the original editor opens EVERY session with
        one (DeviceInquiry at the top of each UsbSession::process); the device
        refuses dump-mode requests (func 0x29) without it. Caller holds lock."""
        self._require_device()
        reply, _ = self.ms.device_inquiry(timeout_ms=2000, cables=(self.cable,))
        if not reply:
            raise RuntimeError('device inquiry failed — device off or wedged '
                               '(power-cycle it)')
        self.channel = reply[2] & 0x0f

    def send_param(self, obj, param, value):
        self._require_device()
        with self.lock:
            self.ms.send_sysex(P.parameter_change(self.channel, obj, param, value))

    def set_bank_settings(self, name, bpm):
        """Bank name + BPM in ONE lock acquisition (object 0: name chars as
        params 0..7, BPM*10 as param 16 — from EditBankParameterAction).
        Batched because 9 separate /api/param round-trips each contend with
        the background reader's lock cycle — user-visibly sluggish."""
        self._require_device()
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
                'mode_bit': hdr['mode_bit'], 'blob': par['raw']}

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
                          d['stereo'], d['blob'], d['tempo'],
                          mode_bit=d.get('mode_bit', 0))
        return {'slot': slot, 'empty': bool(d.get('empty'))}

    def copy_sample(self, frm, to):
        return self.write_sample(to, self.receive_sample(frm))

    def swap_samples(self, a, b):
        da, db = self.receive_sample(a), self.receive_sample(b)
        self.write_sample(b, da)
        self.write_sample(a, db)
        return {'a': a, 'b': b}

    def clear_sample(self, slot):
        """Empty a slot in the current bank (RAM) using two VERBATIM proven
        flows, each in its own inquired session (no novel intra-session
        ordering):
          1. 0-size header — frees the audio (the old clear; confirmed to free
             the data on hardware).
          2. the exact rename()/set_points() param-write — fetch the blob
             (func 0x14), blank the name + zero START/END, write back (func
             0x44). END==0 is the bank's emptiness marker (@0x10); the header
             alone leaves END/name stale, so the bank kept reporting the slot
             as a non-empty sample and the GUI showed the old name. The 0x44
             only lands when a func 0x14 fetch precedes it in the SAME clean
             session — which is why an earlier "header then 0x44" attempt
             didn't reset the param. Step 2 runs last so END=0 is the final
             state."""
        # 1. free the audio data (own session)
        self.write_sample(slot, {'empty': True})
        # 2. reset the param blob (own session, identical to rename())
        with self.lock:
            self._inquire()
            par = DL.fetch_params(self.ms, self.channel, slot)
            blob = bytearray(par['raw'])
            blob[0x00:0x08] = b'INITSMPL'                 # device init-slot name
            blob[0x20:0x40] = b'\xff' * 0x20              # clear long name
            blob[0x0c:0x14] = bytes(8)                    # START + END = 0
            self.ms.send_sysex(P.sample_param_send(self.channel, slot, bytes(blob)))
            DL._wait_korg_reply(self.ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                                what='clear param ACK (func 0x44)')
        return {'slot': slot, 'empty': True}

    def set_effect(self, fx_type, knobs, params):
        """Apply a whole effect preset in ONE lock grab (object 80): FX type
        (param 1) — the device re-inits its params on type change, so we then
        send the 2 knob assigns (params 2-3) + every effect param (16+i) to
        override. Batched for the same reason bank settings are (per-message
        round-trips contend the reader lock = sluggish)."""
        self._require_device()
        ch = self.channel
        with self.lock:
            self.ms.send_sysex(P.parameter_change(ch, 80, 1, int(fx_type)))
            for k in (0, 1):
                self.ms.send_sysex(P.parameter_change(ch, 80, 2 + k,
                                                      int(knobs[k])))
            for i, v in enumerate(params):
                self.ms.send_sysex(P.parameter_change(ch, 80, 16 + i, int(v)))
        return {'type': int(fx_type)}

    def play_note(self, slot, on, velocity=100, keyboard=False, note=None):
        """Trigger a note on the DEVICE via MIDI, cable 1. Two modes:
        - SAMPLE mode (keyboard=False): note 48 (C3) + slot on the global
          channel triggers that pad's sample (the numbering the pattern engine
          uses for sample-mode tracks).
        - KEYBOARD mode (keyboard=True): the note one channel above the global
          channel plays the device's currently SELECTED sample pitched (the
          microSAMPLER's keyboard-mode track sits on global channel + 1).
        `note` (0..127), when given, is the raw MIDI note to send (a real MIDI
        keyboard's full range in keyboard mode); otherwise it is 48 + slot."""
        self._require_device()
        n = max(0, min(127, int(note))) if note is not None else 48 + max(0, min(35, int(slot)))
        ch = (self.channel + (1 if keyboard else 0)) & 0x0f
        status = (0x90 if on else 0x80) | ch
        with self.lock:
            self.ms.send_short(status, n, max(1, min(127, int(velocity))),
                               cable=self.cable)

    def pitch_bend(self, value, keyboard=True):
        """Pitch bend (En bb mm, ±1 octave on the device) — keyboard-mode only,
        so it is sent on the keyboard channel (global + 1) by default. 14-bit
        value 0..16383, centre 8192 (no bend)."""
        self._require_device()
        value = max(0, min(16383, int(value)))
        ch = (self.channel + (1 if keyboard else 0)) & 0x0f
        with self.lock:
            self.ms.send_short(0xE0 | ch, value & 0x7f, (value >> 7) & 0x7f,
                               cable=self.cable)

    def _stop_clock(self):
        if self._clock_stop:
            self._clock_stop.set()
            self._clock_stop = None

    def _start_clock(self, bpm):
        """Stream MIDI Timing Clock (0xF8) at 24 PPQN for `bpm` in a background
        thread until stopped. The device's sequencer is a SLAVE under external
        transport — Start only sets it running; the clock is what advances it
        (so without this, Start does nothing). The device must have GLOBAL >
        MIDI CLK = AUTO or EXT MIDI to follow it."""
        self._stop_clock()
        bpm = max(20.0, min(300.0, float(bpm)))
        interval = 60.0 / (bpm * 24)
        ev = threading.Event()
        self._clock_stop = ev

        def run():
            nxt = time.monotonic()
            while not ev.is_set():
                with self.lock:
                    if self.ms:
                        try:
                            self.ms.send_short(0xF8, 0, 0, cable=self.cable)
                        except Exception:
                            return
                nxt += interval
                ev.wait(max(0, nxt - time.monotonic()))
        threading.Thread(target=run, daemon=True).start()

    def play_pattern(self, q, bpm=120):
        """Select a pattern + start the sequencer on the DEVICE. Owner's manual
        MIDI guide (p.45-46): select the [PATTERN] dial via NRPN
        [Bn 63 20, Bn 62 01, Bn 06 mm] on the GLOBAL channel; per the value
        table mm 0-7→pattern 1 … 120-127→pattern 16, so 0-based pattern q ⇒
        mm = q*8. Then stream MIDI clock (the sequencer is a slave — clock
        advances it) and send system-realtime Start (0xFA). send_short derives
        the USB-MIDI CIN automatically (0xB CC, 0xF single-byte real-time)."""
        self._require_device()
        mm = max(0, min(127, int(q) * 8))
        # Always STOP first: a pattern-select (NRPN) doesn't register while the
        # sequencer is running, and a Start during playback just restarts the
        # CURRENT pattern — so switching patterns mid-play would replay the old
        # one. Stop, let the device settle, then select + start the new one.
        self._stop_clock()
        with self.lock:
            self.ms.send_short(0xFC, 0, 0, cable=self.cable)        # MIDI Stop
        time.sleep(0.06)                                        # let the stop land
        self._nrpn(0x01, mm)                                    # select [PATTERN] dial
        self._start_clock(bpm)                                  # advance the slave seq
        time.sleep(0.03)                                        # let AUTO switch to EXT
        with self.lock:
            self.ms.send_short(0xFA, 0, 0, cable=self.cable)        # MIDI Start
        return {'pattern': int(q), 'playing': True}

    def stop_pattern(self):
        """Stop sequencer playback on the DEVICE (MIDI Stop, 0xFC) + stop clock."""
        self._require_device()
        self._stop_clock()
        with self.lock:
            self.ms.send_short(0xFC, 0, 0, cable=self.cable)        # MIDI Stop
        return {'playing': False}

    def set_master_volume(self, value):
        """Set the device's overall output via the Universal Real-Time Master
        Volume SysEx [F0 7F 7F 04 01 vv mm F7] (owner's manual p.46) — 14-bit,
        mm = MSB, max when both 7F. `value` is a 0..127 slider position."""
        self._require_device()
        v = max(0, min(127, int(value)))
        v14 = round(v / 127 * 0x3FFF)
        with self.lock:
            self.ms.send_sysex(bytes([0xF0, 0x7F, 0x7F, 0x04, 0x01,
                                      v14 & 0x7F, (v14 >> 7) & 0x7F, 0xF7]))
        return {'value': v}

    def panic(self):
        """All-sound-off safety net for stuck notes / runaway playback: All
        Sound Off (CC#120) + All Note Off (CC#123) on the global channel, MIDI
        Stop, and our clock off. (Manual lists CC#120/123 for exactly this.)"""
        self._require_device()
        self._stop_clock()
        cc = 0xB0 | (self.channel & 0x0f)
        with self.lock:
            self.ms.send_short(cc, 0x78, 0, cable=self.cable)   # All Sound Off
            self.ms.send_short(cc, 0x7B, 0, cable=self.cable)   # All Note Off
            self.ms.send_short(cc, 0x79, 0, cable=self.cable)   # Reset All Controllers
            self.ms.send_short(0xFC, 0, 0, cable=self.cable)    # MIDI Stop
        return {'ok': True}

    def _nrpn(self, lsb, data):
        """Send one NRPN on the global channel: MSB 0x20, given LSB, data (CC#06).
        The device's panel buttons/dials are addressed this way (manual p.46)."""
        self._require_device()
        cc = 0xB0 | (self.channel & 0x0f)
        with self.lock:
            self.ms.send_short(cc, 0x63, 0x20, cable=self.cable)    # NRPN MSB
            self.ms.send_short(cc, 0x62, lsb & 0x7f, cable=self.cable)
            self.ms.send_short(cc, 0x06, data & 0x7f, cable=self.cable)  # data MSB

    def sampling_button(self):
        """'Press' the device's [SAMPLING] button (NRPN LSB 0x11, data 127). Like
        the panel button it cycles SETUP/STANDBY → SAMPLING → SAMPLING END; the
        device has no readback, so the app just sends presses. EXPERIMENTAL."""
        self._nrpn(0x11, 127)
        return {'ok': True}

    def set_input_source(self, resample):
        """[INPUT SELECT] NRPN (LSB 0x12): 0..63 = AUDIO IN, 64..127 = RE-SAMPLE."""
        self._nrpn(0x12, 127 if resample else 0)
        return {'resample': bool(resample)}

    def rec_button(self):
        """'Press' the device's [REC] button (NRPN LSB 0x02, data 127, manual
        p.46). Like the panel button it cycles SETUP/REC STANDBY → REC → REC END
        into the device's current pattern; no readback, so the app just sends
        presses and the device screen is the only state indicator."""
        self._nrpn(0x02, 127)
        return {'ok': True}

    def bank_summary(self):
        """Bank blob only, then leave dump mode. NO per-slot header requests:
        func 0x16 opens a dump session that ONLY a data dump (0x1F) closes
        (hardware-traced 2026-06-05; the 0x14 param request does NOT close it
        — the original's Target=1 flow is dead code). Rate/length are filled
        in lazily by the client from the WAV when a sample is downloaded."""
        # dumps fail with err 0x29 while the sequencer plays — stop it first
        self.stop_pattern()
        time.sleep(0.06)
        with self.lock:
            self._inquire()
            try:
                bank = self._fetch_bank_blob()
            except Exception:
                # the 0x10 request may have opened a dump session before the
                # failure (timeout / garbled reply) — abort so the device
                # isn't stranded needing a power-cycle
                self._abort_dump()
                raise
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

    def _abort_dump(self):
        """Best-effort leave-dump (abort, no commit) after a mid-dump failure —
        the device may be stranded in a select/dump session that otherwise
        needs a power-cycle. Caller holds the lock; swallows every error
        (this only ever runs on an already-failing path)."""
        try:
            self._leave_dump(commit=False)
        except Exception:
            pass

    def download_wav(self, slot):
        """-> (wav_bytes, orig_tempo_bpm) or (None, None) when empty. The orig
        BPM rides the header (not the bank blob) so the GUI can surface it (BPM
        chip + playhead speed for BPM-synced samples)."""
        with self.lock:
            self._inquire()
            hdr = DL.fetch_header(self.ms, self.channel, slot)
            if hdr['data_size'] == 0:
                return None, None
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
        return buf.getvalue(), hdr['tempo_bpm']

    def upload_wav(self, slot, wav_bytes, name, tempo):
        chans, rate = UL.load_wav(io.BytesIO(wav_bytes))
        target = min(UL.RATES, key=lambda r: abs(r - rate))
        pcm, frames = UL.to_device_pcm(chans, rate, target)
        blob = P.build_param_blob(name, name, 0, frames)
        with self.lock:
            self._inquire()
            UL.upload(self.ms, self.channel, slot, pcm, target,
                      len(chans) == 2, blob, tempo)
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

    def set_tempo(self, slot, bpm):
        """Set a sample's ORIGINAL BPM (sample tempo). It lives ONLY in the
        8-byte upload header — there is no live 0x41 param for it and it is not
        in the 64-byte param blob — so the only way to change it on an existing
        sample is to RE-UPLOAD it (exactly what the original editor did: it
        flagged the sample and re-transmitted on TRANSMIT). We round-trip the
        same audio + param blob through the proven receive/write flows (each its
        own inquired session, like copy_sample) and change only the header
        tempo, so START/END/name/knobs (incl. any panel edits) are preserved."""
        bpm = max(20.0, min(300.0, float(bpm)))
        d = self.receive_sample(slot)
        if d.get('empty'):
            raise RuntimeError('slot is empty')
        d['tempo'] = bpm
        self.write_sample(slot, d)
        return {'slot': slot, 'tempo_bpm': round(bpm, 1)}


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
        return {'connected': True, 'inquiry': self.inquiry, 'mock': True,
                'version': VERSION, 'error': self.open_error}

    def play_note(self, slot, on, velocity=100, keyboard=False, note=None):
        self._last_note = (int(slot), bool(on), int(velocity), bool(keyboard), note)

    def pitch_bend(self, value, keyboard=True):
        self._last_bend = (int(value), bool(keyboard))

    def play_pattern(self, q, bpm=120):
        self._transport = ('play', int(q), float(bpm))
        return {'pattern': int(q), 'playing': True}

    def stop_pattern(self):
        self._transport = ('stop', None)
        return {'playing': False}

    def set_master_volume(self, value):
        return {'value': max(0, min(127, int(value)))}

    def sampling_button(self):
        return {'ok': True}

    def rec_button(self):
        return {'ok': True}

    def set_input_source(self, resample):
        return {'resample': bool(resample)}

    def panic(self):
        return {'ok': True}

    def copy_sample(self, frm, to):
        if frm in self._slots:
            self._slots[to] = copy.deepcopy(self._slots[frm])
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
            os.makedirs(os.path.join(out, 'samples'), exist_ok=True)
            log("bank 'MOCKBANK'  BPM 120.0")
            samples = []
            for i in range(36):
                s = self._slots.get(i)
                if not s:
                    samples.append({'slot': i, 'empty': True, 'name': None})
                    continue
                wav, tempo = self.download_wav(i)          # real WAV per slot
                with open(os.path.join(out, 'samples', 's%02d.wav' % i), 'wb') as f:
                    f.write(wav)
                samples.append({'slot': i, 'empty': False, 'name': s['name'],
                                'rate_hz': s['rate'], 'stereo': s['stereo'],
                                'tempo_bpm': tempo})
                time.sleep(.1)
                log("  s%02d: '%s' %d bytes" % (i, s['name'], len(s['pcm'])))
            manifest = {'name': 'MOCKBANK', 'bpm': 120.0, 'samples': samples,
                        'sequences': [{'pattern': q, 'empty': q > 3, 'size': 1308}
                                      for q in range(16)]}
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
                # empty patterns store 0xFF (init fill) like the real device,
                # so the meter must treat 0xFF as 0; here 4 recorded patterns.
                'seq_lengths': [4, 4, 4, 4] + [0xFF] * 12}

    def download_wav(self, slot):
        s = self._slots.get(slot)
        if not s:
            return None, None
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(2 if s['stereo'] else 1)
            w.setsampwidth(2)
            w.setframerate(s['rate'])
            w.writeframes(s['pcm'])
        return buf.getvalue(), s.get('tempo')

    def upload_wav(self, slot, wav_bytes, name, tempo):
        chans, rate = UL.load_wav(io.BytesIO(wav_bytes))
        target = min(UL.RATES, key=lambda r: abs(r - rate))
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

    def set_tempo(self, slot, bpm):
        s = self._slots.get(slot)
        if not s:
            raise RuntimeError('slot is empty')
        s['tempo'] = max(20.0, min(300.0, float(bpm)))
        return {'slot': slot, 'tempo_bpm': round(s['tempo'], 1)}

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


class LibraryDevice(MockDevice):
    """Hardware-free LIBRARY mode (--library): no device, no fake bank — just the
    backup librarian (import original .msmpl_bank / our .zip, browse + play +
    download samples in the browser). Reuses MockDevice's op runner / SSE / no-op
    USB; status carries `library:true` so the app shows the library UI and hides
    all device-only features."""

    def __init__(self):
        super().__init__()
        self._slots = {}                               # no fake samples

    def status(self):
        return {'connected': True, 'library': True, 'mock': False,
                'version': VERSION, 'error': None}


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


def backup_sample_list(dirname):
    """Non-empty samples in a backup (for the cherry-pick picker). `dirname` is
    validated by backup_dir() (untrusted HTTP input)."""
    src = backup_dir(dirname)
    mf = os.path.join(src, 'manifest.json')
    if not os.path.isfile(mf):
        raise RuntimeError('unknown backup: %s' % dirname)
    with open(mf) as f:
        m = json.load(f)
    return [{'slot': s['slot'], 'name': s.get('name') or '?',
             'rate_hz': s.get('rate_hz'), 'stereo': s.get('stereo'),
             'tempo_bpm': s.get('tempo_bpm')}
            for s in m.get('samples', [])
            if not s.get('empty')
            and os.path.isfile(os.path.join(src, 'samples', 's%02d.wav' % s['slot']))]


def backup_sample_wav(dirname, frm):
    """(wav_bytes, name, tempo) for one non-empty sample in a backup."""
    if not 0 <= frm <= 35:
        raise RuntimeError('slot 0..35')
    src = backup_dir(dirname)
    wavpath = os.path.join(src, 'samples', 's%02d.wav' % frm)
    if not os.path.isfile(wavpath):
        raise RuntimeError('backup slot %d has no sample' % frm)
    with open(wavpath, 'rb') as f:
        wav = f.read()
    name, tempo = 'SAMPLE', 120.0
    try:
        with open(os.path.join(src, 'manifest.json')) as f:
            for s in json.load(f).get('samples', []):
                if s.get('slot') == frm and not s.get('empty'):
                    name = (s.get('name') or 'SAMPLE')[:8].upper()
                    tempo = float(s.get('tempo_bpm') or 120.0)
                    break
    except Exception:
        pass
    return wav, name, tempo


def backup_pattern_list(dirname):
    """Non-empty patterns in a backup (for the library pattern list)."""
    src = backup_dir(dirname)
    mf = os.path.join(src, 'manifest.json')
    if not os.path.isfile(mf):
        raise RuntimeError('unknown backup: %s' % dirname)
    with open(mf) as f:
        m = json.load(f)
    return [{'pattern': s['pattern'], 'name': s.get('name') or '',
             'note_count': s.get('note_count')}
            for s in m.get('sequences', [])
            if not s.get('empty')
            and os.path.isfile(os.path.join(src, 'sequences', 'q%02d.bin' % s['pattern']))]


def backup_pattern_smf(dirname, q):
    """A Standard MIDI File for one backup pattern (raw SEQP blob → SMF)."""
    if not 0 <= q <= 15:
        raise RuntimeError('pattern 0..15')
    path = os.path.join(backup_dir(dirname), 'sequences', 'q%02d.bin' % q)
    if not os.path.isfile(path):
        raise RuntimeError('pattern %d not in this backup' % q)
    import protocol as P
    with open(path, 'rb') as f:
        mid = P.pattern_to_smf(f.read())
    if not mid:
        raise RuntimeError('pattern %d is empty' % q)
    return mid


def backup_patterns_zip(dirname):
    """All non-empty patterns of a backup, zipped as .mid files."""
    import zipfile

    import protocol as P
    src = backup_dir(dirname)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in backup_pattern_list(dirname):
            with open(os.path.join(src, 'sequences', 'q%02d.bin' % p['pattern']), 'rb') as f:
                mid = P.pattern_to_smf(f.read())
            if not mid:
                continue
            nm = re.sub(r'[^A-Za-z0-9._-]+', '_', (p['name'] or '').strip()) or 'pattern'
            z.writestr('%02d_%s.mid' % (p['pattern'] + 1, nm), mid)
    return buf.getvalue()


def _check_backup_writable():
    """Friendly error when BACKUP_ROOT exists but isn't writable — happens when a
    sudo (device) run made it root-owned and a non-root (library) run now writes."""
    if os.path.isdir(BACKUP_ROOT) and not os.access(BACKUP_ROOT, os.W_OK):
        raise RuntimeError(
            'cannot write backups in %s — it is owned by another user (most '
            'likely root, from running the device bridge with sudo). Fix it once '
            'with:  sudo chown -R "$(id -un)" "%s"' % (BACKUP_ROOT, BACKUP_ROOT))


def _own_backups_to_invoker():
    """When running as root via sudo, hand BACKUP_ROOT back to the user who ran
    sudo, so non-root tools (library mode) can manage the backups. No-op unless
    running as root under sudo. Self-heals a backups/ left root-owned earlier."""
    uid = os.environ.get('SUDO_UID')
    if (not uid or not hasattr(os, 'geteuid') or os.geteuid() != 0
            or not os.path.isdir(BACKUP_ROOT)):
        return
    uid, gid = int(uid), int(os.environ.get('SUDO_GID', uid))
    try:
        for root, _dirs, files in os.walk(BACKUP_ROOT):
            os.chown(root, uid, gid)
            for f in files:
                os.chown(os.path.join(root, f), uid, gid)
    except OSError:
        pass


def import_backup_zip(data):
    """Unpack an uploaded backup .zip into a fresh BACKUP_ROOT/<name>.
    Zip-slip safe (every member must stay inside the target) and validated
    (must carry a manifest.json). Returns the new directory name."""
    import zipfile
    _check_backup_writable()
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise RuntimeError('not a zip file') from None   # client input → HTTP 400
    with zf as z:
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


def import_msmpl_bank(data):
    """Convert a Korg-original .msmpl_bank (raw bytes) into a backup directory,
    so it joins the librarian like any other backup. Returns the new dir name."""
    import msmpl_bank
    bank = msmpl_bank.parse_bank(data)               # validates (raises if not one)
    base = re.sub(r'[^A-Za-z0-9._-]', '', (bank['name'] or 'bank')) or 'bank'
    _check_backup_writable()
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    dest = backup_dir(base)                           # allowlist + containment guard
    n = 1
    while os.path.exists(dest):
        dest = backup_dir('%s-%d' % (base, n)); n += 1
    msmpl_bank.extract_bytes(data, dest)
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
            out.append({          # .get: a hand-edited manifest without the
                # 'empty' flags must not 500 the whole /api/backups listing
                'dir': d, 'name': m.get('name', '?'), 'bpm': m.get('bpm'),
                'samples': sum(1 for s in m.get('samples', [])
                               if not s.get('empty')),
                'patterns': sum(1 for s in m.get('sequences', [])
                                if not s.get('empty')),
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

    def _bytes(self, data, ctype, extra=None):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(data)

    def _err(self, msg, code=500):
        self._json({'error': str(msg)}, code)

    def _body(self):
        """The raw request body (Content-Length bytes)."""
        return self.rfile.read(int(self.headers.get('Content-Length', 0)))

    def _json_body(self):
        """The request body parsed as JSON ({} when empty)."""
        return json.loads(self._body() or b'{}')

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s  %s\n" % (time.strftime('%H:%M:%S'), fmt % args))

    # -- routing ---------------------------------------------------------------
    def do_GET(self):
        path = self.path.split('?')[0]
        try:
            if path == '/api/status':
                st = DEVICE.status()
                st['shutdown'] = ALLOW_SHUTDOWN   # UI shows QUIT when available
                return self._json(st)
            if path == '/api/bank':
                return self._json(DEVICE.bank_summary())
            if path == '/api/backups':
                return self._json({'backups': list_backups()})
            m = re.match(r'^/api/backup/([^/]+)\.zip$', path)   # whole-bank zip
            if m:
                return self._bytes(backup_zip(m.group(1)), 'application/zip')
            m = re.match(r'^/api/backup/(.+)/patterns\.zip$', path)
            if m:
                return self._bytes(backup_patterns_zip(m.group(1)), 'application/zip')
            m = re.match(r'^/api/backup/(.+)/samples$', path)
            if m:
                return self._json({'samples': backup_sample_list(m.group(1))})
            m = re.match(r'^/api/backup/(.+)/patterns$', path)
            if m:
                return self._json({'patterns': backup_pattern_list(m.group(1))})
            m = re.match(r'^/api/backup/(.+)/sample/(\d+)\.wav$', path)
            if m:
                wav, name, _tempo = backup_sample_wav(m.group(1), int(m.group(2)))
                return self._bytes(wav, 'audio/wav', {'X-Sample-Name': name})
            m = re.match(r'^/api/backup/(.+)/pattern/(\d+)\.mid$', path)
            if m:
                return self._bytes(backup_pattern_smf(m.group(1), int(m.group(2))),
                                   'audio/midi')
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
                data, tempo = DEVICE.download_wav(slot)
                if data is None:
                    return self._err('slot is empty', 404)
                extra = {'X-Sample-Tempo': tempo} if tempo else None
                return self._bytes(data, 'audio/wav', extra)
            if path == '/api/events':
                return self._sse()
            return self._static(path)
        except BrokenPipeError:
            pass
        except DeviceGone as e:
            self._err(e, 503)                 # bridge up, device unclaimed
        except RuntimeError as e:
            self._err(e, 400)                 # validation ('unknown backup'…)
        except Exception as e:          # surface everything to the browser + log
            traceback.print_exc()
            self._err(e)

    def do_POST(self):
        path, _, query = self.path.partition('?')
        # the app percent-encodes query values (encodeURIComponent) — decode,
        # or a sample named "MY KIT" lands on the device as literal "MY%20KIT"
        params = {k: unquote(v)
                  for k, v in (p.split('=', 1)
                               for p in query.split('&') if '=' in p)}
        try:
            if path == '/api/shutdown':      # bundled app: quit from the web UI
                if not (ALLOW_SHUTDOWN and SRV):
                    return self._err('not enabled', 404)
                self._json({'ok': True})     # answer first, THEN stop the server
                threading.Thread(target=SRV.shutdown, daemon=True).start()
                return
            if path == '/api/connect':       # (re)attempt to claim the device
                try:
                    DEVICE.open()
                    DEVICE.open_error = None
                except Exception as e:
                    DEVICE.open_error = str(e)
                return self._json(DEVICE.status())
            if path == '/api/param':
                body = self._json_body()
                DEVICE.send_param(int(body['obj']), int(body['param']),
                                  int(body['value']))
                return self._json({'ok': True})
            if path == '/api/bank/settings':
                body = self._json_body()
                name = str(body.get('name', '')).strip()[:8]
                if not name or not all(0x20 <= ord(c) <= 0x7e for c in name):
                    return self._err('name: 1..8 printable ASCII chars', 400)
                bpm = float(body.get('bpm', 120))
                if not 20 <= bpm <= 300:
                    return self._err('bpm 20..300', 400)
                return self._json(DEVICE.set_bank_settings(name, bpm))
            if path in ('/api/sample/copy', '/api/sample/swap'):
                body = self._json_body()
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
                body = self._json_body()
                knobs = body.get('knobs', [0, 0])
                params = body.get('params', [])
                if len(params) != 32 or len(knobs) != 2:
                    return self._err('need knobs[2] + params[32]', 400)
                return self._json(DEVICE.set_effect(int(body['type']), knobs, params))
            if path == '/api/note':
                body = self._json_body()
                note = body.get('note')      # raw MIDI note (keyboard-mode full range)
                slot = body.get('slot')
                if note is not None:
                    note = int(note)
                    if not 0 <= note <= 127:
                        return self._err('note 0..127', 400)
                elif slot is not None:
                    slot = int(slot)
                    if not 0 <= slot <= 35:
                        return self._err('slot 0..35', 400)
                else:
                    return self._err('need slot or note', 400)
                DEVICE.play_note(slot if slot is not None else 0,
                                 bool(body.get('on', True)),
                                 int(body.get('velocity', 100)),
                                 bool(body.get('keyboard', False)), note=note)
                return self._json({'ok': True})
            if path == '/api/pitch-bend':
                body = self._json_body()
                value = int(body.get('value', 8192))
                if not 0 <= value <= 16383:
                    return self._err('value 0..16383', 400)
                DEVICE.pitch_bend(value, bool(body.get('keyboard', True)))
                return self._json({'ok': True})
            if path == '/api/master-volume':
                body = self._json_body()
                try:
                    value = int(body.get('value', 127))
                except (TypeError, ValueError):
                    return self._err('value: integer 0..127', 400)
                return self._json(DEVICE.set_master_volume(value))
            if path == '/api/sampling/button':
                return self._json(DEVICE.sampling_button())
            if path == '/api/sampling/input':
                body = self._json_body()
                return self._json(DEVICE.set_input_source(bool(body.get('resample'))))
            if path == '/api/pattern/rec':
                return self._json(DEVICE.rec_button())
            if path == '/api/transport/stop':
                return self._json(DEVICE.stop_pattern())
            if path == '/api/panic':
                return self._json(DEVICE.panic())
            m = re.match(r'^/api/pattern/(\d+)/play$', path)
            if m:
                q = int(m.group(1))
                if not 0 <= q <= 15:
                    return self._err('pattern 0..15', 400)
                body = self._json_body()
                return self._json(DEVICE.play_pattern(q, float(body.get('bpm', 120))))
            if path == '/api/backup':
                return self._json(DEVICE.start_backup())
            if path == '/api/backup/import':
                name = import_backup_zip(self._body())
                return self._json({'dir': name})
            if path == '/api/backup/import-msmpl':       # original Korg .msmpl_bank
                name = import_msmpl_bank(self._body())
                return self._json({'dir': name})
            if path == '/api/restore':
                body = self._json_body()
                bank = body.get('bank')          # null = current, 0..7 = user
                if bank is not None:
                    bank = int(bank)
                    if not 0 <= bank <= 7:
                        return self._err('bank must be null or 0..7', 400)
                return self._json(DEVICE.start_restore(str(body['dir']), bank))
            m = re.match(r'^/api/backup/(.+)/restore-sample$', path)
            if m:
                body = self._json_body()
                to = int(body['to'])
                if not 0 <= to <= 35:
                    return self._err('slot 0..35', 400)
                wav, name, tempo = backup_sample_wav(m.group(1), int(body['from']))
                return self._json(DEVICE.upload_wav(to, wav, name, tempo))
            m = re.match(r'^/api/pattern/(\d+)(/init)?$', path)
            if m:
                q = int(m.group(1))
                if not 0 <= q <= 15:
                    return self._err('pattern 0..15', 400)
                if m.group(2):                       # /init: factory pattern,
                    old = DEVICE.pattern_cache.get(q)  # keep sample assignment
                    par = P.parse_pattern(old) if old else None   # None if the
                    keep = par['sample'] if par else None         # blob is invalid
                    blob = bytearray(P.build_init_pattern())
                    blob[0x1e0] = 0xff if keep is None else keep
                    return self._json(DEVICE.pattern_write(q, bytes(blob)))
                blob = P.smf_to_pattern(self._body())
                return self._json(DEVICE.pattern_write(q, blob))
            m = re.match(r'^/api/sample/(\d+)/name$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                body = self._json_body()
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
                body = self._json_body()
                start, end = int(body['start']), int(body['end'])
                if not 0 <= start < end:
                    return self._err('need 0 <= start < end', 400)
                return self._json(DEVICE.set_points(slot, start, end))
            m = re.match(r'^/api/sample/(\d+)/tempo$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                body = self._json_body()
                try:
                    bpm = float(body['bpm'])
                except (KeyError, TypeError, ValueError):
                    return self._err('bpm required', 400)
                if not 20.0 <= bpm <= 300.0:
                    return self._err('bpm 20..300', 400)
                return self._json(DEVICE.set_tempo(slot, bpm))
            m = re.match(r'^/api/sample/(\d+)$', path)
            if m:
                slot = int(m.group(1))
                if not 0 <= slot <= 35:
                    return self._err('slot 0..35', 400)
                wav = self._body()
                name = params.get('name', 'SAMPLE')[:8].upper()
                tempo = float(params.get('tempo', '120'))
                return self._json(DEVICE.upload_wav(slot, wav, name, tempo))
            return self._err('not found', 404)
        except BrokenPipeError:
            pass                              # client went away mid-request
        except DeviceGone as e:
            self._err(e, 503)                 # bridge up, device unclaimed
        except KeyError as e:                 # missing body field
            self._err('missing field %s' % e, 400)
        # client-input errors are 400s, not tracebacks: bad JSON / non-numeric
        # values (ValueError incl. JSONDecodeError, TypeError), and the device
        # methods' validation RuntimeErrors ('slot is empty', bad backup name…)
        except (ValueError, TypeError, RuntimeError) as e:
            self._err(e, 400)
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
    ap.add_argument('--port', type=int, default=None,
                    help='HTTP port (default 8765; 8766 in --library mode so it '
                         'never collides with a running device bridge)')
    ap.add_argument('--mock', action='store_true',
                    help='serve fake data for UI development (no hardware)')
    ap.add_argument('--library', action='store_true',
                    help='hardware-free LIBRARY mode: browse/import/export bank '
                         'backups + original .msmpl_bank files, no device needed')
    ap.add_argument('--no-reader', action='store_true',
                    help='disable the background panel-edit reader (diagnostic; '
                         'the /api/events stream stays silent)')
    ap.add_argument('--trace', action='store_true',
                    help='hexdump every USB read/write to stderr (diagnostic)')
    args = ap.parse_args()
    port = args.port if args.port else (8766 if args.library else 8765)
    _own_backups_to_invoker()    # if sudo: give backups/ back to the user (heals)

    DEVICE = (LibraryDevice() if args.library else
              MockDevice() if args.mock else
              Device(reader=not args.no_reader, trace=args.trace))
    try:
        DEVICE.open()
    except Exception as e:
        # Serve anyway so the app can show a friendly "device not responding"
        # panel with a Retry button (POST /api/connect), instead of the user
        # seeing only this terminal line. Power-cycle + Retry usually recovers.
        DEVICE.open_error = str(e)
        print('device open failed: %s\n  → serving the editor anyway; '
              'power-cycle the device and click Retry (or restart).' % e)
    if args.library:
        print('LIBRARY mode — no device; browse/import/export bank backups.')
    if not args.mock and not args.library and DEVICE.open_error is None:
        print('microSAMPLER claimed (cable %d, channel %d) — Web MIDI mode is '
              'unavailable until the bridge exits.'
              % (DEVICE.cable, DEVICE.channel + 1))

    # Closing the Terminal window sends SIGHUP (service managers send SIGTERM);
    # treat them like Ctrl+C so DEVICE.close() runs and the USB interface is
    # released cleanly. Otherwise the device is left mid-stream and the next
    # start can't get an inquiry reply until it's power-cycled.
    def _graceful(*_a):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _graceful)
    if hasattr(signal, 'SIGHUP'):
        signal.signal(signal.SIGHUP, _graceful)

    global SRV
    srv = SRV = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('bridge ready: http://localhost:%d  (Ctrl+C to stop)' % port)
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
