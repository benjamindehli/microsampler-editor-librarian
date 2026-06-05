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
