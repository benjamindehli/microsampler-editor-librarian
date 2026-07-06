"""Offline test of bridge.py: mock device + real HTTP round-trips."""
import sys, os, io, json, math, struct, threading, time, wave
import http.client

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge as B

PORT = 18765

B.DEVICE = B.MockDevice()
B.DEVICE.open()
srv = B.ThreadingHTTPServer(('127.0.0.1', PORT), B.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()


def req(method, path, body=None, headers=None):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, r.getheader('Content-Type'), data


# --- status -------------------------------------------------------------------
st, ct, data = req('GET', '/api/status')
assert st == 200 and json.loads(data)['mock'] is True

# --- bank summary ---------------------------------------------------------------
st, ct, data = req('GET', '/api/bank')
bank = json.loads(data)
assert bank['name'] == 'MOCKBANK' and len(bank['slots']) == 36
s0 = bank['slots'][0]
assert s0['name'] == 'OCTSTRAT' and s0['fx_sw'] is True and not s0['empty']
assert bank['slots'][35]['empty'] is True

# --- effect summary (mock) ------------------------------------------------------
e = bank['effect']
assert e['type'] == 2 and e['knobs'] == [2, 3] and len(e['params']) == 32
assert e['params'][0] == 100                       # Dry/Wet byte
assert bank['seq_lengths'] == [4, 4, 4, 4] + [0xFF] * 12   # 0xFF = empty pattern

# --- sample download -------------------------------------------------------------
st, ct, data = req('GET', '/api/sample/0.wav')
assert st == 200 and ct == 'audio/wav'
with wave.open(io.BytesIO(data)) as w:
    assert w.getframerate() == 48000 and w.getnchannels() == 1
    assert w.getnframes() == 24000

st, _, data = req('GET', '/api/sample/35.wav')
assert st == 404 and 'empty' in json.loads(data)['error']
st, _, _ = req('GET', '/api/sample/99.wav')
assert st == 400

# --- sample upload + read-back round-trip ----------------------------------------
buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
    frames = b''.join(struct.pack('<h', int(9000 * math.sin(i * 0.2)))
                      for i in range(4800))
    w.writeframes(frames)
st, _, data = req('POST', '/api/sample/5?name=beepy&tempo=99.5', body=buf.getvalue())
up = json.loads(data)
assert st == 200 and up == {'slot': 5, 'frames': 4800, 'rate_hz': 48000,
                            'stereo': False}, up
st, _, data = req('GET', '/api/sample/5.wav')
with wave.open(io.BytesIO(data)) as w:
    assert w.getnframes() == 4800
    assert w.readframes(4800) == frames          # byte-exact through the mock
st, _, data = req('GET', '/api/bank')
s5 = json.loads(data)['slots'][5]
assert s5['name'] == 'BEEPY' and s5['tempo_bpm'] == 99.5

# query values arrive percent-encoded (encodeURIComponent) — must be decoded,
# or 'MY KIT' lands on the device as literal 'MY%20KIT'
st, _, _ = req('POST', '/api/sample/6?name=MY%20KIT&tempo=120', body=buf.getvalue())
assert st == 200
st, _, data = req('GET', '/api/bank')
assert json.loads(data)['slots'][6]['name'] == 'MY KIT'

# a non-WAV upload body is client input → 400 (and must not kill the handler
# thread — load_wav used to raise SystemExit, which except Exception misses)
st, _, _ = req('POST', '/api/sample/7?name=BAD', body=b'this is not a wav')
assert st == 400

# --- ORIG BPM edit (mock HTTP) — re-uploads the sample with a new header tempo --
st, _, data = req('POST', '/api/sample/5/tempo', body=json.dumps({'bpm': 88.0}))
assert st == 200 and json.loads(data) == {'slot': 5, 'tempo_bpm': 88.0}
st, _, data = req('GET', '/api/bank')
assert json.loads(data)['slots'][5]['tempo_bpm'] == 88.0
st, _, _ = req('POST', '/api/sample/5/tempo', body=json.dumps({'bpm': 999}))   # out of range
assert st == 400
st, _, _ = req('POST', '/api/sample/35/tempo', body=json.dumps({'bpm': 120}))  # empty slot
assert st == 400

# --- rename (mock HTTP) ---------------------------------------------------------
st, _, data = req('POST', '/api/sample/0/name',
                  body=json.dumps({'name': 'NEWNAME', 'long_name': 'A New Name'}))
assert st == 200 and json.loads(data)['name'] == 'NEWNAME'
st, _, data = req('GET', '/api/bank')
assert json.loads(data)['slots'][0]['name'] == 'NEWNAME'
st, _, _ = req('POST', '/api/sample/0/name', body=json.dumps({'name': '  '}))
assert st == 400                                   # empty name rejected

# --- start/end points (mock HTTP) ---------------------------------------------
st, _, data = req('POST', '/api/sample/0/points',
                  body=json.dumps({'start': 1000, 'end': 20000}))
assert st == 200 and json.loads(data) == {'slot': 0, 'start': 1000, 'end': 20000}
st, _, data = req('GET', '/api/bank')
s0p = json.loads(data)['slots'][0]
assert s0p['start'] == 1000 and s0p['end'] == 20000
st, _, _ = req('POST', '/api/sample/0/points',
               body=json.dumps({'start': 500, 'end': 500}))   # start must be < end
assert st == 400
st, _, _ = req('POST', '/api/sample/35/points',
               body=json.dumps({'start': 0, 'end': 10}))      # empty slot →
assert st == 400                                              # client error, not a 500
st, _, _ = req('POST', '/api/sample/35/name',
               body=json.dumps({'name': 'GHOST'}))            # ditto for rename
assert st == 400
st, _, _ = req('POST', '/api/param', body=json.dumps({'param': 16, 'value': 1}))
assert st == 400                                              # missing field → 400
st, _, _ = req('POST', '/api/param', body='{not json')
assert st == 400                                              # bad JSON body → 400

# --- patterns (mock HTTP) ----------------------------------------------------
st, _, data = req('GET', '/api/patterns')
pats = json.loads(data)['patterns']
assert len(pats) == 16 and all(p['valid'] for p in pats)
assert pats[0]['name'] == 'MOCKPTRN' and pats[0]['note_count'] == 20
assert pats[0]['smp_notes'] == 16 and pats[0]['kbd_notes'] == 4
assert pats[1]['name'] == 'INITPTRN' and pats[1]['note_count'] == 0
assert pats[0]['bars'] == 4 and pats[0]['ticks'] == 1536
assert len(pats[0]['notes'][0]) == 5            # [tick, ch, note, vel, dur]
st, ct, data = req('GET', '/api/pattern/0.mid')
assert st == 200 and ct == 'audio/midi' and data[:4] == b'MThd'
st, _, _ = req('GET', '/api/pattern/77.mid')
assert st == 400

# SMF import round-trip over HTTP: export P1, import into P5, re-export
st, _, mid0 = req('GET', '/api/pattern/0.mid')
st, _, data = req('POST', '/api/pattern/5', body=mid0)
imp = json.loads(data)
assert st == 200 and imp['note_count'] == 20 and imp['bars'] == 4, imp
st, _, mid5 = req('GET', '/api/pattern/5.mid')
assert mid5 == mid0                       # converters reach a fixpoint
# init endpoint resets notes but keeps the sample assignment (was 0)
st, _, data = req('POST', '/api/pattern/5/init')
ini = json.loads(data)
assert ini['note_count'] == 0 and ini['name'] == 'INITPTRN' and ini['sample'] == 0

# --- bank settings, batched (mock HTTP) -------------------------------------------
st, _, data = req('POST', '/api/bank/settings',
                  body=json.dumps({'name': 'MYBANK', 'bpm': 98.5}))
assert st == 200 and json.loads(data) == {'name': 'MYBANK', 'bpm': 98.5}
st, _, data = req('GET', '/api/bank')
bk2 = json.loads(data)
assert bk2['name'] == 'MYBANK' and bk2['bpm'] == 98.5
st, _, _ = req('POST', '/api/bank/settings', body=json.dumps({'name': ''}))
assert st == 400

# --- sample params (authoritative switch state for self-heal) --------------------
st, _, data = req('GET', '/api/sample/1/params')
pp = json.loads(data)
assert pp['empty'] is False and pp['loop'] is True and pp['fx_sw'] is False
assert pp['reverse'] is False and pp['bpm_sync'] == 0
st, _, data = req('GET', '/api/sample/0/params')
assert json.loads(data)['fx_sw'] is True
st, _, data = req('GET', '/api/sample/35/params')
assert json.loads(data)['empty'] is True

# --- slot copy / swap / clear (mock HTTP) ----------------------------------------
def slot_names():
    return {s['slot']: (None if s['empty'] else s['name'])
            for s in json.loads(req('GET', '/api/bank')[2])['slots']}
n0 = slot_names()                                 # whatever prior tests left
src = next(i for i, v in n0.items() if v is not None)   # a used slot
assert n0[14] is None and n0[15] is None          # pristine scratch slots
# copy src → 14
st, _, _ = req('POST', '/api/sample/copy', body=json.dumps({'from': src, 'to': 14}))
assert st == 200
n = slot_names(); assert n[14] == n0[src] and n[src] == n0[src]
# swap 14 ↔ 15
st, _, _ = req('POST', '/api/sample/swap', body=json.dumps({'a': 14, 'b': 15}))
assert st == 200
n = slot_names(); assert n[15] == n0[src] and n[14] is None
# clear 15
st, _, _ = req('POST', '/api/sample/15/clear')
assert st == 200 and slot_names()[15] is None
# guards: same-slot copy, OOB
assert req('POST', '/api/sample/copy', body=json.dumps({'from': 2, 'to': 2}))[0] == 400
assert req('POST', '/api/sample/99/clear')[0] == 400

# --- effect preset apply (batched, mock HTTP) ------------------------------------
params = list(range(32))
st, _, data = req('POST', '/api/effect', body=json.dumps(
    {'type': 7, 'knobs': [4, 6], 'params': params}))
assert st == 200 and json.loads(data)['type'] == 7
st, _, data = req('GET', '/api/bank')
fx = json.loads(data)['effect']
assert fx['type'] == 7 and fx['knobs'] == [4, 6] and fx['params'] == params
st, _, _ = req('POST', '/api/effect', body=json.dumps({'type': 7, 'params': [1, 2]}))
assert st == 400                                   # wrong-length guard

# --- play note (mock HTTP) -------------------------------------------------------
st, _, data = req('POST', '/api/note', body=json.dumps({'slot': 5, 'on': True}))
assert st == 200 and json.loads(data)['ok'] is True
assert B.DEVICE._last_note == (5, True, 100, False, None)
st, _, data = req('POST', '/api/note',                 # keyboard mode flag carried through
                  body=json.dumps({'slot': 7, 'on': True, 'keyboard': True}))
assert st == 200 and B.DEVICE._last_note == (7, True, 100, True, None)
st, _, data = req('POST', '/api/note',                 # raw MIDI note (keyboard full range)
                  body=json.dumps({'note': 72, 'on': True, 'keyboard': True, 'velocity': 90}))
assert st == 200 and B.DEVICE._last_note == (0, True, 90, True, 72)
st, _, _ = req('POST', '/api/note', body=json.dumps({'slot': 99}))
assert st == 400
st, _, _ = req('POST', '/api/note', body=json.dumps({'note': 200}))   # out of range
assert st == 400
st, _, _ = req('POST', '/api/note', body=json.dumps({'on': True}))    # neither slot nor note
assert st == 400

# --- pitch bend (keyboard-mode) -------------------------------------------------
st, _, data = req('POST', '/api/pitch-bend', body=json.dumps({'value': 10000}))
assert st == 200 and json.loads(data)['ok'] is True
assert B.DEVICE._last_bend == (10000, True)
st, _, _ = req('POST', '/api/pitch-bend', body=json.dumps({'value': 99999}))   # out of range
assert st == 400

# --- live param edit --------------------------------------------------------------
st, _, data = req('POST', '/api/param', body=json.dumps(
    {'obj': 16, 'param': 16, 'value': 1}), headers={'Content-Type': 'application/json'})
assert st == 200 and json.loads(data)['ok'] is True

# --- SSE event stream --------------------------------------------------------------
got = {}
def listen():
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    c.request('GET', '/api/events')
    r = c.getresponse()
    while True:
        line = r.fp.readline().decode()
        if line.startswith('data: '):
            got['evt'] = json.loads(line[6:])
            break
t = threading.Thread(target=listen, daemon=True)
t.start()
time.sleep(0.3)                                    # let the listener register
B.DEVICE._on_sysex(bytes.fromhex('f042307f411c0011000200f7'))   # real capture
t.join(timeout=5)
assert got.get('evt', {}).get('obj') == 28, got
assert got['evt']['param'] == 17 and got['evt']['value'] == 2
assert got['evt']['sample'] == 12

# --- CC scan + SSE forward (panel FX-knob path) ----------------------------------
got_cc = {}
def listen_cc():
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    c.request('GET', '/api/events')
    r = c.getresponse()
    while True:
        line = r.fp.readline().decode()
        if line.startswith('data: '):
            evt = json.loads(line[6:])
            if evt.get('type') == 'cc':
                got_cc['evt'] = evt
                break
t2 = threading.Thread(target=listen_cc, daemon=True)
t2.start()
time.sleep(0.3)
# CC#12 val 99 on ch 0, embedded between clock bytes and a note-on
B.DEVICE._scan_cc(bytes([0xf8, 0x90, 0x3c, 0x40, 0xb0, 12, 99, 0xf8]))
t2.join(timeout=5)
assert got_cc.get('evt') == {'type': 'cc', 'ch': 0, 'cc': 12, 'value': 99}, got_cc

# --- patterns progress events over SSE -------------------------------------------
prog = []
def listen_prog():
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    c.request('GET', '/api/events')
    r = c.getresponse()
    while len(prog) < 17:
        line = r.fp.readline().decode()
        if line.startswith('data: '):
            evt = json.loads(line[6:])
            if evt.get('type') == 'progress' and evt.get('op') == 'patterns':
                prog.append(evt)
tp = threading.Thread(target=listen_prog, daemon=True)
tp.start()
time.sleep(0.3)
req('GET', '/api/patterns')
tp.join(timeout=5)
assert prog[0]['done'] == 0 and prog[0]['total'] == 16, prog[:1]
assert prog[-1]['done'] == 16, prog[-1]
assert [e['done'] for e in prog] == list(range(17)), [e['done'] for e in prog]

# --- static serving ----------------------------------------------------------------
st, ct, data = req('GET', '/app.html')
assert st == 200 and ct == 'text/html' and b'microSAMPLER' in data
st, _, _ = req('GET', '/../CLAUDE.md')             # path traversal blocked
assert st == 404
st, _, _ = req('GET', '/app.js')
assert st == 200

srv.shutdown()

# --- real Device paths against the fake transport (regression: the device
# requires a fresh inquiry per session; the bank summary must be blob-only —
# bare func 0x16 selects would strand the device's sample-select state)
from test_bank import FakeMS, blob, samples, seqs

real = B.Device()
real.ms = FakeMS(bytes(blob), samples, seqs)
real.channel = 0
real.cable = 1
out = real.bank_summary()
assert out['name'] == 'TESTBANK'
assert len(out['effect']['params']) == 32          # packed @0x950 -> JSON
assert len(out['seq_lengths']) == 16               # pattern storage units
used = [s for s in out['slots'] if not s['empty']]
# emptiness = END==0, NOT flags8 bit7 (bit7 is LOOP — a looping used sample
# must NOT vanish as "empty"; regression for the 2026-06-08 discovery)
assert len(used) == 2, [s['slot'] for s in used]
assert used[0]['name'] == 'SMPA' and used[0]['end'] == 62
assert used[0]['loop'] is False and used[0]['bpm_sync'] == 0
assert used[1]['name'] == 'LOOPY' and used[1]['loop'] is True
assert used[1]['bpm_sync'] == 1 and used[1]['fx_sw'] is True
assert used[1]['reverse'] is False
assert real.ms.left_dump == 1                  # committed leave-dump-mode
assert real.ms.selected is None                # no select session left open
wavbytes, wavtempo = real.download_wav(0)       # now returns (bytes, orig BPM)
with wave.open(io.BytesIO(wavbytes)) as w:
    assert w.getnframes() == 64
assert wavtempo is not None                     # orig BPM rides the header
assert real.ms.selected is None                # PCM dump closed the session

# a second bank summary must work back-to-back (no stranded state)
out2 = real.bank_summary()
assert out2['name'] == 'TESTBANK'

# --- bank settings over the real Device path: 9 messages, ONE lock grab --------
real.ms.sysexes = []
_orig_send = real.ms.send_sysex
real.ms.send_sysex = lambda m, cable=None: real.ms.sysexes.append(bytes(m))
real.set_bank_settings('AB', 90.5)
real.ms.send_sysex = _orig_send
assert len(real.ms.sysexes) == 9
import protocol as PP
assert real.ms.sysexes[0] == PP.parameter_change(0, 0, 0, ord('A'))
assert real.ms.sysexes[1] == PP.parameter_change(0, 0, 1, ord('B'))
assert real.ms.sysexes[2] == PP.parameter_change(0, 0, 2, ord(' '))
assert real.ms.sysexes[8] == PP.parameter_change(0, 0, 16, 905)

# --- play note over the real Device path (USB-MIDI short message) --------------
real.ms.shorts = []
real.ms.send_short = lambda st_, d1, d2, cable=0: real.ms.shorts.append(
    (st_, d1, d2, cable))
real.play_note(7, True, velocity=100)
real.play_note(7, False)
assert real.ms.shorts == [(0x90, 48 + 7, 100, 1),   # note on, C3+slot, cable 1
                          (0x80, 48 + 7, 100, 1)]   # note off

# --- start/end points over the real Device path (param-blob write) -------------
# set_points must fetch the CURRENT blob (0x14), patch ONLY the two u32s,
# and write it back (0x44) — without opening a select session.
res_pts = real.set_points(0, 7, 55)
assert res_pts == {'slot': 0, 'start': 7, 'end': 55}
wp = bytes(real.ms.w_params[0])
assert int.from_bytes(wp[0x0c:0x10], 'little') == 7
assert int.from_bytes(wp[0x10:0x14], 'little') == 55
orig_par = bytes(blob)[0x40:0x80]                  # slot 0 blob from the bank
assert wp[:0x0c] == orig_par[:0x0c]                # name/flags untouched
assert wp[0x14:] == orig_par[0x14:]                # all other params untouched
assert real.ms.selected is None                    # no select session opened
# read-back reflects the write (FakeMS serves w_params on 0x14)
par2 = real.set_points(0, 9, 60)
wp2 = bytes(real.ms.w_params[0])
assert int.from_bytes(wp2[0x0c:0x10], 'little') == 9

# --- rename over the real Device path (same fetch-patch-send blob write) -------
res_rn = real.rename(0, 'NEWNAME', 'A New Long Name')
assert res_rn['name'] == 'NEWNAME'
wp3 = bytes(real.ms.w_params[0])
assert wp3[0:8] == b'NEWNAME '                     # 8 chars, space-padded
assert wp3[0x20:0x40].rstrip(b'\xff') == b'A New Long Name'
assert int.from_bytes(wp3[0x0c:0x10], 'little') == 9   # points survive rename
assert wp3[0x14:0x20] == wp2[0x14:0x20]            # other params untouched
assert real.ms.selected is None                    # still no select session

# a failing blob request propagates cleanly
class ErrMS(FakeMS):
    def send_sysex(self, midi, cable=None):
        if midi[4] == 0x10:                    # bank dump request -> error
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x29, 0xf7]))
        else:
            super().send_sysex(midi, cable)

real2 = B.Device()
real2.ms = ErrMS(bytes(blob), samples, seqs)
real2.channel = 0
real2.cable = 1
try:
    real2.bank_summary()
    raise AssertionError('expected DownloadError')
except Exception as e:
    assert '0x29' in str(e), e

# --- patterns over the real Device path (fake transport, SEQP blobs) ----------
import protocol as P2
seqs2 = {q: P2.build_init_pattern() for q in range(16)}
realp = B.Device()
realp.ms = FakeMS(bytes(blob), samples, seqs2)
realp.channel = 0
realp.cable = 1
ps = realp.patterns_summary()['patterns']
assert len(ps) == 16 and all(p['valid'] for p in ps)
assert ps[3]['name'] == 'INITPTRN' and ps[3]['bars'] == 4
mid = realp.pattern_mid(5)
assert mid[:4] == b'MThd'

# --- pattern write over the real Device path (fake write transport) -----------
wpat = B.Device()
wpat.ms = FakeWriteMS2 = __import__('test_bank').FakeWriteMS()
wpat.ms.dev = __import__('test_bank').FakeWriteDev(wpat.ms)
wpat.channel = 0
wpat.cable = 1
blob5 = P2.smf_to_pattern(P2.pattern_to_smf(P2.build_init_pattern()))
res5 = wpat.pattern_write(5, blob5)
assert res5['valid'] and res5['name'] == 'INITPTRN'
assert bytes(wpat.ms.w_seqs[5][1]) == blob5        # exact bytes on the wire
assert wpat.pattern_cache[5] == blob5

# --- backup/restore ops over the op runner -----------------------------------
import tempfile, time as _t
from test_bank import FakeWriteMS, FakeWriteDev

B.BACKUP_ROOT = tempfile.mkdtemp()

bk = B.Device()
bk.ms = FakeMS(bytes(blob), samples, seqs)
bk.channel = 0
bk.cable = 1
res = bk.start_backup()
for _ in range(100):
    if bk.op['done']:
        break
    _t.sleep(0.05)
assert bk.op['done'] and bk.op['ok'], bk.op['lines']
assert any('backup complete' in l for l in bk.op['lines'])
lst = B.list_backups()
assert len(lst) == 1 and lst[0]['name'] == 'TESTBANK' and lst[0]['samples'] == 1

# cherry-pick helpers: list a backup's samples + read one out as a WAV
cps = B.backup_sample_list(res['dir'])
assert len(cps) == 1, cps
cp_slot = cps[0]['slot']
cp_wav, cp_name, cp_tempo = B.backup_sample_wav(res['dir'], cp_slot)
assert cp_wav[:4] == b'RIFF' and len(cp_wav) > 44 and isinstance(cp_name, str)
assert cp_tempo > 0
# an empty slot in that backup has no extractable sample
cp_empty = next(i for i in range(36) if i != cp_slot)
try:
    B.backup_sample_wav(res['dir'], cp_empty)
    raise AssertionError('expected no sample at empty backup slot')
except RuntimeError:
    pass
print('cherry-pick: list + extract one sample OK')

rs = B.Device()
rs.ms = FakeWriteMS()
rs.ms.dev = FakeWriteDev(rs.ms)
rs.channel = 0
rs.cable = 1
rs.start_restore(res['dir'], 4)
for _ in range(100):
    if rs.op['done']:
        break
    _t.sleep(0.05)
assert rs.op['done'] and rs.op['ok'], rs.op['lines']
assert rs.ms.w_bank == 4 and rs.ms.left_dump == 1
assert bytes(rs.ms.w_samples[0][1]) == samples[0][1]      # PCM round-trips

# restore dir name is untrusted HTTP input — traversal must be rejected
for evil in ('..', '.', '...', '../x', 'a/b', '/etc', 'x\x00y', ''):
    try:
        B.backup_dir(evil)
        raise AssertionError('accepted evil backup name: %r' % evil)
    except RuntimeError as e:
        assert 'invalid backup name' in str(e)
assert B.backup_dir('20260604-120000').startswith(
    os.path.realpath(B.BACKUP_ROOT))            # normal labels still resolve

# backups-ownership / writability (the sudo-device vs no-sudo-library case):
# _check_backup_writable() passes on a writable BACKUP_ROOT and raises a helpful
# "chown" message on a root-owned (non-writable) one; _own_backups_to_invoker()
# is a safe no-op when not running as root under sudo.
B._check_backup_writable()                       # current temp root is writable → ok
if hasattr(os, 'geteuid') and os.geteuid() != 0:   # (root ignores perms; skip there)
    ro = tempfile.mkdtemp()
    os.chmod(ro, 0o555)
    _saved_root = B.BACKUP_ROOT
    B.BACKUP_ROOT = ro
    try:
        B._check_backup_writable()
        raise AssertionError('expected a not-writable error')
    except RuntimeError as e:
        assert 'chown' in str(e), e
    finally:
        os.chmod(ro, 0o755)
        B.BACKUP_ROOT = _saved_root
B._own_backups_to_invoker()                      # no-op here (not root) — must not raise
print('backups writability/ownership guard: OK')

# pattern export: a backup with one recorded pattern → list / MIDI / zip
from test_msmpl import recorded_pattern_blob
_pat_root, _pat_saved = tempfile.mkdtemp(), B.BACKUP_ROOT
B.BACKUP_ROOT = _pat_root
try:
    os.makedirs(os.path.join(_pat_root, 'GROOVY', 'sequences'))
    with open(os.path.join(_pat_root, 'GROOVY', 'sequences', 'q03.bin'), 'wb') as f:
        f.write(recorded_pattern_blob(name='GROOVE'))
    with open(os.path.join(_pat_root, 'GROOVY', 'manifest.json'), 'w') as f:
        json.dump({'name': 'GROOVY', 'samples': [],
                   'sequences': [{'pattern': 3, 'empty': False, 'name': 'GROOVE', 'note_count': 1}]}, f)
    pl = B.backup_pattern_list('GROOVY')
    assert len(pl) == 1 and pl[0]['pattern'] == 3 and pl[0]['name'] == 'GROOVE', pl
    assert B.backup_pattern_smf('GROOVY', 3)[:4] == b'MThd', 'pattern → SMF'
    import zipfile as _zf_pat
    names = _zf_pat.ZipFile(io.BytesIO(B.backup_patterns_zip('GROOVY'))).namelist()
    assert names and all(n.endswith('.mid') for n in names), names
    try:
        B.backup_pattern_smf('GROOVY', 0)            # empty/missing → clear error
        raise AssertionError('expected missing-pattern error')
    except RuntimeError:
        pass
finally:
    B.BACKUP_ROOT = _pat_saved
print('pattern export (list / MIDI / zip): OK')

# --- backup zip export + import round-trip (direct calls; server is down) --------
import zipfile as _zf
zdata = B.backup_zip(res['dir'])
assert zdata[:2] == b'PK'
names = _zf.ZipFile(io.BytesIO(zdata)).namelist()
assert any(n.endswith('manifest.json') for n in names), names
before = len(B.list_backups())
newdir = B.import_backup_zip(zdata)
assert newdir and newdir != res['dir']
assert len(B.list_backups()) == before + 1
# re-import again → distinct name (no clobber)
newdir2 = B.import_backup_zip(zdata)
assert newdir2 != newdir
# non-backup zip rejected; traversal name guarded
bad = io.BytesIO()
with _zf.ZipFile(bad, 'w') as z: z.writestr('notes.txt', 'x')
try:
    B.import_backup_zip(bad.getvalue()); raise AssertionError('accepted non-backup')
except RuntimeError as e:
    assert 'no manifest' in str(e)
try:
    B.backup_zip('../etc'); raise AssertionError('accepted traversal')
except RuntimeError as e:
    assert 'invalid backup name' in str(e)

# busy guard: second op while one runs must 409 at the device layer
try:
    bk.op['done'] = False
    bk.start_backup()
    raise AssertionError('expected busy error')
except RuntimeError as e:
    assert 'already running' in str(e)
bk.op['done'] = True

print('bridge offline test: OK')
