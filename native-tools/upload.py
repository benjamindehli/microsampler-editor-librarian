#!/usr/bin/env python3
"""
microSAMPLER sample UPLOAD (host -> device).

Mirrors SampleWrite::process from the original editor:
  1. func 0x42 (ss|0x40) + 8-byte header (7-bit enc)  -> ACK
     (funcs 0x23/0x27 = ok, 0x28/0x29 = error)
  2. raw 16-bit BIG-endian PCM straight to bulk OUT in 0x4000-byte blocks, no framing
     (no marker in this direction — verified in DirectUsbAccessBase::sendCommand)
     -> ACK (funcs 0x21/0x23 = ok, 0x22/0x24 = error)
  3. func 0x44 ss + 64-byte param blob (7-bit enc) -> ACK

Audio input: WAV (stdlib `wave`; PCM 8/16/24/32-bit, mono or stereo). Resampled
with linear interpolation to the nearest supported rate (48/24/12/6 kHz) unless
--rate forces one.

SAFETY: this OVERWRITES the target slot on the device. Test on a FREE slot.
`--dry-run` converts and prints everything without touching the device.
NOTE: after `--header-only` the device may sit waiting for PCM — power-cycle it
before doing anything else.

PERSISTENCE (by design, per the editor manual): transfers go to the device's
CURRENT BANK, which is RAM — lost on power-off or bank switch. To keep the
sample, save the current bank to a user bank on the device afterwards.
Use `--verify` to read the sample back in the same USB session and compare
byte-for-byte (separate back-to-back sessions tend to wedge the device).

Usage:
  sudo python3 upload.py kick.wav 35 --name "KICK 01"
  sudo python3 upload.py kick.wav 35 --params sample00.param.bin
  python3 upload.py kick.wav 35 --dry-run
"""
import argparse, os, sys, wave
from array import array

from msusb import MicroSampler, _hex
import protocol as P
from download import (_drain, _wait_korg_reply,
                      fetch_header, fetch_pcm, fetch_params)

RATES = (48000, 24000, 12000, 6000)


# --- audio loading / conversion ---------------------------------------------
def load_wav(path):
    """-> (list of per-channel array('h'), rate)"""
    with wave.open(path, 'rb') as w:
        nch, width, rate, nframes = (w.getnchannels(), w.getsampwidth(),
                                     w.getframerate(), w.getnframes())
        raw = w.readframes(nframes)
    if nch not in (1, 2):
        raise SystemExit(f"unsupported channel count {nch} (mono/stereo only)")

    samples = array('h')
    if width == 2:
        samples.frombytes(raw)
        if sys.byteorder == 'big':
            samples.byteswap()
    elif width == 1:                      # 8-bit unsigned
        samples.extend((b - 128) << 8 for b in raw)
    elif width in (3, 4):                 # take the top 16 bits
        for i in range(0, len(raw), width):
            samples.append(int.from_bytes(raw[i:i+width], 'little', signed=True)
                           >> (8 * (width - 2)))
    else:
        raise SystemExit(f"unsupported sample width {width}")

    chans = [samples[c::nch] for c in range(nch)]
    return chans, rate


def resample_channel(ch, src_rate, dst_rate):
    """Linear interpolation; good enough for a sampler transfer tool."""
    if src_rate == dst_rate:
        return ch
    n_out = max(1, int(round(len(ch) * dst_rate / src_rate)))
    out = array('h', bytes(2 * n_out))
    step = (len(ch) - 1) / (n_out - 1) if n_out > 1 else 0.0
    for i in range(n_out):
        pos = i * step
        j = int(pos)
        frac = pos - j
        a = ch[j]
        b = ch[j + 1] if j + 1 < len(ch) else a
        out[i] = int(a + (b - a) * frac)
    return out


def to_device_pcm(chans, rate, target_rate):
    """-> interleaved 16-bit signed BIG-endian bytes (the wire byte order:
    getPackedSampleData writes high byte first; LE comes out as noise)."""
    chans = [resample_channel(c, rate, target_rate) for c in chans]
    frames = min(len(c) for c in chans)
    inter = array('h', bytes(2 * frames * len(chans)))
    for c, ch in enumerate(chans):
        inter[c::len(chans)] = ch[:frames]
    if sys.byteorder == 'little':
        inter.byteswap()
    return inter.tobytes(), frames


# --- upload phases ------------------------------------------------------------
def upload(ms, channel, slot, pcm, rate, stereo, frames, blob, tempo, mode_bit=0):
    # phase 1: header
    _drain(ms)
    ms.send_sysex(P.sample_header(channel, slot, len(pcm), rate, stereo,
                                  tempo_bpm=tempo, mode_bit=mode_bit))
    _wait_korg_reply(ms, P.UPLOAD_HDR_OK, P.UPLOAD_HDR_ERR,
                     timeout_ms=8000, what='header ACK')
    print("  header ACKed")

    # phase 2: raw PCM, 0x4000-byte blocks
    sent = 0
    for off in range(0, len(pcm), 0x4000):
        ms.dev.write(0x01, pcm[off:off + 0x4000], timeout=5000)
        sent += len(pcm[off:off + 0x4000])
        print(f"\r  PCM {sent}/{len(pcm)} bytes ({sent * 100 // len(pcm)}%)",
              end='', flush=True)
    print()
    _wait_korg_reply(ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                     timeout_ms=30000, what='PCM ACK')
    print("  PCM ACKed")

    # phase 3: parameter blob
    ms.send_sysex(P.sample_param_send(channel, slot, blob))
    _wait_korg_reply(ms, P.UPLOAD_DATA_OK, P.UPLOAD_DATA_ERR,
                     timeout_ms=8000, what='param ACK')
    print("  params ACKed")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('wav', help='input WAV file (PCM)')
    ap.add_argument('slot', type=int, help='target sample slot 0..35 (OVERWRITTEN!)')
    ap.add_argument('--name', help='8-char sample name (default: from filename)')
    ap.add_argument('--long-name', help='long name <=32 bytes (default: filename)')
    ap.add_argument('--rate', type=int, choices=RATES,
                    help='force target rate (default: nearest of 48/24/12/6 kHz)')
    ap.add_argument('--tempo', type=float, default=120.0,
                    help='sample tempo BPM 20.0..300.0 (default 120)')
    ap.add_argument('--params', metavar='BIN',
                    help='64-byte .param.bin template from download.py '
                         '(names/points patched, rest kept)')
    ap.add_argument('--dry-run', action='store_true',
                    help='convert + print everything; do not touch the device')
    ap.add_argument('--header-only', action='store_true',
                    help='send only phase 1 (DEVICE WILL WAIT FOR PCM — '
                         'power-cycle it afterwards)')
    ap.add_argument('--verify', action='store_true',
                    help='read the sample back in the SAME session afterwards '
                         'and compare byte-for-byte (recommended)')
    ap.add_argument('--yes', action='store_true', help='skip the overwrite prompt')
    args = ap.parse_args()
    if not 0 <= args.slot <= 35:
        ap.error('slot must be 0..35')

    base = os.path.splitext(os.path.basename(args.wav))[0]
    name = (args.name or base)[:8].upper()
    long_name = args.long_name or base

    chans, in_rate = load_wav(args.wav)
    rate = args.rate or min(RATES, key=lambda r: abs(r - in_rate))
    pcm, frames = to_device_pcm(chans, in_rate, rate)
    stereo = len(chans) == 2

    template = None
    if args.params:
        with open(args.params, 'rb') as f:
            template = f.read()
        if len(template) < 64:
            raise SystemExit(f'{args.params}: expected 64 bytes, got {len(template)}')
    blob = P.build_param_blob(name, long_name, 0, frames, template)

    print(f"{args.wav}: {in_rate} Hz {'stereo' if stereo else 'mono'} "
          f"-> {rate} Hz, {frames} frames, {len(pcm)} bytes "
          f"({frames / rate:.2f} s)")
    print(f"slot {args.slot}  name '{name}'  long '{long_name}'  "
          f"tempo {args.tempo:.1f}  params {'template ' + args.params if template else 'defaults'}")
    if args.dry_run:
        print("header:", _hex(P.korg_decode(
            P.sample_header(0, args.slot, len(pcm), rate, stereo, args.tempo)[6:-1])))
        print("blob:  ", _hex(blob))
        print("dry run — nothing sent.")
        return 0

    if not args.yes:
        if input(f"OVERWRITE slot {args.slot} on the device? [y/N] ").lower() != 'y':
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

        if args.header_only:
            _drain(ms)
            ms.send_sysex(P.sample_header(channel, args.slot, len(pcm), rate,
                                          stereo, tempo_bpm=args.tempo))
            _wait_korg_reply(ms, P.UPLOAD_HDR_OK, P.UPLOAD_HDR_ERR,
                             timeout_ms=8000, what='header ACK')
            print("header ACKed — STOPPING (power-cycle the device now).")
            return 0

        upload(ms, channel, args.slot, pcm, rate, stereo, frames, blob, args.tempo)
        print(f"done — slot {args.slot} written to the device's CURRENT BANK (RAM).")

        if args.verify:
            print("verifying (same session)...")
            hdr = fetch_header(ms, channel, args.slot)
            ok_hdr = (hdr['data_size'] == len(pcm) and hdr['rate_hz'] == rate
                      and hdr['stereo'] == stereo)
            print(f"  header: dataSize {hdr['data_size']} rate {hdr['rate_hz']} "
                  f"{'stereo' if hdr['stereo'] else 'mono'} "
                  f"-> {'OK' if ok_hdr else 'MISMATCH'}")
            got = fetch_pcm(ms, channel, hdr['data_size'])
            ok_pcm = got == pcm
            print(f"  PCM: {'IDENTICAL' if ok_pcm else 'DIFFERS'} "
                  f"({len(got)} bytes read back)")
            par = fetch_params(ms, channel, args.slot)
            ok_par = par['raw'] == blob
            print(f"  params: name '{par['name']}' "
                  f"{'IDENTICAL' if ok_par else 'DIFFERS'}")
            if not (ok_hdr and ok_pcm and ok_par):
                print("VERIFY FAILED — round-trip is not byte-exact.")
                return 1
            print("VERIFY OK — byte-exact round-trip.")

        print("NOTE: the current bank is volatile — save it to a user bank on "
              "the device (see its Owner's Manual) to keep the sample after "
              "power-off or bank switch.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
