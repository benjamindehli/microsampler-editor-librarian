"""Offline test of download.py phases with a fake device."""
import sys
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import struct
import download as D
import protocol as P
from msusb import SysExReassembler, to_usb_midi, from_usb_midi


class FakeUSBError(Exception):
    pass


class FakeDev:
    def __init__(self, owner):
        self.owner = owner

    def read(self, ep, size, timeout=0):
        return self.owner._pop_raw(size)


class FakeMS:
    """Queues of 64-byte bulk-IN blocks; SysEx requests trigger canned replies."""
    USBError = FakeUSBError

    def __init__(self, header, pcm, param_blob, channel=0):
        self.reasm = SysExReassembler()
        self.dev = FakeDev(self)
        self.queue = []          # list of byte blocks to return from bulk reads
        self.header = header
        self.pcm = pcm
        self.param_blob = param_blob
        self.ch = channel
        self.cable = 1

    def _push_sysex(self, msg):
        pkts = to_usb_midi(msg, 1)
        for off in range(0, len(pkts), 64):
            self.queue.append(pkts[off:off+64])

    def send_sysex(self, midi, cable=None):
        func = midi[4]
        if func == 0x16:
            ss = midi[5]
            self._push_sysex(bytes([0xf0, 0x42, 0x30 | self.ch, 0x7f, 0x42, ss,
                                    *P.korg_encode(self.header), 0xf7]))
        elif func == 0x1f:
            # clock noise first, then marker, then raw PCM in 64B blocks
            self.queue.append(bytes([0x1f, 0xf8, 0, 0]))
            self.queue.append(P.DIRECT_MARKER)
            for off in range(0, len(self.pcm), 0x4000):
                self.queue.append(self.pcm[off:off+0x4000])
        elif func == 0x14:
            ss = midi[5]
            self._push_sysex(bytes([0xf0, 0x42, 0x30 | self.ch, 0x7f, 0x44, ss,
                                    *P.korg_encode(self.param_blob), 0xf7]))

    def _pop_raw(self, size):
        if not self.queue:
            raise FakeUSBError('timed out')
        blk = self.queue[0]
        take = blk[:size]
        rest = blk[size:]
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
        for _ in range(20):
            raw = self._read_raw()
            if not raw:
                return None
            msgs = self.reasm.feed(from_usb_midi(raw))
            if msgs:
                return msgs[0]
        return None


# --- build a fake mono 24kHz sample, 100 frames, 132.5 BPM ------------------
# wire PCM is 16-bit signed BIG-endian (hardware-verified)
values = [(i * 257) % 32768 - 16384 for i in range(100)]
pcm = b''.join(struct.pack('>h', v) for v in values)
header = struct.pack('<IH', len(pcm), 1325) + bytes([1 << 2, 0xff])
blob = bytearray([0xff] * 64)
blob[0:8] = b'TESTSMP '
blob[0x19] = 0x40 - 5
blob[0x1b] = 0x40 + 7
blob[0x20:0x2b] = b'Test sample'

ms = FakeMS(header, pcm, bytes(blob))

hdr = D.fetch_header(ms, 0, 3)
assert hdr['data_size'] == len(pcm), hdr
assert hdr['rate_hz'] == 24000 and not hdr['stereo'] and hdr['tempo_bpm'] == 132.5

got = D.fetch_pcm(ms, 0, hdr['data_size'], progress=False)
assert got == pcm, (len(got), len(pcm))

par = D.fetch_params(ms, 0, 3)
assert par['name'] == 'TESTSMP' and par['long_name'] == 'Test sample'
assert par['semitone'] == -5 and par['tune'] == 7

D.write_wav('/tmp/test_dl.wav', got, hdr['rate_hz'], hdr['stereo'])
import wave
with wave.open('/tmp/test_dl.wav') as w:
    assert w.getnframes() == 100 and w.getframerate() == 24000 and w.getnchannels() == 1
    # WAV must hold the byteswapped (little-endian) samples
    assert w.readframes(100) == b''.join(struct.pack('<h', v) for v in values)

# error path: empty/protected slot -> func 0x29
class ErrMS(FakeMS):
    def send_sysex(self, midi, cable=None):
        self._push_sysex(bytes([0xf0, 0x42, 0x30, 0x7f, 0x29, 0xf7]))

try:
    D.fetch_header(ErrMS(header, pcm, bytes(blob)), 0, 3)
    raise AssertionError('expected DownloadError')
except D.DownloadError as e:
    assert '0x29' in str(e)

print('download offline test: OK')
