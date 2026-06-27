// Unit tests for the pattern editor's SMF writer (web-editor/js/smfWrite.js).
// Builds an SMF from a note model, parses it back with a minimal reader, and
// checks notes / name / keyboard-sample survive — the offline guard on the save
// path before it reaches the (proven) Python smf_to_pattern. node:test, no deps.
import assert from 'node:assert/strict';
import test from 'node:test';

import { notesToSmf } from '../web-editor/functions/smfWrite.js';

// minimal SMF reader: returns {div, name, programs, notes:[[start,ch,note,vel,dur]]}
function readSmf(u8) {
  assert.deepEqual([...u8.slice(0, 4)], [0x4D, 0x54, 0x68, 0x64], 'MThd');
  const div = (u8[12] << 8) | u8[13];
  assert.deepEqual([...u8.slice(14, 18)], [0x4D, 0x54, 0x72, 0x6B], 'MTrk');
  let off = 22, tick = 0, status = 0;
  const on = {}, notes = [], programs = {};
  let name = null;
  const vlq = () => { let v = 0, b; do { b = u8[off++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  const close = (ch, note, t) => {
    const k = ch + ':' + note, o = on[k];
    if (o) { notes.push([o[0], ch, note, o[1], t - o[0]]); delete on[k]; }
  };
  while (off < u8.length) {
    tick += vlq();
    if (u8[off] & 0x80) status = u8[off++];          // our writer never uses running status
    if (status === 0xFF) {
      const meta = u8[off++], len = vlq(), data = u8.slice(off, off + len); off += len;
      if (meta === 0x03) name = String.fromCharCode(...data);
      if (meta === 0x2F) { notes.endTick = tick; break; }
    } else if ((status & 0xF0) === 0xC0) {
      programs[status & 0x0f] = u8[off++];
    } else if ((status & 0xF0) === 0x90) {
      const note = u8[off++], vel = u8[off++];
      if (vel) on[(status & 0x0f) + ':' + note] = [tick, vel];
      else close(status & 0x0f, note, tick);
    } else if ((status & 0xF0) === 0x80) {
      const note = u8[off++]; off++; close(status & 0x0f, note, tick);
    } else { off++; }
  }
  return { div, name, programs, notes, endTick: notes.endTick };
}

test('notesToSmf round-trips notes (start, track, pitch, velocity, duration)', () => {
  const model = [
    { start: 0, dur: 24, note: 60, vel: 100, track: 0 },     // sample-mode
    { start: 96, dur: 48, note: 67, vel: 80, track: 0 },
    { start: 192, dur: 96, note: 72, vel: 120, track: 1 },   // keyboard-mode
  ];
  const r = readSmf(notesToSmf(model, { bars: 2, sample: 5, name: 'GROOVE' }));
  assert.equal(r.div, 96);
  assert.equal(r.name, 'GROOVE');
  assert.equal(r.programs[1], 5);                            // kbd-track sample → PC ch1
  // notes come back (order-independent compare)
  const got = r.notes.map(n => n.join(',')).sort();
  const want = model.map(n => [n.start, n.track, n.note, n.vel, n.dur].join(',')).sort();
  assert.deepEqual(got, want);
});

test('notesToSmf sets the track length from bars (end-of-track tick)', () => {
  const r = readSmf(notesToSmf([], { bars: 3, name: 'X' }));
  assert.equal(r.endTick, 3 * 384);                          // 3 bars × 384 ticks
  assert.equal(r.notes.length, 0);
});

test('notesToSmf omits the program change when there is no keyboard sample', () => {
  const r = readSmf(notesToSmf([{ start: 0, dur: 24, note: 50, vel: 90, track: 0 }],
                               { bars: 1, sample: null, name: 'P' }));
  assert.equal(r.programs[1], undefined);
});

test('notesToSmf clamps velocity into a valid note-on (>=1)', () => {
  const r = readSmf(notesToSmf([{ start: 0, dur: 12, note: 60, vel: 0, track: 0 }],
                               { bars: 1, name: 'P' }));
  assert.equal(r.notes.length, 1);
  assert.ok(r.notes[0][3] >= 1);
});
