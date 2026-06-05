"""Offline test of upload.py conversion + 3-phase flow with a fake device."""
import sys, os, struct, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import upload as U
import protocol as P
from msusb import SysExReassembler, from_usb_midi, to_usb_midi


# --- conversion ---------------------------------------------------------------
def make_wav(path, rate, nch, width, frames):
    with wave.open(path, 'wb') as w:
        w.setnchannels(nch); w.setsampwidth(width); w.setframerate(rate)
        if width == 2:
            data = b''.join(struct.pack('<h', (i * 37) % 32768 - 16384)
                            for i in range(frames * nch))
        elif width == 1:
            data = bytes((i * 7) % 256 for i in range(frames * nch))
        else:
            data = b''.join(((i * 999) % 8388608 - 4194304)
                            .to_bytes(width, 'little', signed=True)
                            for i in range(frames * nch))
        w.writeframes(data)

tmp = '/tmp/_u16.wav'
make_wav(tmp, 44100, 2, 2, 4410)          # 0.1 s stereo 44.1k
chans, rate = U.load_wav(tmp)
assert rate == 44100 and len(chans) == 2 and len(chans[0]) == 4410
pcm, frames = U.to_device_pcm(chans, rate, 48000)
assert abs(frames - 4800) <= 1 and len(pcm) == frames * 2 * 2

make_wav(tmp, 48000, 1, 1, 100)           # 8-bit mono passthrough rate
chans, rate = U.load_wav(tmp)
pcm1, frames1 = U.to_device_pcm(chans, rate, 48000)
assert frames1 == 100 and len(pcm1) == 200

make_wav(tmp, 12000, 1, 3, 50)            # 24-bit mono
chans, rate = U.load_wav(tmp)
pcm3, frames3 = U.to_device_pcm(chans, rate, 12000)
assert frames3 == 50 and len(pcm3) == 100

# wire byte order: device wants BIG-endian (high byte first)
from array import array
one = U.to_device_pcm([array('h', [0x1234, -2])], 48000, 48000)[0]
assert one == b'\x12\x34\xff\xfe', one.hex()

# resample identity & ratio
ramp = array('h', range(0, 1000, 10))
assert U.resample_channel(ramp, 48000, 48000) is ramp
half = U.resample_channel(ramp, 48000, 24000)
assert abs(len(half) - 50) <= 1


# --- 3-phase flow -------------------------------------------------------------
class FakeDev:
    def __init__(self, owner): self.owner = owner
    def write(self, ep, data, timeout=0): self.owner.on_write(bytes(data))


class FakeUSBError(Exception):
    pass


class FakeMS:
    USBError = FakeUSBError

    def __init__(self, expect_pcm_len):
        self.reasm = SysExReassembler()
        self.dev = FakeDev(self)
        self.queue = []
        self.cable = 1
        self.phase = 'header'
        self.pcm_got = 0
        self.expect_pcm_len = expect_pcm_len
        self.seen = {}

    def _ack(self, func):
        pkts = to_usb_midi(bytes([0xf0, 0x42, 0x30, 0x7f, func, 0xf7]), 1)
        self.queue.append(pkts)

    def send_sysex(self, midi, cable=None):
        self.on_write(to_usb_midi(midi, 1))

    def on_write(self, data):
        if self.phase == 'header':
            midi = from_usb_midi(data)
            assert midi[4] == 0x42, midi.hex()
            self.seen['header'] = P.korg_decode(midi[6:-1])
            self.phase = 'pcm'
            self._ack(0x27)                      # header ok
        elif self.phase == 'pcm':
            self.pcm_got += len(data)
            assert len(data) <= 0x4000
            if self.pcm_got >= self.expect_pcm_len:
                self.phase = 'param'
                self._ack(0x21)                  # data ok
        elif self.phase == 'param':
            midi = from_usb_midi(data)
            assert midi[4] == 0x44, midi.hex()
            self.seen['blob'] = P.korg_decode(midi[6:-1])[:64]
            self.phase = 'done'
            self._ack(0x21)

    def _read_raw(self, timeout=0):
        return self.queue.pop(0) if self.queue else b''

    def read_sysex(self, timeout_ms=0):
        for _ in range(10):
            raw = self._read_raw()
            if not raw:
                return None
            msgs = self.reasm.feed(from_usb_midi(raw))
            if msgs:
                return msgs[0]
        return None


make_wav(tmp, 24000, 1, 2, 1000)
chans, rate = U.load_wav(tmp)
pcm, frames = U.to_device_pcm(chans, rate, 24000)
blob = P.build_param_blob('TEST', 'Test long', 0, frames)
ms = FakeMS(len(pcm))
U.upload(ms, 0, 9, pcm, 24000, False, frames, blob, 95.5)
assert ms.phase == 'done'
hdr = ms.seen['header']
assert int.from_bytes(hdr[0:4], 'little') == len(pcm)
assert hdr[4] | (hdr[5] << 8) == 955            # tempo 95.5
assert hdr[6] == (1 << 2)                       # mono, 24 kHz
assert ms.seen['blob'] == blob
assert ms.pcm_got == len(pcm)

# error ACK raises
ms2 = FakeMS(10**9)
orig = ms2.on_write
def err_write(data):
    midi = from_usb_midi(data)
    if midi and midi[0] == 0xf0 and midi[4] == 0x42:
        ms2._ack(0x28)                           # header error
ms2.on_write = err_write
try:
    U.upload(ms2, 0, 9, pcm, 24000, False, frames, blob, 120.0)
    raise AssertionError('expected DownloadError')
except Exception as e:
    assert '0x28' in str(e), e

os.remove(tmp)
print('upload offline test: OK')
