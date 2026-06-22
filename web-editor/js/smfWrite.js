// Minimal Standard MIDI File writer for the pattern editor: a note model →
// a format-0 SMF (96 ticks/quarter, the device's resolution). The bridge feeds
// it straight into the proven smf_to_pattern → pattern_write path, so the editor
// reuses the exact, hardware-verified converter rather than serialising SEQP in
// the browser. Pure (no DOM) — unit-tested in test/smfWrite.test.mjs.
//
// notes: [{ start, dur, note, vel, track }]  (ticks @96/quarter; track 0 =
//   sample-mode/pad, 1 = keyboard-mode). opts: { bars, sample, name }. The
//   keyboard-track sample is written as a program change on channel 1, and the
//   name as a track-name meta — exactly what smf_to_pattern reads back.
const TPQ = 96;
const TPB = TPQ * 4;            // 384 ticks per 4/4 bar (the device's bar length)

function vlq(n) {              // MIDI variable-length quantity (big-endian, 7-bit)
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) { out.unshift(0x80 | (n & 0x7f)); n = Math.floor(n / 128); }
  return out;
}

export function notesToSmf(notes, { bars = 1, sample = null, name = 'PATTERN' } = {}) {
  // [absTick, phase, bytes] — phase orders events sharing a tick: meta/program
  // first, then note-offs, then note-ons, then end-of-track.
  const ev = [];
  const nm = Array.from(String(name)).map(c => c.charCodeAt(0) & 0x7f).slice(0, 8);
  ev.push([0, 0, [0xFF, 0x03, nm.length, ...nm]]);              // track name
  if (sample != null)
    ev.push([0, 1, [0xC1, sample & 0x7f]]);                     // kbd-track sample (PC ch1)
  for (const n of notes) {
    const st = Math.max(0, Math.round(n.start));
    const dur = Math.max(1, Math.round(n.dur));
    const ch = n.track & 1;                                     // 0 sample-mode, 1 keyboard
    const note = n.note & 0x7f;
    ev.push([st, 3, [0x90 | ch, note, Math.max(1, (n.vel | 0) & 0x7f)]]);   // note on
    ev.push([st + dur, 2, [0x80 | ch, note, 0]]);                           // note off
  }
  // end-of-track at the pattern length so smf_to_pattern derives the bar count
  const endTick = Math.max(bars * TPB, ...ev.map(e => e[0]), 0);
  ev.push([endTick, 9, [0xFF, 0x2F, 0x00]]);

  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const trk = [];
  let last = 0;
  for (const [tick, , bytes] of ev) {
    trk.push(...vlq(tick - last), ...bytes);
    last = tick;
  }
  const u32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([
    0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6,        // MThd, length 6
    0, 0, 0, 1, (TPQ >> 8) & 0xff, TPQ & 0xff,  // format 0, 1 track, 96 ticks/quarter
    0x4D, 0x54, 0x72, 0x6B, ...u32(trk.length), // MTrk + length
    ...trk,
  ]);
}
