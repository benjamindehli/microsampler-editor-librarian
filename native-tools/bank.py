#!/usr/bin/env python3
"""
microSAMPLER bank backup & restore.

BACKUP mirrors BankReceive::process from the original editor:
  1. func 0x10 (current bank) or func 0x1c <bank 0..7> (user bank A..H)
     -> reply func 0x40 / 0x4c: 0x974-byte blob (7-bit enc) =
        64B bank params + 36*64B sample params + 16*1B pattern lengths
        + 36B effect data. func 0x29 = error.
  2. per sample 0..35: func 0x16 (ss|0x40) -> header; if dataSize > 0:
     func 0x1F -> marker + raw PCM (sample params come from the bank blob).
  3. per pattern 0..15: func 0x13 (qq|0x40) -> func 0x43 header (3-byte size);
     if size > 0: func 0x1D -> marker + raw sequence bytes.
  4. func 0x1A 01 (leave dump mode / success) -> wait func 0x4A (<=30 s).

Output is a directory:
  <out>/manifest.json     summary (bank name, BPM, per-sample/pattern info)
  <out>/bank.bin          raw 0x974 bank blob (ground truth)
  <out>/samples/sNN.wav   audio for non-empty slots
  <out>/samples/sNN.param.bin
  <out>/sequences/qNN.bin raw pattern data for non-empty patterns

RESTORE mirrors BankWrite::process (the computer-side persistence path):
  1. bank blob via func 0x40 (current) / 0x4c <bank> (user bank) -> ACK 0x23.
  2. per sample: func 0x42 header (+ raw BE PCM if non-empty) -> ACKs.
     Empty slots are cleared with a dataSize-0 header (PCM phase skipped,
     exactly as SampleWrite does on `test esi,esi`).
  3. per pattern: func 0x43 header w/ 3-byte size + raw data (no marker
     in the OUT direction) -> ACKs.
  4. func 0x1A 01 (leave dump mode / COMMIT) -> wait func 0x4A (<=30 s; the
     device may be writing a user bank to flash).
Restoring to a USER BANK (-b) is PERSISTENT; restoring to the current bank
is RAM-only (save on the device to keep it).

Usage (sudo: CoreMIDI owns the interface):
  sudo python3 bank.py backup                 # current bank -> ./bank_current/
  sudo python3 bank.py backup -b 1            # user bank 1 (A) -> ./bank_1/
  sudo python3 bank.py backup -o mybackup     # choose output directory
  sudo python3 bank.py restore bank_current   # directory -> current bank (RAM)
  sudo python3 bank.py restore mybackup -b 8  # directory -> user bank 8 (FLASH)
"""
import argparse, array, json, os, sys, wave

from msusb import MicroSampler, _hex
import protocol as P
from download import (DownloadError, _drain, _wait_korg_reply,
                      fetch_header, fetch_direct, fetch_pcm, write_wav)

BANK_ERR_FUNCS = {0x29}


def fetch_bank_blob(ms, channel, bank=None):
    _drain(ms)
    ms.send_sysex(P.bank_dump_request(channel, bank))
    msg = _wait_korg_reply(ms, P.BANK_DUMP_REPLY_FUNCS, BANK_ERR_FUNCS,
                           timeout_ms=10000, what='bank dump (func 0x40/0x4c)')
    bp = P.parse_bank_dump(msg)
    if bp is None:
        raise DownloadError(f"unparseable bank dump ({len(msg)} bytes): "
                            f"{_hex(msg[:24])}...")
    return bp


def fetch_sequence(ms, channel, seq_no):
    """-> raw sequence bytes (b'' if the pattern is empty)."""
    _drain(ms)
    ms.send_sysex(P.sequence_dump_request(channel, seq_no))
    msg = _wait_korg_reply(ms, {0x43}, BANK_ERR_FUNCS,
                           timeout_ms=5000, what='sequence header (func 0x43)')
    sh = P.parse_sequence_header(msg)
    if sh is None:
        raise DownloadError(f"unparseable sequence header: {_hex(msg)}")
    if sh['data_size'] == 0:
        return b''
    return fetch_direct(ms, P.sequence_data_request(channel), sh['data_size'],
                        label=f'seq {seq_no:02d}')


def leave_dump_mode(ms, channel, commit=True):
    _drain(ms)
    ms.send_sysex(P.leave_dump_mode(channel, commit))
    _wait_korg_reply(ms, {P.LEAVE_DUMP_ACK_FUNC}, BANK_ERR_FUNCS,
                     timeout_ms=35000, what='leave-dump-mode ACK (func 0x4a)')


def backup(ms, channel, bank, out, log=print):
    os.makedirs(os.path.join(out, 'samples'), exist_ok=True)
    os.makedirs(os.path.join(out, 'sequences'), exist_ok=True)
    manifest = {'bank': 'current' if bank is None else bank + 1,
                'samples': [], 'sequences': []}

    # ---- 1. bank blob -----------------------------------------------------
    bp = fetch_bank_blob(ms, channel, bank)
    log(f"bank '{bp['name']}'  BPM {bp['bpm']:.1f}")
    with open(os.path.join(out, 'bank.bin'), 'wb') as f:
        f.write(bp['raw'])
    manifest['name'] = bp['name']
    manifest['bpm'] = bp['bpm']
    manifest['seq_lengths'] = bp['seq_lengths']

    try:
        # ---- 2. samples ----------------------------------------------------
        for i in range(36):
            par = bp['sample_params'][i]
            hdr = fetch_header(ms, channel, i)
            entry = {'slot': i, 'name': par['name'], 'empty': hdr['data_size'] == 0}
            if hdr['data_size'] == 0:
                log(f"  s{i:02d}: empty")
            else:
                log(f"  s{i:02d}: '{par['name']}' {hdr['data_size']} bytes "
                      f"{hdr['rate_hz']} Hz {'stereo' if hdr['stereo'] else 'mono'}")
                pcm = fetch_pcm(ms, channel, hdr['data_size'])
                write_wav(os.path.join(out, 'samples', f's{i:02d}.wav'),
                          pcm, hdr['rate_hz'], hdr['stereo'])
                with open(os.path.join(out, 'samples', f's{i:02d}.param.bin'), 'wb') as f:
                    f.write(par['raw'])
                entry.update(rate_hz=hdr['rate_hz'], stereo=hdr['stereo'],
                             data_size=hdr['data_size'],
                             tempo_bpm=hdr['tempo_bpm'])
            manifest['samples'].append(entry)

        # ---- 3. sequences (patterns) ----------------------------------------
        for q in range(16):
            data = fetch_sequence(ms, channel, q)
            entry = {'pattern': q, 'empty': not data, 'size': len(data)}
            if data:
                log(f"  q{q:02d}: {len(data)} bytes")
                with open(os.path.join(out, 'sequences', f'q{q:02d}.bin'), 'wb') as f:
                    f.write(data)
            manifest['sequences'].append(entry)
    finally:
        # ---- 4. leave dump mode ---------------------------------------------
        try:
            leave_dump_mode(ms, channel, commit=True)
            log("left dump mode (func 0x1a -> 0x4a ACK)")
        except DownloadError as e:
            log(f"warning: leave-dump-mode: {e} (power-cycle the device "
                  f"if it is unresponsive)")

    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    n = sum(1 for s in manifest['samples'] if not s['empty'])
    nq = sum(1 for s in manifest['sequences'] if not s['empty'])
    log(f"backup complete: {n} samples, {nq} patterns -> {out}/")


def send_sequence(ms, channel, q, data):
    """Write one pattern: func 0x43 header w/ 3-byte size -> ACK -> raw bytes
    (CmdId 12 direct, no marker in the OUT direction) -> ACK. Mirrors
    SequenceWrite::process; also used standalone by the bridge."""
    _drain(ms)
    ms.send_sysex(P.sequence_header_send(channel, q, len(data)))
    _wait_korg_reply(ms, P.UPLOAD_HDR_OK, P.UPLOAD_HDR_ERR,
                     timeout_ms=8000, what=f'q{q:02d} header ACK')
    if data:
        for off in range(0, len(data), 0x4000):
            ms.dev.write(0x01, data[off:off + 0x4000], timeout=5000)
        _wait_korg_reply(ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                         timeout_ms=15000, what=f'q{q:02d} data ACK')


def _read_wav_as_wire_pcm(path):
    """WAV -> (BE wire PCM bytes, rate, stereo)."""
    with wave.open(path, 'rb') as w:
        if w.getsampwidth() != 2:
            raise DownloadError(f"{path}: expected 16-bit WAV from backup")
        rate, nch = w.getframerate(), w.getnchannels()
        data = w.readframes(w.getnframes())
    samples = array.array('h')
    samples.frombytes(data[:len(data) & ~1])
    if sys.byteorder == 'little':
        samples.byteswap()                       # wire is big-endian
    return samples.tobytes(), rate, nch == 2


def restore(ms, channel, bank, src, log=print):
    with open(os.path.join(src, 'manifest.json')) as f:
        manifest = json.load(f)
    with open(os.path.join(src, 'bank.bin'), 'rb') as f:
        blob = f.read()
    if len(blob) != P.BANK_BLOB_SIZE:
        raise DownloadError(f"bank.bin is {len(blob)} bytes, "
                            f"expected {P.BANK_BLOB_SIZE}")

    # ---- 1. bank blob -----------------------------------------------------
    _drain(ms)
    ms.send_sysex(P.bank_dump_send(channel, blob, bank))
    _wait_korg_reply(ms, P.BANK_SEND_OK, P.BANK_SEND_ERR,
                     timeout_ms=10000, what='bank blob ACK (func 0x23)')
    log(f"bank blob ACKed ('{manifest.get('name', '?')}')")

    try:
        # ---- 2. samples (header + PCM; empty slots = header w/ dataSize 0) --
        for entry in manifest['samples']:
            i = entry['slot']
            if entry['empty']:
                hdr_msg = P.sample_header(channel, i, 0, 48000, False)
                _drain(ms)
                ms.send_sysex(hdr_msg)
                _wait_korg_reply(ms, P.UPLOAD_HDR_OK, P.UPLOAD_HDR_ERR,
                                 timeout_ms=8000, what=f's{i:02d} header ACK')
                log(f"  s{i:02d}: cleared (empty)")
                continue
            pcm, rate, stereo = _read_wav_as_wire_pcm(
                os.path.join(src, 'samples', f's{i:02d}.wav'))
            _drain(ms)
            ms.send_sysex(P.sample_header(channel, i, len(pcm), rate, stereo,
                                          tempo_bpm=entry.get('tempo_bpm', 120.0)))
            _wait_korg_reply(ms, P.UPLOAD_HDR_OK, P.UPLOAD_HDR_ERR,
                             timeout_ms=8000, what=f's{i:02d} header ACK')
            sent = 0
            for off in range(0, len(pcm), 0x4000):
                ms.dev.write(0x01, pcm[off:off + 0x4000], timeout=5000)
                sent += min(0x4000, len(pcm) - off)
                print(f"\r  s{i:02d}: '{entry['name']}' {sent}/{len(pcm)} bytes "
                      f"({sent * 100 // len(pcm)}%)", end='', flush=True)
            print()
            _wait_korg_reply(ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                             timeout_ms=30000, what=f's{i:02d} PCM ACK')
            log(f"  s{i:02d}: '{entry['name']}' {len(pcm)} bytes ok")

        # ---- 3. sequences ----------------------------------------------------
        for entry in manifest['sequences']:
            q = entry['pattern']
            path = os.path.join(src, 'sequences', f'q{q:02d}.bin')
            data = open(path, 'rb').read() if os.path.exists(path) else b''
            send_sequence(ms, channel, q, data)
            if data:
                log(f"  q{q:02d}: {len(data)} bytes")
    finally:
        # ---- 4. leave dump mode (commit) -------------------------------------
        try:
            leave_dump_mode(ms, channel, commit=True)
            log("left dump mode with commit (func 0x1a 01 -> 0x4a ACK)")
        except DownloadError as e:
            log(f"warning: leave-dump-mode: {e} (power-cycle the device "
                  f"if it is unresponsive)")

    where = 'current bank (RAM — save on the device to keep!)' if bank is None \
            else f'user bank {bank + 1} (persistent)'
    log(f"restore complete -> {where}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['backup', 'restore'],
                    help='backup: device bank -> directory; '
                         'restore: directory -> device bank')
    ap.add_argument('src', nargs='?',
                    help='(restore) backup directory to restore from')
    ap.add_argument('-b', '--bank', type=int, choices=range(1, 9), metavar='1..8',
                    help='user bank number 1..8 = A..H (default: current bank)')
    ap.add_argument('-o', '--out', help='(backup) output directory '
                    '(default: bank_current/ or bank_N/)')
    ap.add_argument('--yes', action='store_true', help='skip the restore prompt')
    args = ap.parse_args()

    bank = None if args.bank is None else args.bank - 1

    if args.command == 'backup':
        out = args.out or ('bank_current' if bank is None else f'bank_{args.bank}')
        if os.path.exists(out) and os.listdir(out):
            print(f"{out}/ already exists and is not empty — choose another -o")
            return 1
    else:
        if not args.src or not os.path.isfile(os.path.join(args.src, 'manifest.json')):
            ap.error('restore needs a backup directory (with manifest.json)')
        target = ('the CURRENT bank (RAM)' if bank is None
                  else f'USER BANK {args.bank} — PERSISTENT, saved to flash')
        print(f"About to OVERWRITE {target} with '{args.src}'.")
        if not args.yes and input("Continue? [y/N] ").lower() != 'y':
            print("aborted.")
            return 1

    with MicroSampler() as ms:
        reply, cable = ms.device_inquiry()
        if not reply:
            print("No inquiry reply — is the device on? (power-cycle if wedged)")
            return 1
        channel = reply[2] & 0x0f
        ms.cable = cable
        print(f"microSAMPLER on cable {cable}, global channel {channel + 1}")
        if args.command == 'backup':
            backup(ms, channel, bank, out)
        else:
            restore(ms, channel, bank, args.src)
    return 0


if __name__ == '__main__':
    sys.exit(main())
