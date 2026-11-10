#!/usr/bin/env python3
"""Read Korg microSAMPLER ".msmpl_bank" files (the bank backups Korg's original
editor saved) and extract their samples, patterns and bank blob. Works without
the hardware.

The file is a tree of 8-byte-tagged "6150…" chunks (32-byte header: 4B "6150",
4B tag, u16 header-size=0x20, u32 payload-size, …):

  6150BnkD  outer container (the whole file)
    6150BnkP  64-byte bank parameter blob (8-char name, u16 BPM*10 @8)
    6150SmpS  sample set → 36× 6150SmpD
      6150SmpD  per sample: 64-byte param blob + 8-byte header + raw 16-bit BE PCM
    6150SeqS  sequence set → 6150SeqD per pattern (a SEQP blob)
    6150MfxD  master-effect blob (first 36 bytes = the device's packed effect)

BnkP, the 36 SmpD param blobs and MfxD are byte-identical to the sections of
the device's own 0x974-byte bank blob (checked against a device backup of the
same bank), so extract also rebuilds that blob as bank.bin - what RESTORE
sends. Its 16 bytes @0x940 aren't in the file: the original editor's
BankWrite fills each from SequenceData::getSequenceLength() = the pattern's
bar count (u16 BE @0x0A of the SEQP blob, 0 if under 1308 bytes).

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
import protocol as P

EFFECT_SIZE = 0x24                     # packed effect section of the bank blob
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
    empty, [rate_hz, stereo, data_size, tempo_bpm, pcm]} … 36 ]}.
    A truncated or malformed file raises ValueError."""
    try:
        return _parse_bank(data)
    except (IndexError, struct.error):
        raise ValueError('truncated or malformed .msmpl_bank file') from None


def _parse_bank(data):
    top = _walk(data, 0, len(data))
    if not top or top[0][0] != 'BnkD':
        raise ValueError('not a .msmpl_bank file (missing 6150BnkD chunk)')
    _, bbody, bsize = top[0]
    bank = {'name': '', 'bpm': None, 'samples': [], 'patterns': [],
            'param': None, 'effect': None}
    for tag, body, size in _walk(data, bbody, bbody + bsize):
        if tag == 'BnkP' and size >= 10:
            bp = data[body:body + size]
            bank['name'] = _name(bp[0:8])
            bank['bpm'] = struct.unpack_from('<H', bp, 8)[0] / 10.0
            if size >= 64:
                bank['param'] = bp[:64]
        elif tag == 'MfxD' and size >= EFFECT_SIZE:
            bank['effect'] = data[body:body + EFFECT_SIZE]
        elif tag == 'SmpS':
            for i, (st, sb, _ss) in enumerate(_walk(data, body, body + size)):
                if st != 'SmpD':
                    continue
                param = data[sb:sb + 64]
                data_size, tempo10, flags = struct.unpack_from('<IHB', data, sb + 64)
                s = {'slot': i, 'name': _name(param[0:8]), 'param': param,
                     'long_name': _name(param[0x20:0x40]), 'empty': data_size == 0}
                if data_size:
                    s.update(rate_hz=P.CODE_RATE.get((flags >> 2) & 3, 48000),
                             stereo=bool(flags & 1), data_size=data_size,
                             tempo_bpm=tempo10 / 10.0,
                             pcm=data[sb + 72:sb + 72 + data_size])
                bank['samples'].append(s)
        elif tag == 'SeqS':                              # 16 SEQP pattern blobs
            for q, (st, sb, ss) in enumerate(_walk(data, body, body + size)):
                if st != 'SeqD':
                    continue
                blob = data[sb:sb + ss]
                # SeqD pads 4 bytes past the SEQP's own size (u32 BE @4, 1312 vs
                # 1308): trim to what the device itself sends
                if len(blob) >= 8:
                    used = struct.unpack_from('>I', blob, 4)[0]
                    if 0 < used <= len(blob):
                        blob = blob[:used]
                try:
                    p = P.parse_pattern(blob)
                    notes = len(p['notes']) if p else 0
                    pname = p['name'] if p else ''
                except Exception:
                    notes, pname = 0, ''
                bank['patterns'].append({'pattern': q, 'name': pname,
                                         'note_count': notes, 'empty': notes == 0,
                                         'blob': blob})
    while len(bank['samples']) < 36:                     # pad to a full 36-slot bank
        bank['samples'].append({'slot': len(bank['samples']), 'name': '',
                                'long_name': '', 'empty': True})
    while len(bank['patterns']) < 16:                    # pad to 16 patterns
        bank['patterns'].append({'pattern': len(bank['patterns']), 'name': '',
                                 'note_count': 0, 'empty': True, 'blob': b''})
    return bank


def bar_count(blob):
    """Bars of a SEQP pattern blob, as the original editor's
    SequenceData::getSequenceLength (0 for a blob under 1308 bytes)."""
    if len(blob) < 0x51c:
        return 0
    return struct.unpack_from('>H', blob, 0x0a)[0] & 0xff


def bank_blob(bank):
    """Rebuild the device's 0x974-byte bank blob from a parsed bank, or None
    when the file lacks a section (then there's nothing safe to restore)."""
    params = [s.get('param') for s in bank['samples'][:36]]
    if bank['param'] is None or bank['effect'] is None or \
            any(p is None or len(p) != 64 for p in params):
        return None
    blob = (bank['param'] + b''.join(params)
            + bytes(bar_count(p['blob']) for p in bank['patterns'][:16])
            + bank['effect'])
    assert len(blob) == P.BANK_BLOB_SIZE, len(blob)
    return blob


def extract(path, outdir):
    """Extract a .msmpl_bank FILE - see extract_bytes."""
    with open(path, 'rb') as f:
        data = f.read()
    return extract_bytes(data, outdir, os.path.basename(path))


def extract_bytes(data, outdir, source_name=None):
    """Extract a .msmpl_bank (raw bytes) to a backup directory in our own format
    (manifest.json + samples/sNN.wav, and bank.bin + every pattern when the
    file is complete - then it restores like a device backup), reusable by the
    bridge's librarian (backup list / cherry-pick / ZIP export / RESTORE).
    Returns (non_empty_count, bank)."""
    bank = parse_bank(data)
    os.makedirs(os.path.join(outdir, 'samples'), exist_ok=True)
    manifest = {'source': 'msmpl_bank', 'file': source_name,
                'name': bank['name'], 'bpm': bank['bpm'],
                'samples': [], 'sequences': []}
    blob = bank_blob(bank)
    if blob is not None:
        with open(os.path.join(outdir, 'bank.bin'), 'wb') as f:
            f.write(blob)
        manifest['seq_lengths'] = list(blob[0x940:0x950])
    n = 0
    # use the loop index (not the parsed dict value) for the filename, bounded to
    # the device's 36 pads - keeps the path provably inside outdir (no traversal
    # from a malformed bank) regardless of how many chunks the file declares.
    for i, s in enumerate(bank['samples']):
        if i > 35:
            break
        entry = {'slot': i, 'name': s['name'], 'empty': s['empty']}
        if not s['empty']:
            DL.write_wav(os.path.join(outdir, 'samples', 's%02d.wav' % i),
                         s['pcm'], s['rate_hz'], s['stereo'])
            entry.update(rate_hz=s['rate_hz'], stereo=s['stereo'],
                         data_size=s['data_size'], tempo_bpm=s['tempo_bpm'],
                         long_name=s['long_name'])
            if s.get('param'):
                with open(os.path.join(outdir, 'samples', 's%02d.param.bin' % i),
                          'wb') as f:
                    f.write(s['param'])
            n += 1
        manifest['samples'].append(entry)
    # patterns → sequences/qNN.bin (raw SEQP blob) for non-empty ones; the bridge
    # converts these to .mid on demand (protocol.pattern_to_smf).
    # with bank.bin, write EVERY pattern blob (empty ones too, as a device
    # backup does) so RESTORE sends each pattern exactly as the file has it
    keep_all = blob is not None
    if any(p['blob'] and (keep_all or not p['empty']) for p in bank['patterns']):
        os.makedirs(os.path.join(outdir, 'sequences'), exist_ok=True)
    for i, p in enumerate(bank['patterns']):     # index bounded to the 16 patterns
        if i > 15:
            break
        entry = {'pattern': i, 'empty': p['empty'],
                 'name': p['name'], 'note_count': p['note_count']}
        if p['blob'] and (keep_all or not p['empty']):
            with open(os.path.join(outdir, 'sequences', 'q%02d.bin' % i), 'wb') as f:
                f.write(p['blob'])
        manifest['sequences'].append(entry)
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
        with open(args.file, 'rb') as f:
            bank = parse_bank(f.read())
        print("bank '%s'  BPM %s" % (bank['name'], bank['bpm']))
        for s in bank['samples']:
            if s['empty']:
                continue
            print("  s%02d  '%s' (%s)  %d Hz %s  %.1f BPM  %d bytes"
                  % (s['slot'], s['name'], s['long_name'], s['rate_hz'],
                     'stereo' if s['stereo'] else 'mono', s['tempo_bpm'],
                     s['data_size']))
        for p in bank['patterns']:
            if p['empty']:
                continue
            print("  q%02d  '%s'  %d notes" % (p['pattern'], p['name'], p['note_count']))
        return 0

    outdir = args.outdir or os.path.splitext(os.path.basename(args.file))[0]
    n, bank = extract(args.file, outdir)
    pats = sum(1 for p in bank['patterns'] if not p['empty'])
    print("extracted %d samples + %d patterns from '%s' → %s/"
          % (n, pats, bank['name'], outdir))
    return 0


if __name__ == '__main__':
    sys.exit(main())
