#!/usr/bin/env python3
"""Read Korg microSAMPLER ".msmpl_bank" files — the bank backups the ORIGINAL
Korg editor saved — and extract their samples. For owners who still have the
backups but no longer have the hardware.

The file is a tree of 8-byte-tagged "6150…" chunks (32-byte header: 4B "6150",
4B tag, u16 header-size=0x20, u32 payload-size, …):

  6150BnkD  outer container (the whole file)
    6150BnkP  64-byte bank parameter blob (8-char name, u16 BPM*10 @8)
    6150SmpS  sample set → 36× 6150SmpD
      6150SmpD  per sample: 64-byte param blob + 8-byte header + raw 16-bit BE PCM
    6150SeqS  sequence/pattern data
    6150MfxD  master-effect blob

The per-sample param blob, 8-byte header and PCM are byte-identical to the
on-wire formats we already decode (see protocol.py / CLAUDE.md), so extraction
is just walking the chunks and byte-swapping the PCM into a WAV.

CLI:
  python3 msmpl_bank.py info    <file.msmpl_bank>
  python3 msmpl_bank.py extract <file.msmpl_bank> [outdir]   # WAVs + manifest.json
"""
import argparse
import json
import os
import struct
import sys

import download as DL

RATES = {0: 48000, 1: 24000, 2: 12000, 3: 6000}
CHUNK_HDR = 32


def _walk(d, off, end):
    """Sequence of (tag, body_offset, payload_size) for the 6150 chunks in
    [off, end). Stops at the first non-6150 bytes."""
    out = []
    while off + CHUNK_HDR <= end:
        if d[off:off + 4] != b'6150':
            break
        tag = d[off + 4:off + 8].decode('ascii', 'replace')
        hdrsz = struct.unpack_from('<H', d, off + 8)[0]
        size = struct.unpack_from('<I', d, off + 10)[0]
        body = off + hdrsz
        out.append((tag, body, size))
        off = body + size
    return out


def _name(b):
    return b.split(b'\x00')[0].decode('latin-1').rstrip()


def parse_bank(data):
    """Parse a .msmpl_bank → {name, bpm, samples: [ {slot, name, long_name,
    empty, [rate_hz, stereo, data_size, tempo_bpm, pcm]} … 36 ]}."""
    top = _walk(data, 0, len(data))
    if not top or top[0][0] != 'BnkD':
        raise ValueError('not a .msmpl_bank file (missing 6150BnkD chunk)')
    _, bbody, bsize = top[0]
    bank = {'name': '', 'bpm': None, 'samples': []}
    for tag, body, size in _walk(data, bbody, bbody + bsize):
        if tag == 'BnkP' and size >= 10:
            bp = data[body:body + size]
            bank['name'] = _name(bp[0:8])
            bank['bpm'] = struct.unpack_from('<H', bp, 8)[0] / 10.0
        elif tag == 'SmpS':
            for i, (st, sb, _ss) in enumerate(_walk(data, body, body + size)):
                if st != 'SmpD':
                    continue
                param = data[sb:sb + 64]
                data_size, tempo10, flags = struct.unpack_from('<IHB', data, sb + 64)
                s = {'slot': i, 'name': _name(param[0:8]),
                     'long_name': _name(param[0x20:0x40]), 'empty': data_size == 0}
                if data_size:
                    s.update(rate_hz=RATES.get((flags >> 2) & 3, 48000),
                             stereo=bool(flags & 1), data_size=data_size,
                             tempo_bpm=tempo10 / 10.0,
                             pcm=data[sb + 72:sb + 72 + data_size])
                bank['samples'].append(s)
    while len(bank['samples']) < 36:                     # pad to a full 36-slot bank
        bank['samples'].append({'slot': len(bank['samples']), 'name': '',
                                'long_name': '', 'empty': True})
    return bank


def extract(path, outdir):
    """Extract a .msmpl_bank FILE — see extract_bytes."""
    return extract_bytes(open(path, 'rb').read(), outdir, os.path.basename(path))


def extract_bytes(data, outdir, source_name=None):
    """Extract a .msmpl_bank (raw bytes) to a backup directory in our own format
    (manifest.json + samples/sNN.wav), reusable by the bridge's librarian
    (backup list / cherry-pick / ZIP export). Returns (non_empty_count, bank)."""
    bank = parse_bank(data)
    os.makedirs(os.path.join(outdir, 'samples'), exist_ok=True)
    manifest = {'source': 'msmpl_bank', 'file': source_name,
                'name': bank['name'], 'bpm': bank['bpm'],
                'samples': [], 'sequences': []}
    n = 0
    for s in bank['samples']:
        entry = {'slot': s['slot'], 'name': s['name'], 'empty': s['empty']}
        if not s['empty']:
            DL.write_wav(os.path.join(outdir, 'samples', 's%02d.wav' % s['slot']),
                         s['pcm'], s['rate_hz'], s['stereo'])
            entry.update(rate_hz=s['rate_hz'], stereo=s['stereo'],
                         data_size=s['data_size'], tempo_bpm=s['tempo_bpm'],
                         long_name=s['long_name'])
            n += 1
        manifest['samples'].append(entry)
    with open(os.path.join(outdir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    return n, bank


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    pi = sub.add_parser('info', help='list the samples in a .msmpl_bank')
    pi.add_argument('file')
    pe = sub.add_parser('extract', help='extract samples to WAVs + manifest.json')
    pe.add_argument('file')
    pe.add_argument('outdir', nargs='?', help='default: <file stem>/')
    args = ap.parse_args(argv)

    if args.cmd == 'info':
        bank = parse_bank(open(args.file, 'rb').read())
        print("bank '%s'  BPM %s" % (bank['name'], bank['bpm']))
        for s in bank['samples']:
            if s['empty']:
                continue
            print("  s%02d  '%s' (%s)  %d Hz %s  %.1f BPM  %d bytes"
                  % (s['slot'], s['name'], s['long_name'], s['rate_hz'],
                     'stereo' if s['stereo'] else 'mono', s['tempo_bpm'],
                     s['data_size']))
        return 0

    outdir = args.outdir or os.path.splitext(os.path.basename(args.file))[0]
    n, bank = extract(args.file, outdir)
    print("extracted %d samples from '%s' → %s/" % (n, bank['name'], outdir))
    return 0


if __name__ == '__main__':
    sys.exit(main())
