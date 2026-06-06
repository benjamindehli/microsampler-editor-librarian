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
assert bank['seq_lengths'] == [4] * 16             # pattern storage units

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
               body=json.dumps({'start': 0, 'end': 10}))      # empty slot
assert st == 500

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

# --- static serving ----------------------------------------------------------------
st, ct, data = req('GET', '/index.html')
assert st == 200 and ct == 'text/html' and b'microSAMPLER' in data
st, _, _ = req('GET', '/../CLAUDE.md')             # path traversal blocked
assert st == 404
st, _, _ = req('GET', '/js/protocol.js')
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
assert len(used) == 1 and used[0]['name'] == 'SMPA' and used[0]['end'] == 62
assert real.ms.left_dump == 1                  # committed leave-dump-mode
assert real.ms.selected is None                # no select session left open
wavbytes = real.download_wav(0)
with wave.open(io.BytesIO(wavbytes)) as w:
    assert w.getnframes() == 64
assert real.ms.selected is None                # PCM dump closed the session

# a second bank summary must work back-to-back (no stranded state)
out2 = real.bank_summary()
assert out2['name'] == 'TESTBANK'

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

# busy guard: second op while one runs must 409 at the device layer
try:
    bk.op['done'] = False
    bk.start_backup()
    raise AssertionError('expected busy error')
except RuntimeError as e:
    assert 'already running' in str(e)
bk.op['done'] = True

print('bridge offline test: OK')
