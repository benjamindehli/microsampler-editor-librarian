#!/usr/bin/env python3
"""Offline test for msmpl_bank.py — the original-Korg .msmpl_bank reader.
Builds a synthetic file (the same 6150-chunk tree the originals use) and checks
the parser/extractor recover it. No hardware, no real backup files needed."""
import os
import struct
import sys
import tempfile
import wave

import msmpl_bank as M
import protocol as P


def _varlen(n):
    out = bytearray([n & 0x7f]); n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7f)); n >>= 7
    return bytes(out)


def recorded_pattern_blob(note=60, name='GROOVE'):
    """A real, non-empty SEQP pattern blob (built from a 1-note SMF via the
    proven smf_to_pattern), for exercising the pattern-export path. Reused by
    test_bridge.py."""
    div = 96
    trk = (_varlen(0) + bytes([0x90, note, 100])          # note on (sample ch 0)
           + _varlen(div // 2) + bytes([0x80, note, 0])   # note off
           + _varlen(0) + bytes([0xFF, 0x2F, 0x00]))      # end of track
    smf = (b'MThd' + struct.pack('>IHHH', 6, 0, 1, div)
           + b'MTrk' + struct.pack('>I', len(trk)) + trk)
    return P.smf_to_pattern(smf, sample_channel=0, name=name)


def chunk(tag, payload, count=1):
    """A 32-byte 6150 chunk header + payload (only tag / 0x20 / size are read)."""
    return (b'6150' + tag + struct.pack('<H', 32) + struct.pack('<I', len(payload))
            + b'\x00\x00' + struct.pack('<I', 3) + struct.pack('<I', count)
            + struct.pack('<I', len(payload)) + b'\xff\xff\xff\xff' + payload)


def param_blob(name, long_name, end_frame):
    b = bytearray(b'\xff' * 64)
    b[0:8] = name.encode('latin-1').ljust(8, b' ')
    b[0x0c:0x10] = struct.pack('<I', 0)              # START
    b[0x10:0x14] = struct.pack('<I', end_frame)      # END
    b[0x14] = 127; b[0x15] = 20; b[0x17] = 101; b[0x18] = 64    # decay/rel/level/pan
    b[0x19] = 0x40; b[0x1a] = 0x40; b[0x1b] = 0x40              # semi/tune/velo
    b[0x20:0x40] = b'\x00' * 32                                # long name: 0-padded
    b[0x20:0x20 + len(long_name)] = long_name.encode('utf-8')
    return bytes(b)


def smp_header(data_size, tempo10, stereo, rate_code):
    flags = (1 if stereo else 0) | (rate_code << 2)
    return struct.pack('<IHB', data_size, tempo10, flags) + b'\xff'


def build_bank(name='TESTBNK'):
    # one stereo 48k sample: 100 frames * 2ch * 2B = 400 bytes of PCM
    frames = 100
    pcm = struct.pack('>' + 'h' * (frames * 2), *([1234, -1234] * frames))  # 16-bit BE
    smpd = chunk(b'SmpD', param_blob('SNARE', 'Big Snare', frames - 2)
                 + smp_header(len(pcm), 1200, True, 0) + pcm)
    empty = chunk(b'SmpD', b'\xff' * 64 + smp_header(0, 1200, False, 0))   # empty slot
    bnkp = chunk(b'BnkP', name.encode().ljust(8, b' ') + struct.pack('<H', 1200) + b'\xff' * 54)
    smps = chunk(b'SmpS', smpd + empty, count=2)
    seqs = chunk(b'SeqS', chunk(b'SeqD', recorded_pattern_blob(name='GROOVE')), count=1)
    return chunk(b'BnkD', bnkp + smps + seqs), pcm


def main():
    data, pcm = build_bank('MYBANK')

    bank = M.parse_bank(data)
    assert bank['name'] == 'MYBANK', bank['name']
    assert bank['bpm'] == 120.0, bank['bpm']
    assert len(bank['samples']) == 36                # padded to a full bank
    s0 = bank['samples'][0]
    assert s0['name'] == 'SNARE' and s0['long_name'] == 'Big Snare', s0
    assert s0['stereo'] and s0['rate_hz'] == 48000 and not s0['empty']
    assert s0['pcm'] == pcm, 'PCM round-trips byte-exact'
    assert bank['samples'][1]['empty']
    assert len(bank['patterns']) == 16               # padded to 16 patterns
    p0 = bank['patterns'][0]
    assert not p0['empty'] and p0['name'] == 'GROOVE' and p0['note_count'] >= 1, p0
    assert bank['patterns'][1]['empty']
    print('parse_bank: OK (samples + patterns)')

    # not-a-bank input is rejected
    try:
        M.parse_bank(b'NOPE' * 16)
        raise AssertionError('accepted non-bank input')
    except ValueError:
        pass

    # extract → a backup dir with a valid, byte-swapped WAV
    out = tempfile.mkdtemp()
    n, _ = M.extract_bytes(data, out)
    assert n == 1, n
    wav = os.path.join(out, 'samples', 's00.wav')
    with wave.open(wav) as w:
        assert w.getnchannels() == 2 and w.getframerate() == 48000
        assert w.getnframes() == 100
        # WAV is little-endian: first sample 1234 → bytes 0xd2 0x04
        assert w.readframes(1)[:2] == struct.pack('<h', 1234)
    assert os.path.isfile(os.path.join(out, 'manifest.json'))
    # the recorded pattern is written as sequences/q00.bin + a non-empty manifest entry
    assert os.path.isfile(os.path.join(out, 'sequences', 'q00.bin')), 'pattern blob written'
    import json
    seqs = json.load(open(os.path.join(out, 'manifest.json')))['sequences']
    nonempty = [s for s in seqs if not s['empty']]
    assert len(nonempty) == 1 and nonempty[0]['name'] == 'GROOVE', nonempty
    print('extract_bytes: OK (WAV byte-swapped LE, pattern + manifest written)')
    print('msmpl offline test: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
