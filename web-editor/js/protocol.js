// =============================================================================
// Korg microSAMPLER SysEx protocol
// -----------------------------------------------------------------------------
// Every constant and message layout in this file was reverse-engineered from the
// original "microSAMPLER Editor Librarian.app" (v1.0.1.5) i386 binary, by
// disassembling SysExCommand::getSysExData / getDeviceInquirySysExData and
// reading the SysExCommand::m_commandDescs table out of __TEXT,__const.
//
// Verified header that the original app sent and the device accepted:
//     F0 42 3g 7F <func> <payload...> F7
//   42   = Korg manufacturer ID
//   3g   = 0x30 | (global MIDI channel 0..15)
//   7F   = microSAMPLER family / model byte  (also the family LSB in the
//          Universal Device Inquiry reply: F0 7E cc 06 02 42 7F 00 ...)
// =============================================================================

export const KORG_ID      = 0x42;
export const FORMAT_BASE  = 0x30;   // OR-ed with the global channel
export const MODEL_BYTE   = 0x7f;   // microSAMPLER family/model
export const SOX = 0xf0, EOX = 0xf7;

// --- Function codes (first byte after the model byte) -----------------------
// Values come straight from m_commandDescs[]. Names marked (verified) are
// confirmed by the disassembly / message shape; others follow Korg's standard
// "new-generation" SysEx conventions (R3 / microKORG XL / M50) and are
// best-effort labels.
export const FUNC = {
  PARAMETER_CHANGE:    0x41, // (hardware-verified 2026-06-04) THREE 14-bit
                             // values: object, param#, value — see below
  DATA_DUMP_REQUEST:   0x40, // current data dump request
  MODE_CHANGE:         0x4f,
  MODE_DATA:           0x4c,
};

// The full 30-entry command-descriptor table, transcribed verbatim from
// m_commandDescs (10 bytes each, indexed by the app's internal CommandId enum).
// Layout decoded from getSysExData:
//   [0] func code
//   [1] f1: emit slot0            as 1 byte
//   [2] f2: emit slot1            as 1 byte (+0x40 "direction" bit if [4] & slot3)
//   [3] f3: emit slot2            as 1 byte (+0x40 "direction" bit if [4] & slot3)
//   [4] f4: enable the direction bit for [2]/[3]
//   [5] f5: emit slot4            as 14-bit (lo7, hi7)
//   [6] f6: emit slot5            as 14-bit (lo7, hi7)
//   [7] f7: emit slot6            as 14-bit (lo7, hi7)
//   [8] f8: emit slot7            as 21-bit big-endian (bits14-15, bits7-13, bits0-6)
//   [9] f9: emit slot8            as 1 byte
export const COMMAND_DESCS = [
  [0x10,0,0,0,0,0,0,0,0,0], [0x16,0,1,0,1,0,0,0,0,0], [0x13,0,0,1,1,0,0,0,0,0],
  [0x1c,1,0,0,0,0,0,0,0,0], [0x1d,0,0,0,0,0,0,0,0,0], [0x14,0,1,0,0,0,0,0,0,0],
  [0x15,0,0,0,0,0,0,0,0,0], [0x1f,0,0,0,0,0,0,0,0,0], [0x40,0,0,0,0,0,0,0,0,0],
  [0x42,0,1,0,1,0,0,0,0,0], [0x43,0,0,1,1,0,0,0,1,0], [0x4c,1,0,0,0,0,0,0,0,0],
  [0x4d,0,0,0,0,0,0,0,0,0], [0x4f,0,0,0,0,0,0,0,0,0], [0x44,0,1,0,0,0,0,0,0,0],
  [0x45,0,0,0,0,0,0,0,0,0], [0x0e,0,0,0,0,0,0,0,0,0], [0x51,0,0,0,0,0,0,0,0,0],
  [0x11,0,0,0,0,0,0,0,0,0], [0x41,0,0,0,0,1,1,1,0,0], [0x1a,0,0,0,0,0,0,0,0,1],
  [0x4a,1,0,0,0,0,0,0,0,0], [0x21,0,0,0,0,0,0,0,0,0], [0x22,0,0,0,0,0,0,0,0,0],
  [0x23,0,0,0,0,0,0,0,0,0], [0x24,0,0,0,0,0,0,0,0,0], [0x26,0,0,0,0,0,0,0,0,0],
  [0x27,0,0,0,0,0,0,0,0,0], [0x28,0,0,0,0,0,0,0,0,0], [0x29,0,0,0,0,0,0,0,0,0],
];

// Best-effort human labels for incoming function codes (for the monitor).
// Korg's status/ack codes (0x21-0x29) are device->host responses.
export const FUNC_NAMES = {
  0x41: 'Parameter Change',
  0x40: 'Data Dump Request',
  0x4f: 'Mode Change',
  0x4c: 'Mode Data',
  0x4d: 'Mode Data Request',
  0x23: 'Data Load Completed',
  0x24: 'Data Load Error',
  0x26: 'Write Completed',
  0x27: 'Write Error',
  0x21: 'Status / Ack',
  0x22: 'Status / Ack',
  0x4a: 'Data Dump',
};

// ---------------------------------------------------------------------------
// 14-bit value helpers (Korg packs values as little-endian 7-bit pairs)
// ---------------------------------------------------------------------------
const lo7 = v => v & 0x7f;
const hi7 = v => (v >> 7) & 0x7f;
export const pack14  = v => [lo7(v), hi7(v)];
export const unpack14 = (l, h) => (l & 0x7f) | ((h & 0x7f) << 7);

export const formatByte = ch => (FORMAT_BASE | (ch & 0x0f));

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/** Universal (non-realtime) Device Inquiry request. The microSAMPLER replies
 *  with  F0 7E cc 06 02 42 7F 00 .. F7  (family LSB 0x7F identifies it). */
export function buildDeviceInquiry() {
  return Uint8Array.from([SOX, 0x7e, 0x7f, 0x06, 0x01, EOX]);
}

/** Parameter Change (func 0x41) — the core live-edit message.
 *  HARDWARE-VERIFIED 2026-06-04 (panel-edit capture + disassembly of
 *  UsbSessionManager::sendParameterChangeMessage(obj, param, value)):
 *  F0 42 3g 7F 41 [obj lo7 hi7][param lo7 hi7][value lo7 hi7] F7
 *    obj:   which object is edited — sample slots are 16 + slot (0-based);
 *           ids 0..15 = bank/effect/pattern objects (mapping TBD)
 *    param: per-object parameter id. Known sample params:
 *           16=LOOP, 17=BPM SYNC mode (0=off, 1=time stretch, 2=pitch change),
 *           18=REVERSE, 21=DECAY, 22=RELEASE, 28=TUNE
 *           (device disables Tune/Semitone while BPM SYNC = Pitch Change)
 *    value: the new value. */
export const SAMPLE_OBJ_BASE = 16;
export function buildParameterChange(channel, obj, paramNumber, value) {
  return Uint8Array.from([
    SOX, KORG_ID, formatByte(channel), MODEL_BYTE, FUNC.PARAMETER_CHANGE,
    ...pack14(obj), ...pack14(paramNumber), ...pack14(value), EOX,
  ]);
}

/** Current data dump request (func 0x40). */
export function buildDataDumpRequest(channel) {
  return Uint8Array.from([
    SOX, KORG_ID, formatByte(channel), MODEL_BYTE, FUNC.DATA_DUMP_REQUEST, EOX,
  ]);
}

/** Generic raw command, for experimenting with the recovered command table. */
export function buildRawCommand(channel, func, payload = []) {
  return Uint8Array.from([
    SOX, KORG_ID, formatByte(channel), MODEL_BYTE, func & 0x7f, ...payload, EOX,
  ]);
}

// ---------------------------------------------------------------------------
// Parsing incoming SysEx
// ---------------------------------------------------------------------------

/** Returns null if not a complete SysEx, otherwise a decoded descriptor. */
export function parseSysEx(bytes) {
  const b = Array.from(bytes);
  if (b[0] !== SOX || b[b.length - 1] !== EOX) return null;

  // Universal Device Inquiry request: F0 7E cc 06 01 F7
  if (b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x01) {
    return { type: 'inquiryRequest', raw: b };
  }

  // Universal Device Inquiry reply: F0 7E cc 06 02 <mfr> <famLo> <famHi> ...
  if (b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02) {
    const isKorg = b[5] === KORG_ID;
    const familyLo = b[6], familyHi = b[7];
    return {
      type: 'inquiryReply',
      manufacturer: b[5],
      isKorg,
      family: (familyLo | (familyHi << 8)),
      isMicroSampler: isKorg && familyLo === MODEL_BYTE,
      member: (b[8] | (b[9] << 8)),
      version: b.slice(10, b.length - 1),
      raw: b,
    };
  }

  // Korg message: F0 42 3g <model> <func> ...
  if (b[1] === KORG_ID) {
    const channel = b[2] & 0x0f;
    const model = b[3];
    const func = b[4];
    const payload = b.slice(5, b.length - 1);
    const out = {
      type: 'korg', channel, model, func,
      funcName: FUNC_NAMES[func] || `Function 0x${func.toString(16)}`,
      payload, raw: b,
    };
    if (func === FUNC.PARAMETER_CHANGE && payload.length >= 6) {
      out.type = 'parameterChange';
      out.obj = unpack14(payload[0], payload[1]);
      out.paramNumber = unpack14(payload[2], payload[3]);
      out.value = unpack14(payload[4], payload[5]);
      if (out.obj >= SAMPLE_OBJ_BASE) out.sample = out.obj - SAMPLE_OBJ_BASE;
    }
    return out;
  }

  return { type: 'unknown', raw: b };
}

export const hex = bytes =>
  Array.from(bytes).map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
