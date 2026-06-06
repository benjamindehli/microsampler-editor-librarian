#!/usr/bin/env python3
"""
Korg microSAMPLER SysEx + sample protocol (reverse-engineered from the original
editor binary). Pure logic, no I/O — unit-testable. Used by the uploader on top
of the msusb transport.

Header bytes that the device expects:  F0 42 3g 7F <func> <payload> F7
  42=Korg, 3g=0x30|globalChannel, 7F=microSAMPLER model byte.

Korg 7-bit data encoding (from SysExCommand::getSysExData tail): data is sent in
groups of 7 bytes preceded by one "MSB" byte whose bit i holds bit7 of data
byte i; the 7 data bytes follow with bit7 cleared. convert7to8 is the inverse.
"""

SOX, EOX, KORG, MODEL = 0xf0, 0xf7, 0x42, 0x7f

# Sample rate -> code (from SampleData::getPackedSampleHeader comparisons)
RATE_CODE = {48000: 0, 24000: 1, 12000: 2, 6000: 3}
CODE_RATE = {v: k for k, v in RATE_CODE.items()}


def fmt_byte(channel): return 0x30 | (channel & 0x0f)


# --- Korg 7<->8 bit packing -------------------------------------------------
def korg_encode(data: bytes) -> bytes:
    out = bytearray()
    for i in range(0, len(data), 7):
        chunk = data[i:i + 7]
        msb = 0
        for j, b in enumerate(chunk):
            if b & 0x80:
                msb |= (1 << j)
        out.append(msb)
        out.extend(b & 0x7f for b in chunk)
    return bytes(out)


def korg_decode(enc: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(enc):
        msb = enc[i]; i += 1
        for j in range(7):
            if i >= len(enc):
                break
            b = enc[i]; i += 1
            out.append(b | 0x80 if (msb >> j) & 1 else b)
    return bytes(out)


# --- 14-bit values (parameter change etc.) ----------------------------------
def pack14(v): return [v & 0x7f, (v >> 7) & 0x7f]
def unpack14(lo, hi): return (lo & 0x7f) | ((hi & 0x7f) << 7)


# --- Message builders -------------------------------------------------------
def device_inquiry():
    return bytes([SOX, 0x7e, 0x7f, 0x06, 0x01, EOX])


# --- Sample DOWNLOAD (decoded from SampleReceiveInternal::process) -----------
# Direct-mode marker: before dumping raw PCM the device sends one 64-byte bulk
# block of FF FF FF + 61 zero bytes (DirectUsbAccessBase ctor builds the same
# block to memcmp against in runReceiveDataFromUsb).
DIRECT_MARKER = bytes([0xff, 0xff, 0xff]) + bytes(61)


def sample_dump_request(channel, sample_no):
    """CmdId 1 / func 0x16: ask for sample `sample_no` (0..35). The 0x40 bit is
    ParameterId 3 = 1 (same flag the uploader sets). Reply: func 0x42 header
    (or func 0x29 error, e.g. empty protected slot)."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x16,
                  (sample_no & 0x3f) | 0x40, EOX])


def sample_data_dump_request(channel):
    """CmdId 7 / func 0x1f: no parameters — the preceding func 0x16 selected the
    sample. Device answers with DIRECT_MARKER then `dataSize` raw PCM bytes
    (16-bit signed BIG-endian, interleaved). Error replies: func 0x24 / 0x26."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x1f, EOX])


def sample_param_dump_request(channel, sample_no):
    """CmdId 5 / func 0x14: request the 64-byte parameter blob (no 0x40 bit).
    Reply: func 0x44 with the 7-bit-encoded blob."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x14, sample_no & 0x3f, EOX])


def parse_sample_header(msg: bytes):
    """Parse a func 0x42 reply: F0 42 3g 7F 42 (ss|0x40) <9B enc> F7 ->
    dict with the 8-byte PackedSampleHeader fields. The u16 at +4 is the sample
    tempo in 0.1 BPM (SampleData::setParameter(7,...), clipped 200..3000)."""
    if len(msg) < 8 or msg[1] != KORG or msg[4] != 0x42:
        return None
    hdr = korg_decode(msg[6:-1])
    if len(hdr) < 8:
        return None
    data_size = hdr[0] | (hdr[1] << 8) | (hdr[2] << 16) | (hdr[3] << 24)
    tempo10 = hdr[4] | (hdr[5] << 8)
    flags = hdr[6]
    return {
        'sample_no': msg[5] & 0x3f,
        'data_size': data_size,
        'tempo_bpm': tempo10 / 10.0,
        'stereo': bool(flags & 1),
        'rate_hz': CODE_RATE.get((flags >> 2) & 3),
        'mode_bit': (flags >> 5) & 1,          # send-side: (obj+0xec != 1)
        'flags': flags,
        'raw': hdr[:8],
    }


def parse_param_blob(blob: bytes):
    """Decode a 64-byte PackedSampleParameter blob into fields."""
    blob = bytes(blob[:64])
    return {
        'name': blob[0:8].decode('latin1').rstrip(),
        'long_name': blob[0x20:0x40].split(b'\xff')[0].split(b'\x00')[0]
                      .decode('utf-8', 'replace').rstrip(),
        'flags8': blob[8],
        'u32_0c': int.from_bytes(blob[0x0c:0x10], 'little'),   # start frame
        'u32_10': int.from_bytes(blob[0x10:0x14], 'little'),   # end frame
        'b14': blob[0x14], 'b15': blob[0x15], 'b17': blob[0x17], 'b18': blob[0x18],
        'semitone': blob[0x19] - 0x40,         # stored +0x40
        'b1a': blob[0x1a],
        'tune': blob[0x1b] - 0x40,             # stored +0x40
        'raw': blob,
    }


def parse_sample_param(msg: bytes):
    """Parse a func 0x44 reply: F0 42 3g 7F 44 ss <74B enc> F7 -> 64-byte blob
    plus the fields whose layout getPackedSampleParameter revealed."""
    if len(msg) < 8 or msg[1] != KORG or msg[4] != 0x44:
        return None
    blob = korg_decode(msg[6:-1])
    if len(blob) < 64:
        return None
    out = parse_param_blob(blob)
    out['sample_no'] = msg[5] & 0x3f
    return out


# --- Bank level (decoded from BankWrite/BankReceive::process) -----------------
# Bank payload = 0x974 bytes: 64B bank param + 36*64B sample params +
# 16*1B sequence lengths (@0x940) + 36B packed effect data (@0x950).
BANK_BLOB_SIZE = 0x974


def bank_dump_request(channel, bank=None):
    """CmdId 0 / func 0x10 = current bank; CmdId 3 / func 0x1c <bank 0..7> =
    user bank A..H. Reply: func 0x40 / 0x4c with the 0x974-byte blob."""
    if bank is None:
        return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x10, EOX])
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x1c, bank & 0x07, EOX])


def parse_bank_dump(msg: bytes):
    """Parse a func 0x40 (current bank, no param byte) or func 0x4c (user bank,
    one bank# byte) reply into the bank blob + decoded summary fields."""
    if len(msg) < 6 or msg[1] != KORG or msg[4] not in (0x40, 0x4c):
        return None
    body = msg[5:-1] if msg[4] == 0x40 else msg[6:-1]
    blob = korg_decode(body)
    if len(blob) < BANK_BLOB_SIZE:
        return None
    blob = blob[:BANK_BLOB_SIZE]
    return {
        'bank': (msg[5] & 0x07) if msg[4] == 0x4c else None,
        'name': blob[0:8].decode('latin1').rstrip(),
        'bpm': (blob[8] | (blob[9] << 8)) / 10.0,
        'flag_0b': blob[0x0b],
        'sample_params': [parse_param_blob(blob[0x40 + i*0x40: 0x80 + i*0x40])
                          for i in range(36)],
        'seq_lengths': list(blob[0x940:0x950]),
        'effect': blob[0x950:0x974],
        'raw': blob,
    }


def sequence_dump_request(channel, seq_no):
    """CmdId 2 / func 0x13: request pattern `seq_no` (0..15); the 0x40 bit is
    ParameterId 3 = 1 (as for samples). Reply: func 0x43 header."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x13,
                  (seq_no & 0x0f) | 0x40, EOX])


def parse_sequence_header(msg: bytes):
    """Parse a func 0x43 reply: F0 42 3g 7F 43 (qq|0x40) s0 s1 s2 F7 ->
    seq# + data size ((s0&3)<<14 | (s1&0x7f)<<7 | (s2&0x7f))."""
    if len(msg) < 10 or msg[1] != KORG or msg[4] != 0x43:
        return None
    return {
        'seq_no': msg[5] & 0x0f,
        'data_size': ((msg[6] & 3) << 14) | ((msg[7] & 0x7f) << 7) | (msg[8] & 0x7f),
    }


def sequence_data_request(channel):
    """CmdId 4 / func 0x1d, no params (preceding func 0x13 selected the
    pattern). Device answers DIRECT_MARKER then raw sequence bytes (CmdId 12).
    Error replies: funcs 0x24 / 0x26 (same as samples)."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x1d, EOX])


def leave_dump_mode(channel, commit=True):
    """CmdId 20 / func 0x1a, ParameterId 8: 1 = success/commit, 0 = abort.
    Sent after bank-level transfers; device replies func 0x4a when done
    (the original editor waits up to 30 s — the device may be saving)."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x1a,
                  1 if commit else 0, EOX])


LEAVE_DUMP_ACK_FUNC = 0x4a          # CmdId 0x15 reply to func 0x1a
BANK_DUMP_REPLY_FUNCS = {0x40, 0x4c}


def bank_dump_send(channel, blob, bank=None):
    """Bank WRITE phase 1 (BankWrite::process): the 0x974-byte blob to the
    current bank (CmdId 8 / func 0x40) or a user bank (CmdId 11 / func 0x4c,
    bank# byte first). ACK: CmdId 0x18 / func 0x23; errors funcs 0x24 / 0x29."""
    assert len(blob) == BANK_BLOB_SIZE
    if bank is None:
        return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x40,
                      *korg_encode(blob), EOX])
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x4c, bank & 0x07,
                  *korg_encode(blob), EOX])


def sequence_header_send(channel, seq_no, data_size):
    """Sequence WRITE phase 1 (SequenceWrite::process, CmdId 0xa / func 0x43):
    seq# + 3-byte size. ACK: CmdId 0x1b / func 0x27 (errors 0x28/0x29).
    Then the raw data goes straight to bulk OUT (CmdId 12 direct, 0x4000-byte
    blocks, no marker) -> ACK funcs 0x21/0x23 (errors 0x22/0x24)."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x43,
                  (seq_no & 0x0f) | 0x40,
                  (data_size >> 14) & 3, (data_size >> 7) & 0x7f,
                  data_size & 0x7f, EOX])


BANK_SEND_OK, BANK_SEND_ERR = {0x23}, {0x24, 0x29}


# --- Pattern / sequence blob (1308 bytes, decoded 2026-06-05 from -----------
# --- GetInitPatternPtr + ConvertToSmf/ConvertSeq in the original binary -----
# Layout (ALL multi-byte fields BIG-endian):
#   0x000 "SEQP"; 0x004 u32 size (0x51C); 0x008 u16 specified bars;
#   0x00A u16 bars; 0x00C u32 = 8; 0x010 100*u32 bar-start offsets;
#   0x1A0 64*0xFF reserved; 0x1E0 KEYBOARD-mode sample# (0xFF none — the
#   sample-mode track selects pads by note number instead); 0x1E8 name[8];
#   0x200.. 4-byte events:
#     F0 00 tt tt  advance BE16 ticks (96/quarter note -> 384/4-4 bar)
#     FF bb -- --  bar marker; ends the pattern when bb >= bars
#     9c nn vv --  note-on  (c bit0: 0=sample/global ch, 1=keyboard ch)
#     8c nn vv --  note-off
PATTERN_SIZE = 0x51C
PATTERN_TICKS_PER_QUARTER = 96
PATTERN_TICKS_PER_BAR = 384


def parse_pattern(blob):
    """Decode a 1308-byte pattern blob -> dict with header fields, raw events
    and note list [(tick, channel_sel, note, velocity, duration_ticks)]."""
    blob = bytes(blob)
    if len(blob) < PATTERN_SIZE or blob[0:4] != b'SEQP':
        return None
    bars = int.from_bytes(blob[0x0a:0x0c], 'big')
    out = {
        'size': int.from_bytes(blob[4:8], 'big'),
        'spec_bars': int.from_bytes(blob[8:10], 'big'),
        'bars': bars,
        'bar_offsets': [int.from_bytes(blob[0x10 + 4*i:0x14 + 4*i], 'big')
                        for i in range(100)],
        'sample': None if blob[0x1e0] == 0xff else blob[0x1e0],
        'name': blob[0x1e8:0x1f0].decode('latin1').rstrip('\xff '),
        'events': [],
        'notes': [],
    }
    tick = 0
    open_notes = {}                       # (ch, note) -> (start_tick, vel)
    off = 0x200
    while off + 4 <= len(blob):
        b0, b1, b2, b3 = blob[off:off + 4]
        off += 4
        if b0 == 0xf0:                    # time advance
            tick += (b2 << 8) | b3
            out['events'].append(('advance', (b2 << 8) | b3))
        elif b0 == 0xff:                  # bar marker / end
            out['events'].append(('bar', b1))
            if b1 >= (bars & 0xff):
                break
        elif b0 & 0xee == 0x80:           # note on/off
            ch, on = b0 & 1, bool(b0 & 0x10)
            out['events'].append(('note_on' if on else 'note_off', ch, b1, b2))
            if on:
                open_notes[(ch, b1)] = (tick, b2)
            else:
                start = open_notes.pop((ch, b1), None)
                if start:
                    out['notes'].append((start[0], ch, b1, start[1],
                                         tick - start[0]))
        else:
            break                         # invalid -> stop
    out['ticks'] = tick
    return out


def build_init_pattern():
    """Byte-exact reproduction of the binary's INIT pattern (GetInitPatternPtr
    @0x236ae0): 4 bars, no notes, sample 0, name INITPTRN."""
    b = bytearray()
    b += b'SEQP'
    b += PATTERN_SIZE.to_bytes(4, 'big')
    b += (4).to_bytes(2, 'big') + (4).to_bytes(2, 'big')
    b += (8).to_bytes(4, 'big')
    for i in range(100):                  # bar offset table
        b += (0x200 + 8 * i).to_bytes(4, 'big')
    b += b'\xff' * 64                     # 0x1A0 reserved
    b += bytes([0x00]) + b'\xff' * 7      # 0x1E0 sample 0
    b += b'INITPTRN'                      # 0x1E8 name
    b += b'\xff' * 16                     # 0x1F0
    for i in range(99):                   # bar marker + one-bar advance each
        b += bytes([0xff, i, 0x00, 0x02, 0xf0, 0x00, 0x01, 0x80])
    b += bytes([0xff, 99, 0x00, 0x01])    # last bar truncated, count=1 (ROM)
    return bytes(b)


def pattern_to_smf(blob, sample_channel=0, kbd_channel=1):
    """Pattern blob -> Standard MIDI File bytes (type 0, 96 tpqn), mirroring
    ConvertToSmf: track name + tempo 120 + program change (sample#) + notes."""
    p = parse_pattern(blob)
    if p is None:
        raise ValueError('not a SEQP pattern blob')
    ch = (sample_channel & 0x0f, kbd_channel & 0x0f)

    track = bytearray()

    def vlq(n):
        out = [n & 0x7f]
        while n > 0x7f:
            n >>= 7
            out.append((n & 0x7f) | 0x80)
        return bytes(reversed(out))

    def ev(delta, *data):
        track.extend(vlq(delta))
        track.extend(data)

    name = p['name'].ljust(8)[:8].encode('latin1')
    ev(0, 0xff, 0x03, 0x08, *name)                       # track name
    ev(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20)            # tempo 120
    # program change = the KEYBOARD-mode sample assignment, on the keyboard
    # channel (matches ConvertToSmf + manual: "Sample numbers to be used in
    # Keyboard mode will be saved as Program Change messages"). Sample-mode
    # notes (bit0=0) select pads by NOTE NUMBER instead.
    ev(0, 0xc0 | ch[1], (p['sample'] or 0) & 0x7f)
    delta = 0
    for e in p['events']:
        if e[0] == 'advance':
            delta += e[1]
        elif e[0] in ('note_on', 'note_off'):
            status = (0x90 if e[0] == 'note_on' else 0x80) | ch[e[1]]
            ev(delta, status, e[2] & 0x7f, e[3] & 0x7f)
            delta = 0
    ev(delta, 0xff, 0x2f, 0x00)                          # end of track
    return (b'MThd' + (6).to_bytes(4, 'big') + (0).to_bytes(2, 'big')
            + (1).to_bytes(2, 'big')
            + PATTERN_TICKS_PER_QUARTER.to_bytes(2, 'big')
            + b'MTrk' + len(track).to_bytes(4, 'big') + bytes(track))


def parameter_change(channel, obj, param, value):
    """Live-edit Parameter Change (func 0x41) — THREE 14-bit LE values
    (hardware-verified 2026-06-04; desc[5..7]=1; sent by
    UsbSessionManager::sendParameterChangeMessage(obj, param, value)):
      obj:   16 + sample slot for samples (bank/effect objects live below 16)
      param: e.g. 16=LOOP, 17=BPM SYNC mode (0=off, 1=time stretch,
             2=pitch change — user-verified), 18=REVERSE, 21=DECAY,
             22=RELEASE, 28=TUNE
      value: parameter value."""
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x41,
                  *pack14(obj), *pack14(param), *pack14(value), EOX])


SAMPLE_OBJ_BASE = 16          # object id of sample slot 0


def sample_header(channel, sample_no, data_size, rate_hz, stereo,
                  tempo_bpm=120.0, mode_bit=0):
    """Phase 1 of upload — SysEx func 0x42 (CommandId 9).
    8-byte packed header: u32 dataSize, u16 tempo (0.1 BPM, 20.0..300.0 — the
    once-mysterious SampleData+0xd0 field), flags, 0xFF; 7-bit encoded.
    Sample number carries the 0x40 bit (ParameterId 3, set by sendCommand)."""
    rate_code = RATE_CODE[rate_hz]
    flags = (1 if stereo else 0) | (rate_code << 2) | ((1 if mode_bit else 0) << 5)
    tempo10 = max(200, min(3000, int(round(tempo_bpm * 10))))
    hdr = bytes([
        data_size & 0xff, (data_size >> 8) & 0xff,
        (data_size >> 16) & 0xff, (data_size >> 24) & 0xff,
        tempo10 & 0xff, (tempo10 >> 8) & 0xff,
        flags, 0xff,
    ])
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x42,
                  (sample_no & 0x3f) | 0x40, *korg_encode(hdr), EOX])


def build_param_blob(name, long_name=None, start_frame=0, end_frame=0,
                     template=None):
    """64-byte PackedSampleParameter for upload phase 3.

    With `template` (a blob downloaded from the device) only the names and
    start/end points are patched — everything else is kept verbatim. Without
    one, unknown byte fields get the values observed on a real device sample
    (hardware ground truth 2026-06-04)."""
    if template is not None:
        blob = bytearray(template[:64].ljust(64, b'\xff'))
    else:
        blob = bytearray([0xff] * 64)
        blob[8] = 0x00                       # flags (observed 0x00)
        blob[0x14] = 127                     # param5 (Level?, observed 127)
        blob[0x15] = 57                      # param6 (observed 57)
        blob[0x17] = 101                     # param3 (Speed?, observed 101)
        blob[0x18] = 64                      # param2 (Pan center?, observed 64)
        blob[0x19] = 0x40                    # semitone 0
        blob[0x1a] = 64                      # param1 (observed 64)
        blob[0x1b] = 0x40                    # tune 0
    blob[0:8] = name[:8].ljust(8).encode('latin1', 'replace')
    blob[0x0c:0x10] = start_frame.to_bytes(4, 'little')
    blob[0x10:0x14] = end_frame.to_bytes(4, 'little')
    if long_name is None:
        long_name = name
    ln = long_name.encode('utf-8')[:32]
    blob[0x20:0x20 + len(ln)] = ln
    if template is None:
        for i in range(0x20 + len(ln), 0x40):
            blob[i] = 0xff
    return bytes(blob)


def sample_param_send(channel, sample_no, blob):
    """Phase 3 of upload — CmdId 0xe / func 0x44 (verified at 0x3f2d1 in
    SampleWrite::process): sample# byte (no 0x40 bit — desc[4]=0), then the
    64-byte blob 7-bit encoded. Same shape as the download param reply."""
    assert len(blob) == 64
    return bytes([SOX, KORG, fmt_byte(channel), MODEL, 0x44,
                  sample_no & 0x3f, *korg_encode(blob), EOX])


# Upload ACKs (armed CommandId sets in SampleWrite::process -> funcs):
#   header phase arms {0x18,0x1b,0x1c,0x1d}; 0x18/0x1b ok, 0x1c/0x1d error.
#   PCM and param phases arm {0x16..0x19}; 0x16/0x18 ok, 0x17/0x19 error.
UPLOAD_HDR_OK, UPLOAD_HDR_ERR = {0x23, 0x27}, {0x28, 0x29}
UPLOAD_DATA_OK, UPLOAD_DATA_ERR = {0x21, 0x23}, {0x22, 0x24}


# ACK CommandIds the device returns (decoded against the command table):
#   header phase armed 0x18/0x1b/0x1c/0x1d ; process treats 0x1c/0x1d as error,
#   0x1b as OK.  data phase armed 0x16..0x19.  Funcs of those ids:
ACK_FUNCS = {0x27: 'ok', 0x28: 'error', 0x29: 'error', 0x23: 'ok',
             0x21: 'ok', 0x22: 'error', 0x24: 'error'}


def parse_reply(msg: bytes):
    """Classify an incoming SysEx from the device."""
    if len(msg) >= 5 and msg[1] == 0x7e and msg[4] == 0x02:
        return {'type': 'inquiry', 'is_microsampler': msg[5] == KORG and msg[6] == MODEL}
    if len(msg) >= 5 and msg[1] == KORG:
        func = msg[4]
        out = {'type': 'korg', 'func': func, 'channel': msg[2] & 0x0f}
        if func == 0x41 and len(msg) >= 12:
            out['type'] = 'parameter_change'
            out['obj'] = unpack14(msg[5], msg[6])
            out['param'] = unpack14(msg[7], msg[8])
            out['value'] = unpack14(msg[9], msg[10])
            if out['obj'] >= SAMPLE_OBJ_BASE:
                out['sample'] = out['obj'] - SAMPLE_OBJ_BASE
        elif func in ACK_FUNCS:
            out['type'] = 'ack'
            out['ok'] = ACK_FUNCS[func] == 'ok'
        return out
    return {'type': 'unknown'}


# ---------------------------------------------------------------------------
def _selftest():
    # 7-bit codec round-trips, including high-bit bytes.
    for data in [bytes(range(8)), bytes([0xff] * 8), bytes(range(20)),
                 bytes([0x00, 0x80, 0x7f, 0xff, 0x01, 0x40, 0xc0, 0x33])]:
        enc = korg_encode(data)
        assert korg_decode(enc) == data, data.hex()
        # size = N + ceil(N/7)
        assert len(enc) == len(data) + (len(data) + 6) // 7
    # Known encoding: 8x 0xff -> group1 [0x7f]+7x0x7f, group2 [0x01]+1x0x7f
    assert korg_encode(bytes([0xff] * 8)) == bytes([0x7f] + [0x7f]*7 + [0x01, 0x7f])
    # header message shape
    h = sample_header(0, 5, data_size=1000, rate_hz=48000, stereo=False)
    assert h[0] == 0xf0 and h[1] == 0x42 and h[3] == 0x7f and h[4] == 0x42
    assert h[5] == (5 | 0x40) and h[-1] == 0xf7
    # parameter change: 3-value form, matches the hardware capture
    # (PLYSTER slot 12 -> obj 28, param 17 BPM SYNC, value 2)
    assert parameter_change(0, 28, 17, 2).hex() == \
        'f042307f411c00110002 00f7'.replace(' ', '')
    pc = parse_reply(bytes.fromhex('f042307f411c0011000200f7'))
    assert pc['type'] == 'parameter_change'
    assert pc['obj'] == 28 and pc['param'] == 17 and pc['value'] == 2
    assert pc['sample'] == 12

    # download requests
    assert sample_dump_request(0, 5) == bytes.fromhex('f042307f1645f7')
    assert sample_data_dump_request(2) == bytes.fromhex('f042327f1ff7')
    assert sample_param_dump_request(0, 5) == bytes.fromhex('f042307f1405f7')
    assert len(DIRECT_MARKER) == 64 and DIRECT_MARKER[:3] == b'\xff\xff\xff'

    # header reply round-trip: build the same 8-byte header the device would
    # send (mono 24kHz, 1000 bytes, 120.0 BPM) and parse it back
    hdr = bytes([0xe8, 0x03, 0, 0, 0xb0, 0x04, (1 << 2), 0xff])
    reply = bytes([SOX, KORG, 0x30, MODEL, 0x42, 5 | 0x40, *korg_encode(hdr), EOX])
    p = parse_sample_header(reply)
    assert p['sample_no'] == 5 and p['data_size'] == 1000
    assert p['tempo_bpm'] == 120.0 and p['rate_hz'] == 24000 and not p['stereo']

    # upload param blob: build -> wrap -> parse round-trip
    b = build_param_blob('KICK 01', 'Kick drum 01', 0, 12345)
    assert len(b) == 64 and b[0:8] == b'KICK 01 '
    assert int.from_bytes(b[0x10:0x14], 'little') == 12345
    msg = sample_param_send(0, 7, b)
    q = parse_sample_param(msg)
    assert q['sample_no'] == 7 and q['name'] == 'KICK 01'
    assert q['long_name'] == 'Kick drum 01' and q['raw'] == b
    # template mode patches names/points, keeps the rest
    tpl = bytes(range(64))
    b2 = build_param_blob('NEW', start_frame=1, end_frame=2, template=tpl)
    assert b2[0x14] == tpl[0x14] and b2[0x19] == tpl[0x19]
    assert b2[0:8] == b'NEW     ' and b2[0x0c] == 1 and b2[0x10] == 2

    # header tempo is clipped & encoded as 0.1 BPM
    h = sample_header(0, 0, 4, 48000, False, tempo_bpm=132.5)
    hdr8 = korg_decode(h[6:-1])
    assert hdr8[4] | (hdr8[5] << 8) == 1325

    # bank level
    assert bank_dump_request(0) == bytes.fromhex('f042307f10f7')
    assert bank_dump_request(0, 4) == bytes.fromhex('f042307f1c04f7')
    assert sequence_dump_request(0, 3) == bytes.fromhex('f042307f1343f7')
    assert sequence_data_request(1) == bytes.fromhex('f042317f1df7')
    assert leave_dump_mode(0) == bytes.fromhex('f042307f1a01f7')
    assert leave_dump_mode(0, commit=False) == bytes.fromhex('f042307f1a00f7')

    bank = bytearray([0xff] * BANK_BLOB_SIZE)
    bank[0:8] = b'MYBANK  '
    bank[8:10] = (1275).to_bytes(2, 'little')          # 127.5 BPM
    bank[0x40:0x48] = b'SMP00   '                      # sample 0 short name
    bank[0x940] = 5                                    # seq 0 length
    reply = bytes([SOX, KORG, 0x30, MODEL, 0x4c, 2, *korg_encode(bytes(bank)), EOX])
    bp = parse_bank_dump(reply)
    assert bp['bank'] == 2 and bp['name'] == 'MYBANK' and bp['bpm'] == 127.5
    assert bp['sample_params'][0]['name'] == 'SMP00'
    assert bp['seq_lengths'][0] == 5 and len(bp['effect']) == 0x24
    # current-bank variant has no bank# byte
    reply0 = bytes([SOX, KORG, 0x30, MODEL, 0x40, *korg_encode(bytes(bank)), EOX])
    bp0 = parse_bank_dump(reply0)
    assert bp0['bank'] is None and bp0['name'] == 'MYBANK'

    sh = parse_sequence_header(bytes([SOX, KORG, 0x30, MODEL, 0x43, 0x43,
                                      0x01, 0x02, 0x03, EOX]))
    assert sh['seq_no'] == 3 and sh['data_size'] == (1 << 14) | (2 << 7) | 3

    # write direction: header send must parse back identically
    msg = sequence_header_send(0, 3, 1308)
    sh2 = parse_sequence_header(msg)
    assert sh2['seq_no'] == 3 and sh2['data_size'] == 1308
    # bank send wraps the blob the same way the dump reply does
    snd = bank_dump_send(0, bytes(bank), 2)
    assert snd[4] == 0x4c and snd[5] == 2
    assert korg_decode(snd[6:-1])[:BANK_BLOB_SIZE] == bytes(bank)
    snd0 = bank_dump_send(0, bytes(bank))
    assert snd0[4] == 0x40 and korg_decode(snd0[5:-1])[:BANK_BLOB_SIZE] == bytes(bank)

    # pattern blob: init reproduction (sha vs the binary's ROM copy),
    # parse, note pairing, SMF export
    import hashlib
    init = build_init_pattern()
    assert len(init) == PATTERN_SIZE
    assert hashlib.sha256(init).hexdigest().startswith('76be701c8d62feb2')
    pi = parse_pattern(init)
    assert pi['name'] == 'INITPTRN' and pi['bars'] == 4 and pi['sample'] == 0
    assert pi['notes'] == [] and pi['ticks'] == 4 * PATTERN_TICKS_PER_BAR
    pb = bytearray(init)
    pb[0x200:0x220] = bytes([0xff, 0, 0, 0,  0x90, 60, 100, 0,
                             0xf0, 0, 0, 96,  0x80, 60, 0, 0,
                             0xf0, 0, 1, 0x20,  0xff, 1, 0, 0,
                             0xf0, 0, 1, 0x80,  0xff, 4, 0, 0])
    pp = parse_pattern(pb)
    assert pp['notes'] == [(0, 0, 60, 100, 96)] and pp['ticks'] == 768
    smf = pattern_to_smf(pb)
    assert smf[:4] == b'MThd' and smf[12:14] == bytes([0, 96])
    assert bytes([0x90, 60, 100]) in smf and bytes([0x80, 60, 0]) in smf

    # param reply round-trip
    blob = bytearray([0xff] * 64)
    blob[0:8] = b'KICK 01 '
    blob[0x19] = 0x40 + 3; blob[0x1b] = 0x40 - 2
    blob[0x20:0x27] = b'Kick 01'; blob[0x27] = 0xff
    reply = bytes([SOX, KORG, 0x30, MODEL, 0x44, 5, *korg_encode(bytes(blob)), EOX])
    q = parse_sample_param(reply)
    assert q['name'] == 'KICK 01' and q['long_name'] == 'Kick 01'
    assert q['semitone'] == 3 and q['tune'] == -2
    print("protocol self-test: OK")


if __name__ == "__main__":
    _selftest()
