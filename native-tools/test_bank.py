"""Offline test of bank.py backup flow with a fake device."""
import sys, os, json, struct, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bank as B
import protocol as P
from msusb import SysExReassembler, to_usb_midi, from_usb_midi


class FakeUSBError(Exception):
    pass


class FakeDev:
    def __init__(self, owner): self.owner = owner
    def read(self, ep, size, timeout=0): return self.owner._pop_raw(size)


class FakeMS:
    USBError = FakeUSBError

    def __init__(self, bank_blob, samples, sequences):
        """samples: {slot: (header8, pcm)}; sequences: {q: data}"""
        self.reasm = SysExReassembler()
        self.dev = FakeDev(self)
        self.queue = []
        self.cable = 1
        self.bank_blob = bank_blob
        self.samples = samples
        self.sequences = sequences
        self.cur_sample = None
        self.cur_seq = None
        self.left_dump = None
        self.selected = None     # hardware rule: 0x16 on a non-empty slot
                                 # SELECTS it; next 0x16 -> error 0x29 until
                                 # the session completes via 0x1F or 0x14

    def _push_sysex(self, msg):
        pkts = to_usb_midi(msg, 1)
        for off in range(0, len(pkts), 64):
            self.queue.append(pkts[off:off+64])

    def send_sysex(self, midi, cable=None):
        func = midi[4]
        if func == 0x10:                       # current bank dump request
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x40,
                                    *P.korg_encode(self.bank_blob), 0xf7]))
        elif func == 0x1c:                     # user bank dump request
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x4c, midi[5],
                                    *P.korg_encode(self.bank_blob), 0xf7]))
        elif func == 0x16:                     # sample header request
            if self.selected is not None:      # refuse re-select (hardware rule)
                self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x29, 0xf7]))
                return
            self.cur_sample = midi[5] & 0x3f
            hdr, pcm = self.samples.get(self.cur_sample,
                                        (bytes(6) + b'\x00\xff', b''))
            if pcm:
                self.selected = self.cur_sample
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x42, midi[5],
                                    *P.korg_encode(hdr), 0xf7]))
        elif func == 0x14:                     # param request — does NOT close
            # the select session (hardware-verified 2026-06-05; the original's
            # Target=1 flow is dead code on real firmware)
            blob = (self.bank_blob[0x40 + self.cur_sample*0x40:
                                   0x80 + self.cur_sample*0x40]
                    if len(self.bank_blob) >= P.BANK_BLOB_SIZE
                    else bytes([0xff]) * 64)
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x44, midi[5] & 0x3f,
                                    *P.korg_encode(blob), 0xf7]))
        elif func == 0x1f:                     # sample PCM request (closes session)
            self.selected = None
            pcm = self.samples[self.cur_sample][1]
            self.queue.append(P.DIRECT_MARKER)
            for off in range(0, len(pcm), 0x4000):
                self.queue.append(pcm[off:off+0x4000])
        elif func == 0x13:                     # sequence header request
            self.cur_seq = midi[5] & 0x0f
            n = len(self.sequences.get(self.cur_seq, b''))
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x43, midi[5],
                                    (n >> 14) & 3, (n >> 7) & 0x7f, n & 0x7f,
                                    0xf7]))
        elif func == 0x1d:                     # sequence data request
            data = self.sequences[self.cur_seq]
            self.queue.append(P.DIRECT_MARKER)
            for off in range(0, len(data), 0x4000):
                self.queue.append(data[off:off+0x4000])
        elif func == 0x1a:                     # leave dump mode
            self.left_dump = midi[5]
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x4a, 0x01, 0xf7]))

    def _pop_raw(self, size):
        if not self.queue:
            raise FakeUSBError('timed out')
        blk = self.queue[0]
        take, rest = blk[:size], blk[size:]
        if rest:
            self.queue[0] = rest
        else:
            self.queue.pop(0)
        return take

    def _read_raw(self, timeout=0):
        try:
            return self._pop_raw(64)
        except FakeUSBError:
            return b''

    def read_sysex(self, timeout_ms=0):
        for _ in range(200):
            raw = self._read_raw()
            if not raw:
                return None
            msgs = self.reasm.feed(from_usb_midi(raw))
            if msgs:
                return msgs[0]
        return None

    def device_inquiry(self, timeout_ms=1500, cables=(1, 0)):
        return (bytes([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x42, 0x7f, 0x00,
                       0x01, 0x00, 0x08, 0x01, 0x01, 0x00, 0xf7]), 1)


# --- build a fake bank --------------------------------------------------------
blob = bytearray([0xff] * P.BANK_BLOB_SIZE)
blob[0:8] = b'TESTBANK'
blob[8:10] = (905).to_bytes(2, 'little')              # 90.5 BPM
blob[0x40:0x48] = b'SMPA    '                         # slot 0 name
blob[0x48] = 0x00                                     # flags8: bit7 clear = used
blob[0x4c:0x50] = (0).to_bytes(4, 'little')           # start
blob[0x50:0x54] = (62).to_bytes(4, 'little')          # end (64-frame sample)
blob[0x940] = 4                                       # pattern 0 has data

pcm = b''.join(struct.pack('>h', (i * 31) % 4000 - 2000) for i in range(64))
hdr0 = struct.pack('<IH', len(pcm), 1200) + bytes([0, 0xff])   # mono 48k
empty_hdr = struct.pack('<IH', 0, 1200) + bytes([0, 0xff])
samples = {0: (hdr0, pcm)}
for i in range(1, 36):
    samples[i] = (empty_hdr, b'')
seqs = {0: bytes(range(100)), **{q: b'' for q in range(1, 16)}}

ms = FakeMS(bytes(blob), samples, seqs)

out = '/tmp/test_bank_out'
shutil.rmtree(out, ignore_errors=True)
B.backup(ms, 0, None, out)

manifest = json.load(open(f'{out}/manifest.json'))
assert manifest['name'] == 'TESTBANK' and manifest['bpm'] == 90.5
assert manifest['samples'][0]['empty'] is False
assert manifest['samples'][1]['empty'] is True
assert sum(1 for s in manifest['samples'] if not s['empty']) == 1
assert manifest['sequences'][0]['size'] == 100
assert open(f'{out}/sequences/q00.bin', 'rb').read() == bytes(range(100))
assert os.path.getsize(f'{out}/bank.bin') == P.BANK_BLOB_SIZE
assert os.path.exists(f'{out}/samples/s00.wav')
assert not os.path.exists(f'{out}/samples/s01.wav')
assert ms.left_dump == 1                       # committed leave-dump-mode

import wave
with wave.open(f'{out}/samples/s00.wav') as w:
    assert w.getnframes() == 64 and w.getnchannels() == 1
    assert w.readframes(1) == struct.pack('<h', -2000)   # byteswapped to LE


# --- restore round-trip: backup dir -> a second fake device -------------------
class FakeWriteMS(FakeMS):
    """Records everything a restore writes; ACKs each phase."""

    def __init__(self):
        super().__init__(b'', {}, {})
        self.w_blob = None
        self.w_bank = None
        self.w_samples = {}        # slot -> (hdr8, bytearray pcm)
        self.w_seqs = {}           # q -> (size, bytearray)
        self.phase = 'idle'
        self.cur = None

    def send_sysex(self, midi, cable=None):
        func = midi[4]
        if func in (0x40, 0x4c):                   # bank blob in
            if func == 0x4c:
                self.w_bank = midi[5]
                self.w_blob = P.korg_decode(midi[6:-1])[:P.BANK_BLOB_SIZE]
            else:
                self.w_blob = P.korg_decode(midi[5:-1])[:P.BANK_BLOB_SIZE]
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x23, 0xf7]))
        elif func == 0x42:                         # sample header in
            slot = midi[5] & 0x3f
            hdr = P.korg_decode(midi[6:-1])[:8]
            size = int.from_bytes(hdr[0:4], 'little')
            self.w_samples[slot] = (hdr, bytearray())
            if size:
                self.phase, self.cur = 'pcm', slot
            else:
                self.phase = 'idle'
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x27, 0xf7]))
        elif func == 0x43:                         # sequence header in
            q = midi[5] & 0x0f
            size = ((midi[6] & 3) << 14) | ((midi[7] & 0x7f) << 7) | (midi[8] & 0x7f)
            self.w_seqs[q] = (size, bytearray())
            if size:
                self.phase, self.cur = 'seq', q
            else:
                self.phase = 'idle'
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x27, 0xf7]))
        elif func == 0x1a:                         # leave dump mode
            self.left_dump = midi[5]
            self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x4a, 0x01, 0xf7]))

    def _raw_write(self, data):
        if self.phase == 'pcm':
            hdr, buf = self.w_samples[self.cur]
            buf += data
            if len(buf) >= int.from_bytes(hdr[0:4], 'little'):
                self.phase = 'idle'
                self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x21, 0xf7]))
        elif self.phase == 'seq':
            size, buf = self.w_seqs[self.cur]
            buf += data
            if len(buf) >= size:
                self.phase = 'idle'
                self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x21, 0xf7]))


class FakeWriteDev(FakeDev):
    def write(self, ep, data, timeout=0):
        self.owner._raw_write(bytes(data))


wms = FakeWriteMS()
wms.dev = FakeWriteDev(wms)
B.restore(wms, 0, 4, out)                          # restore to user bank 5

assert wms.w_bank == 4
assert wms.w_blob == bytes(blob)
assert wms.left_dump == 1                          # commit
# slot 0 round-trips byte-exact (wire BE both ways)
hdr_w, pcm_w = wms.w_samples[0]
assert bytes(pcm_w) == pcm, (len(pcm_w), len(pcm))
assert int.from_bytes(hdr_w[0:4], 'little') == len(pcm)
# empty slots cleared with dataSize 0
assert int.from_bytes(wms.w_samples[1][0][0:4], 'little') == 0
assert len(wms.w_samples) == 36
# sequence 0 round-trips; empty patterns get size-0 headers
assert bytes(wms.w_seqs[0][1]) == bytes(range(100))
assert wms.w_seqs[1][0] == 0
assert len(wms.w_seqs) == 16

shutil.rmtree(out)
print('bank offline test: OK (backup + restore round-trip)')
