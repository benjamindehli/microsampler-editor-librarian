#!/usr/bin/env python3
"""
microSAMPLER sample DOWNLOAD (device -> host).

Mirrors SampleReceiveInternal::process from the original editor:
  1. Device inquiry -> global MIDI channel.
  2. func 0x16 (ss|0x40)  -> reply func 0x42: 8-byte packed header
     (u32 dataSize, u16 tempo*10, flags, 0xFF). func 0x29 = error.
     dataSize == 0 -> slot is empty, stop.
  3. func 0x1F (no args)  -> device sends one 64-byte DIRECT_MARKER block
     (FF FF FF + 61*00) on bulk IN, then dataSize bytes of RAW PCM
     (16-bit signed BIG-endian, interleaved — hardware-verified; LE sounds
     like noise). funcs 0x24/0x26 = error.
  4. func 0x14 ss         -> reply func 0x44: 64-byte parameter blob
     (7-bit encoded).

Saves ground-truth artifacts next to the chosen output name:
  <out>.wav         the audio (stdlib wave module)
  <out>.header.bin  raw 8-byte packed header
  <out>.param.bin   raw 64-byte parameter blob

Usage (CoreMIDI owns the interface, so sudo):
  sudo python3 download.py 0                  # sample 1 -> sample00.*
  sudo python3 download.py 0 -o kick          # -> kick.wav / kick.*.bin
  sudo python3 download.py 0 --header-only    # phase 1 only (safest probe)
  sudo python3 download.py 0 --no-data        # header + params, skip PCM
"""
import argparse, array, sys, time, wave

from msusb import MicroSampler, from_usb_midi, _hex, PACKET, EP_IN
import protocol as P


class DownloadError(RuntimeError):
    pass


# Error funcs per phase (CommandIds 0x19/0x1a/0x1d -> funcs 0x24/0x26/0x29)
HEADER_ERR_FUNCS = {0x29}
DATA_ERR_FUNCS = {0x24, 0x26}


def _drain(ms, ms_quiet=250):
    """Discard pending input until the pipe is quiet (clock keeps trickling,
    so just a few short reads)."""
    end = time.time() + ms_quiet / 1000.0
    while time.time() < end:
        if not ms._read_raw(timeout=50):
            break


def _wait_korg_reply(ms, want_funcs, err_funcs, timeout_ms=5000, what=''):
    """Read SysEx until one of want_funcs arrives; raise on err_funcs."""
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        msg = ms.read_sysex(timeout_ms=300)
        if not msg or len(msg) < 5 or msg[1] != P.KORG:
            continue
        func = msg[4]
        if func in err_funcs:
            raise DownloadError(f"device returned error func 0x{func:02x} ({what})")
        if func in want_funcs:
            return msg
    raise DownloadError(f"timeout waiting for {what}")


def fetch_header(ms, channel, sample_no):
    _drain(ms)
    ms.send_sysex(P.sample_dump_request(channel, sample_no))
    msg = _wait_korg_reply(ms, {0x42}, HEADER_ERR_FUNCS, what='sample header (func 0x42)')
    hdr = P.parse_sample_header(msg)
    if hdr is None:
        raise DownloadError(f"unparseable header reply: {_hex(msg)}")
    return hdr


def fetch_direct(ms, request_msg, data_size, progress=True, label='PCM'):
    """Send a data-dump request, then: parse USB-MIDI until the 64-byte
    DIRECT_MARKER block, then read data_size raw bytes (the original reads
    <=0x4000 per chunk). Shared by sample PCM (func 0x1F) and sequence data
    (func 0x1D)."""
    _drain(ms)
    ms.send_sysex(request_msg)

    # -- wait for the marker, watching for an error SysEx meanwhile ----------
    deadline = time.time() + 10.0
    while True:
        if time.time() > deadline:
            raise DownloadError("timeout waiting for direct-data marker")
        raw = ms._read_raw(timeout=500)
        if not raw:
            continue
        if raw == P.DIRECT_MARKER:
            break
        for msg in ms.reasm.feed(from_usb_midi(raw)):
            if len(msg) >= 5 and msg[1] == P.KORG and msg[4] in DATA_ERR_FUNCS:
                raise DownloadError(f"device returned error func 0x{msg[4]:02x} ({label} phase)")

    # -- raw mode: everything from here is PCM until data_size bytes ---------
    pcm = bytearray()
    deadline = time.time() + 60.0
    while len(pcm) < data_size:
        if time.time() > deadline:
            raise DownloadError(f"{label} stalled at {len(pcm)}/{data_size} bytes")
        remaining = data_size - len(pcm)
        # request a multiple of the 64B packet size; a short packet ends the read
        want = min(0x4000, (remaining + PACKET - 1) // PACKET * PACKET)
        try:
            chunk = bytes(ms.dev.read(EP_IN, want, timeout=5000))
        except ms.USBError as e:
            if 'time' in str(e).lower():
                continue
            raise
        if chunk:
            pcm += chunk
            deadline = time.time() + 60.0
            if progress:
                pct = min(100, len(pcm) * 100 // data_size)
                print(f"\r  {label} {len(pcm)}/{data_size} bytes ({pct}%)",
                      end='', flush=True)
    if progress:
        print()
    return bytes(pcm[:data_size])


def fetch_pcm(ms, channel, data_size, progress=True):
    """Sample PCM: func 0x1F then marker + raw bytes."""
    return fetch_direct(ms, P.sample_data_dump_request(channel), data_size,
                        progress=progress, label='PCM')


def fetch_params(ms, channel, sample_no):
    _drain(ms)
    ms.send_sysex(P.sample_param_dump_request(channel, sample_no))
    msg = _wait_korg_reply(ms, {0x44}, HEADER_ERR_FUNCS | DATA_ERR_FUNCS,
                           what='sample parameters (func 0x44)')
    par = P.parse_sample_param(msg)
    if par is None:
        raise DownloadError(f"unparseable param reply: {_hex(msg)}")
    return par


def write_wav(path, pcm, rate_hz, stereo):
    # Wire PCM is 16-bit signed BIG-endian (setByPackedData: first byte << 8);
    # WAV wants little-endian, so swap.
    samples = array.array('h')
    samples.frombytes(pcm[:len(pcm) & ~1])
    if sys.byteorder == 'little':
        samples.byteswap()
    with wave.open(path, 'wb') as w:
        w.setnchannels(2 if stereo else 1)
        w.setsampwidth(2)
        w.setframerate(rate_hz)
        w.writeframes(samples.tobytes())


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('sample', type=int, help='sample slot 0..35')
    ap.add_argument('-o', '--out', help='output basename (default sampleNN)')
    ap.add_argument('--header-only', action='store_true',
                    help='phase 1 only: print the header and stop')
    ap.add_argument('--no-data', action='store_true',
                    help='skip the PCM phase (header + parameters only)')
    args = ap.parse_args()
    if not 0 <= args.sample <= 35:
        ap.error('sample must be 0..35')
    out = args.out or f'sample{args.sample:02d}'

    with MicroSampler() as ms:
        reply, cable = ms.device_inquiry()
        if not reply:
            print("No inquiry reply — is the device on? (power-cycle if wedged)")
            return 1
        channel = reply[2] & 0x0f
        ms.cable = cable
        print(f"microSAMPLER on cable {cable}, global channel {channel + 1}")

        # ---- phase 1: header ------------------------------------------------
        hdr = fetch_header(ms, channel, args.sample)
        print(f"header: {_hex(hdr['raw'])}")
        print(f"  dataSize {hdr['data_size']}  rate {hdr['rate_hz']} Hz  "
              f"{'stereo' if hdr['stereo'] else 'mono'}  "
              f"tempo {hdr['tempo_bpm']:.1f} BPM  mode_bit {hdr['mode_bit']}")
        with open(f'{out}.header.bin', 'wb') as f:
            f.write(hdr['raw'])
        print(f"  -> {out}.header.bin")
        if hdr['data_size'] == 0:
            print("slot is empty (dataSize 0) — nothing more to fetch.")
            return 0
        if args.header_only:
            print("WARNING: func 0x16 SELECTED this sample — the device now "
                  "waits for the data dump and will refuse further commands "
                  "until a full download of this slot or a POWER-CYCLE "
                  "(hardware-verified; the param request does NOT release it).")
            return 0

        # ---- phase 2: PCM ---------------------------------------------------
        pcm = None
        if not args.no_data:
            print("requesting PCM (func 0x1F)...")
            pcm = fetch_pcm(ms, channel, hdr['data_size'])
            write_wav(f'{out}.wav', pcm, hdr['rate_hz'], hdr['stereo'])
            ch = 2 if hdr['stereo'] else 1
            frames = len(pcm) // (2 * ch)
            print(f"  -> {out}.wav  ({frames} frames, {frames / hdr['rate_hz']:.2f} s)")

        # ---- phase 3: parameters --------------------------------------------
        par = fetch_params(ms, channel, args.sample)
        with open(f'{out}.param.bin', 'wb') as f:
            f.write(par['raw'])
        print(f"params: name '{par['name']}'  long '{par['long_name']}'")
        print(f"  semitone {par['semitone']:+d}  tune {par['tune']:+d}  "
              f"flags8 0x{par['flags8']:02x}  u32@0c {par['u32_0c']}  u32@10 {par['u32_10']}")
        print(f"  b14 {par['b14']}  b15 {par['b15']}  b17 {par['b17']}  "
              f"b18 {par['b18']}  b1a {par['b1a']}")
        print(f"  -> {out}.param.bin")
    return 0


if __name__ == '__main__':
    sys.exit(main())
