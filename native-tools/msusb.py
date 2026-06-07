#!/usr/bin/env python3
"""
microSAMPLER libusb transport — USB-MIDI over the bulk endpoints.

Reverse-engineered from the original editor (DirectUsbAccessBase::sendCommand,
UsbMidiInterpreter::createPackets):
  * Normal control messages are MIDI SysEx, wrapped in 4-byte USB-MIDI event
    packets and written to bulk OUT (0x01).
  * The device streams MIDI Timing Clock (0xF8) continuously, so the receiver
    must filter System Real-Time bytes while reassembling SysEx replies.
  * Bulk sample payloads are sent as RAW 8-bit bytes (see send_raw) — used by the
    uploader, not here.

This module provides the transport plus an `inquiry`/`monitor` CLI to validate
the connection. Run it with sudo on macOS (CoreMIDI holds the interface):
    brew install libusb && python3 -m pip install pyusb
    sudo python3 msusb.py inquiry
    sudo python3 msusb.py monitor
"""
import sys, time

VID, PID = 0x0944, 0x010C
EP_OUT, EP_IN = 0x01, 0x82
PACKET = 64

# ---------------------------------------------------------------------------
# USB-MIDI 4-byte event packet codec  (cable 0)
# ---------------------------------------------------------------------------
def to_usb_midi(midi: bytes, cable: int = 0) -> bytes:
    """Encode a MIDI byte stream (here: one whole SysEx F0..F7) into 4-byte
    USB-MIDI event packets. CIN 0x4 = SysEx start/continue (3 bytes);
    0x5/0x6/0x7 = SysEx ends with 1/2/3 bytes."""
    cn = (cable & 0x0f) << 4
    out = bytearray()
    i, n = 0, len(midi)
    while i < n:
        remaining = n - i
        if remaining > 3:
            out += bytes([cn | 0x04, midi[i], midi[i+1], midi[i+2]]); i += 3
        elif remaining == 3:
            out += bytes([cn | 0x07, midi[i], midi[i+1], midi[i+2]]); i += 3
        elif remaining == 2:
            out += bytes([cn | 0x06, midi[i], midi[i+1], 0]); i += 2
        else:
            out += bytes([cn | 0x05, midi[i], 0, 0]); i += 1
    return bytes(out)


_CIN_LEN = {0x2: 2, 0x3: 3, 0x4: 3, 0x5: 1, 0x6: 2, 0x7: 3, 0x8: 3, 0x9: 3,
            0xa: 3, 0xb: 3, 0xc: 2, 0xd: 2, 0xe: 3, 0xf: 1}

def from_usb_midi(raw: bytes) -> bytes:
    """Decode 4-byte USB-MIDI packets back to a MIDI byte stream."""
    out = bytearray()
    for i in range(0, len(raw) - 3, 4):
        cin = raw[i] & 0x0f
        if cin == 0:
            continue
        out += raw[i+1:i+1 + _CIN_LEN.get(cin, 0)]
    return bytes(out)


# ---------------------------------------------------------------------------
# SysEx reassembler — feed it a MIDI byte stream, get complete F0..F7 messages.
# Skips System Real-Time bytes (0xF8..0xFF) that interleave inside/around SysEx.
# ---------------------------------------------------------------------------
class SysExReassembler:
    def __init__(self):
        self.buf = bytearray()
        self.in_sysex = False

    def feed(self, midi: bytes):
        msgs = []
        for b in midi:
            if 0xf8 <= b <= 0xff:          # System Real-Time — ignore (F8 clock etc.)
                continue
            if b == 0xf0:
                self.buf = bytearray([0xf0]); self.in_sysex = True
            elif b == 0xf7 and self.in_sysex:
                self.buf.append(0xf7); msgs.append(bytes(self.buf)); self.in_sysex = False
            elif self.in_sysex:
                self.buf.append(b)
        return msgs


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------
class MicroSampler:
    def __init__(self, cable=1):
        import usb.core, usb.util
        self.core, self.util = usb.core, usb.util
        self.USBError = usb.core.USBError
        self.dev = usb.core.find(idVendor=VID, idProduct=PID)
        if self.dev is None:
            raise RuntimeError(f"microSAMPLER not found (VID {VID:#06x} PID {PID:#06x}). Plugged in?")
        self.iface = 0
        self.cable = cable          # device talks on USB-MIDI cable 1 (observed)
        self.reasm = SysExReassembler()

    def open(self, verbose=False):
        try:
            if self.dev.is_kernel_driver_active(self.iface):
                self.dev.detach_kernel_driver(self.iface)
                if verbose: print("  detached kernel driver")
        except (NotImplementedError, self.USBError) as e:
            if verbose: print(f"  detach: {e}")
        # Re-assert configuration so the endpoints are active (the OS MIDI driver
        # normally does this; after detach we must do it ourselves).
        try:
            self.dev.set_configuration()
            if verbose: print("  set_configuration() ok")
        except self.USBError as e:
            if verbose: print(f"  set_configuration: {e}")
        self.util.claim_interface(self.dev, self.iface)
        # SET_INTERFACE(alt 0) tells the device to enable the bulk MIDI endpoints.
        try:
            self.dev.set_interface_altsetting(self.iface, 0)
            if verbose: print("  set_interface_altsetting(0,0) ok")
        except self.USBError as e:
            if verbose: print(f"  set_interface_altsetting: {e}")
        for ep in (EP_OUT, EP_IN):
            try:
                self.dev.clear_halt(ep)
                if verbose: print(f"  clear_halt(0x{ep:02x}) ok")
            except self.USBError as e:
                if verbose: print(f"  clear_halt(0x{ep:02x}): {e}")
        return self

    def close(self):
        try: self.util.release_interface(self.dev, self.iface)
        except Exception: pass
        try: self.util.dispose_resources(self.dev)   # drop libusb handles cleanly
        except Exception: pass
        try: self.dev.attach_kernel_driver(self.iface)
        except Exception: pass

    def __enter__(self): return self.open()
    def __exit__(self, *a): self.close()

    # -- raw I/O ----------------------------------------------------------
    def send_sysex(self, midi: bytes, cable=None):
        packets = to_usb_midi(midi, self.cable if cable is None else cable)
        for off in range(0, len(packets), PACKET):
            self.dev.write(EP_OUT, packets[off:off+PACKET], timeout=2000)

    def send_short(self, status, d1, d2, cable=0):
        """Send a 3-byte channel-voice message as one USB-MIDI packet."""
        cin = (status >> 4) & 0x0f          # CIN == status nibble for voice msgs
        pkt = bytes([((cable & 0xf) << 4) | cin, status, d1, d2])
        self.dev.write(EP_OUT, pkt, timeout=2000)

    def send_raw(self, data: bytes, block=0x4000):
        """Raw 8-bit bulk payload (sample PCM). No framing."""
        for off in range(0, len(data), block):
            self.dev.write(EP_OUT, data[off:off+block], timeout=5000)

    def _read_raw(self, timeout=300):
        """One bulk read; returns the raw USB-MIDI packet bytes ([] on timeout)."""
        try:
            return bytes(self.dev.read(EP_IN, PACKET, timeout=timeout))
        except self.USBError as e:
            if e.errno == 60 or 'timed out' in str(e).lower() or 'timeout' in str(e).lower():
                return b''
            raise

    def _read_once(self, timeout=300):
        return self.reasm.feed(from_usb_midi(self._read_raw(timeout)))

    def read_sysex(self, timeout_ms=2000):
        """Wait up to timeout_ms for the next complete SysEx (real-time filtered)."""
        deadline = time.time() + timeout_ms / 1000.0
        while time.time() < deadline:
            for msg in self._read_once():
                return msg
        return None

    # -- high level -------------------------------------------------------
    INQUIRY = bytes([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7])

    def device_inquiry(self, timeout_ms=1500, cables=(1, 0)):
        """Send the inquiry on each candidate cable until a reply arrives."""
        for cable in cables:
            self.send_sysex(self.INQUIRY, cable=cable)
            deadline = time.time() + timeout_ms / 1000.0
            while time.time() < deadline:
                for msg in self._read_once():
                    if len(msg) >= 6 and msg[1] == 0x7e and msg[4] == 0x02:
                        return msg, cable
        return None, None


def _hex(b): return ' '.join(f'{x:02X}' for x in b)


def cmd_inquiry():
    with MicroSampler() as ms:
        print("Sending Device Inquiry on cable 1 then 0 (clock 0xF8 is filtered)...")
        reply, cable = ms.device_inquiry()
        if not reply:
            print("No inquiry reply within timeout. Try:  sudo python3 msusb.py raw")
            return 1
        print(f"Reply (cable {cable}):", _hex(reply))
        if reply[5] == 0x42 and reply[6] == 0x7f:
            print(f"✓ microSAMPLER confirmed — Korg, family 0x{reply[6]:02x}, "
                  f"member 0x{reply[8]:02x}{reply[7]:02x}")
            print(f"  (device speaks on USB-MIDI cable {cable})")
        else:
            print("Replied, but not recognised as microSAMPLER.")
    return 0


def cmd_play():
    """Audible host->device test: play notes on several cables/channels.
    If the microSAMPLER makes ANY sound, libusb host->device works."""
    with MicroSampler() as ms:
        print("Playing test notes. LISTEN to the microSAMPLER (have a sample loaded,")
        print("volume up). Trying cables 0/1 and a few MIDI channels...")
        for cable in (0, 1):
            for ch in (0, 1, 2):           # channels 1,2,3
                for note in (60, 64, 67):
                    print(f"  cable {cable} ch {ch+1} note {note}")
                    ms.send_short(0x90 | ch, note, 100, cable=cable)
                    time.sleep(0.35)
                    ms.send_short(0x80 | ch, note, 0, cable=cable)
                    time.sleep(0.1)
        print("Done. Did you hear anything? (which cable/channel, if so)")
    return 0


def cmd_listen(seconds=12):
    """Dump EVERYTHING received (including clock) for N seconds — confirms the
    device->host path is alive. Start the microSAMPLER sequencer to make it
    stream clock if you want to see traffic."""
    with MicroSampler() as ms:
        print(f"Listening {seconds}s, showing all raw reads (clock included)...")
        end = time.time() + seconds; n = 0
        while time.time() < end:
            raw = ms._read_raw(timeout=400)
            if raw:
                n += len(raw)
                print(f"  {_hex(raw[:20])}{' ...' if len(raw) > 20 else ''}")
        print(f"total bytes received: {n}")
    return 0


def cmd_debug():
    """Verbose: show endpoints, prove the IN path returns data (even clock),
    sweep the inquiry across all 16 cables, and dump everything received."""
    ms = MicroSampler()
    print("Opening device (with config/altsetting/clear_halt):")
    ms.open(verbose=True)
    try:
        cfg = ms.dev.get_active_configuration()
        print("Active config interfaces/endpoints:")
        for itf in cfg:
            for ep in itf:
                print(f"  itf {itf.bInterfaceNumber} ep 0x{ep.bEndpointAddress:02x} "
                      f"attr 0x{ep.bmAttributes:02x} max {ep.wMaxPacketSize}")

        print("\n[A] 12 raw reads BEFORE sending anything (shows what device emits):")
        got = 0
        for k in range(12):
            raw = ms._read_raw(timeout=300)
            if raw:
                got += len(raw)
                print(f"  read {k}: {len(raw)}B  {_hex(raw[:16])}{' ...' if len(raw) > 16 else ''}")
            else:
                print(f"  read {k}: (timeout)")
        print(f"  total bytes in: {got}")

        print("\n[B] Sending inquiry on cables 0..15 (write byte counts):")
        for cable in range(16):
            pkts = to_usb_midi(ms.INQUIRY, cable)
            try:
                n = ms.dev.write(EP_OUT, pkts, timeout=2000)
                print(f"  cable {cable:2d}: wrote {n}B  ({_hex(pkts)})")
            except Exception as e:
                print(f"  cable {cable:2d}: write FAILED {e}")

        print("\n[C] 30 raw reads AFTER (looking for an F0 7E ... reply):")
        for k in range(30):
            raw = ms._read_raw(timeout=300)
            if not raw:
                continue
            midi = from_usb_midi(raw)
            mark = "  <-- has F0!" if 0xf0 in midi else ""
            # show non-clock content
            nonclock = bytes(b for b in midi if not (0xf8 <= b <= 0xff))
            if nonclock or mark:
                print(f"  read {k}: {_hex(raw[:24])}  midi={_hex(midi)}{mark}")
        print("done.")
    finally:
        ms.close()
    return 0


def cmd_raw(seconds=6):
    """Dump every incoming USB-MIDI packet (cable/CIN/bytes), skipping pure clock,
    and fire an inquiry on each cable so we can see what comes back."""
    with MicroSampler() as ms:
        print(f"Listening {seconds}s. Sending an inquiry on cables 0..3 meanwhile.")
        end = time.time() + seconds
        sent = 0
        while time.time() < end:
            if sent < 4:
                ms.send_sysex(ms.INQUIRY, cable=sent); sent += 1
            raw = ms._read_raw(timeout=250)
            for i in range(0, len(raw) - 3, 4):
                cin = raw[i] & 0x0f; cable = raw[i] >> 4
                body = raw[i+1:i+4]
                if cin == 0x0f and body and body[0] in (0xf8, 0xfe):
                    continue   # timing clock / active sensing
                if cin == 0:
                    continue
                print(f"  cable {cable}  CIN 0x{cin:x}  {_hex(body)}")
    return 0


_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def _note_name(n):
    return f"{_NOTE_NAMES[n % 12]}{n // 12 - 1}"


class MidiPrinter:
    """Decode USB-MIDI packets to readable lines: notes, CC (with NRPN/RPN
    accumulation), program change, pitch bend, aftertouch and SysEx. Real-time
    (clock/active-sensing) is counted, not printed."""

    def __init__(self, show=print):
        self.show = show
        self.reasm = SysExReassembler()
        self.nrpn = {}                   # channel -> [nrpn_msb, nrpn_lsb]
        self.clock = 0

    def feed_packet(self, pkt):
        cin, cable = pkt[0] & 0x0f, pkt[0] >> 4
        b = pkt[1:4]
        if cin == 0 or (cin in (0x5, 0xf) and b[0] in (0xf8, 0xfe)):
            if b[0] == 0xf8:
                self.clock += 1
            return
        if cin in (0x4, 0x5, 0x6, 0x7):              # SysEx fragments
            for msg in self.reasm.feed(b[:_CIN_LEN[cin]]):
                note = ''
                if len(msg) >= 12 and msg[1] == 0x42 and msg[4] == 0x41:
                    # Parameter Change: 3x 14-bit LE (object, param, value);
                    # sample slots are object 16+slot (hardware-verified).
                    o = msg[5] | (msg[6] << 7)
                    p = msg[7] | (msg[8] << 7)
                    v = msg[9] | (msg[10] << 7)
                    tgt = f"sample {o - 16 + 1}" if o >= 16 else f"object {o}"
                    note = f"  <- Param Change {tgt}: #{p} = {v}"
                self.show(f"cable {cable}  SysEx {_hex(msg)}{note}")
            return
        st, d1, d2 = b[0], b[1], b[2]
        ch = (st & 0x0f) + 1
        typ = st & 0xf0
        if typ == 0x90 and d2 > 0:
            self.show(f"cable {cable}  ch{ch:2d}  Note On  {_note_name(d1)} vel {d2}")
        elif typ == 0x80 or (typ == 0x90 and d2 == 0):
            self.show(f"cable {cable}  ch{ch:2d}  Note Off {_note_name(d1)}")
        elif typ == 0xb0:
            self._cc(cable, ch, d1, d2)
        elif typ == 0xc0:
            self.show(f"cable {cable}  ch{ch:2d}  Program Change {d1}")
        elif typ == 0xd0:
            self.show(f"cable {cable}  ch{ch:2d}  Channel Pressure {d1}")
        elif typ == 0xe0:
            self.show(f"cable {cable}  ch{ch:2d}  Pitch Bend {((d2 << 7) | d1) - 8192:+d}")
        else:
            self.show(f"cable {cable}  raw {_hex(b)}")

    def _cc(self, cable, ch, cc, val):
        state = self.nrpn.setdefault(ch, [None, None])
        if cc == 99:
            state[0] = val; return
        if cc == 98:
            state[1] = val; return
        if cc == 6 and state[0] is not None:
            n = (state[0] << 7) | (state[1] or 0)
            self.show(f"cable {cable}  ch{ch:2d}  NRPN #{n} = {val} (MSB)")
            return
        if cc == 38 and state[0] is not None:
            n = (state[0] << 7) | (state[1] or 0)
            self.show(f"cable {cable}  ch{ch:2d}  NRPN #{n} (LSB) = {val}")
            return
        self.show(f"cable {cable}  ch{ch:2d}  CC {cc} = {val}")


def cmd_monitor():
    with MicroSampler() as ms:
        print("Monitoring ALL MIDI from the device (Ctrl+C to stop).")
        print("Move knobs / play pads / edit on the panel...")
        mp = MidiPrinter()
        try:
            while True:
                raw = ms._read_raw(timeout=500)
                for i in range(0, len(raw) - 3, 4):
                    mp.feed_packet(raw[i:i + 4])
        except KeyboardInterrupt:
            print(f"\nstopped. ({mp.clock} clock ticks seen — device alive)")
    return 0


def _selftest():
    # Round-trip the codec and the reassembler.
    sysex = bytes([0xf0, 0x42, 0x30, 0x7f, 0x41, 0x2c, 0x02, 0x08, 0x27, 0xf7])
    packets = to_usb_midi(sysex)
    assert len(packets) % 4 == 0
    decoded = from_usb_midi(packets)
    assert decoded == sysex, decoded.hex()
    # Reassembler must rebuild it even with interleaved clock bytes.
    r = SysExReassembler()
    stream = bytes([0xf8]) + decoded[:3] + bytes([0xf8]) + decoded[3:] + bytes([0xfe])
    msgs = r.feed(stream)
    assert msgs == [sysex], msgs
    # Inquiry request encodes to two packets.
    assert to_usb_midi(bytes([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7])) == \
        bytes([0x04, 0xf0, 0x7e, 0x7f, 0x07, 0x06, 0x01, 0xf7])
    # MidiPrinter: notes, CC, NRPN accumulation, clock filtering, SysEx.
    lines = []
    mp = MidiPrinter(show=lines.append)
    mp.feed_packet(bytes([0x1f, 0xf8, 0, 0]))                 # clock -> counted
    mp.feed_packet(bytes([0x19, 0x90, 60, 100]))              # note on C4
    mp.feed_packet(bytes([0x18, 0x80, 60, 0]))                # note off
    mp.feed_packet(bytes([0x1b, 0xb0, 7, 99]))                # CC 7
    mp.feed_packet(bytes([0x1b, 0xb0, 99, 1]))                # NRPN MSB
    mp.feed_packet(bytes([0x1b, 0xb0, 98, 2]))                # NRPN LSB
    mp.feed_packet(bytes([0x1b, 0xb0, 6, 42]))                # NRPN data
    pc = bytes([0xf0, 0x42, 0x30, 0x7f, 0x41,
                0x1c, 0x00, 0x11, 0x00, 0x02, 0x00, 0xf7])    # real capture
    pkts = to_usb_midi(pc, 1)
    for i in range(0, len(pkts), 4):
        mp.feed_packet(pkts[i:i+4])
    assert mp.clock == 1
    assert any('Note On  C4 vel 100' in l for l in lines), lines
    assert any('Note Off C4' in l for l in lines)
    assert any('CC 7 = 99' in l for l in lines)
    assert any('NRPN #130 = 42' in l for l in lines)
    assert any('Param Change sample 13: #17 = 2' in l for l in lines), lines
    print("self-test: OK")
    return 0


def cmd_params(slot):
    """Fetch + hex-dump a sample's 64-byte param blob (standalone func 0x14 --
    session-safe, hardware-proven). For correlating panel switch states with
    blob bytes: change a switch on the panel, re-run, diff the lines."""
    import download as DL
    ms = MicroSampler()
    ms.open()
    try:
        reply, _ = ms.device_inquiry(cables=(1,))
        if not reply:
            print('no inquiry reply -- device off or wedged?')
            return 1
        ch = reply[2] & 0x0f
        par = DL.fetch_params(ms, ch, slot)
        raw = par['raw']
        print("slot %d  name '%s'" % (slot, par['name']))
        for off in range(0, 64, 16):
            print('  %02x: %s' % (off, raw[off:off + 16].hex(' ')))
        f = raw[8]
        print('  flags8=0x%02x  bits[7..0]=%s   (b3=FXSW b7=EMPTY; '
              'b4/b5/b6 = loop/reverse/bpmsync candidates)'
              % (f, format(f, '08b')))
        print('  b09=%02x b0a=%02x b0b=%02x b16=%02x b1c..1f=%s'
              % (raw[9], raw[0xa], raw[0xb], raw[0x16], raw[0x1c:0x20].hex(' ')))
    finally:
        ms.close()
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'inquiry'
    if cmd == 'inquiry':  return cmd_inquiry()
    if cmd == 'monitor':  return cmd_monitor()
    if cmd == 'raw':      return cmd_raw()
    if cmd == 'debug':    return cmd_debug()
    if cmd == 'play':     return cmd_play()
    if cmd == 'listen':   return cmd_listen()
    if cmd == 'params':   return cmd_params(int(sys.argv[2]))
    if cmd == 'selftest': return _selftest()
    print(__doc__); print(f"\nunknown command: {cmd}"); return 2


if __name__ == "__main__":
    sys.exit(main())
