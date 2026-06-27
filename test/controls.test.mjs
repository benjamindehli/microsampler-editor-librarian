// Unit tests for the hardware-verified value encoders in controls.js
// (tune cents curve, pan/level formatters, signed-14-bit decode).
//
// controls.js wires DOM handlers at import time, so we install a minimal
// `document` stub first, then DYNAMICALLY import it (static imports are hoisted
// and would run before the stub is set). Only the pure exports are exercised.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = { querySelector: () => ({ querySelectorAll: () => [] }) };
const { tuneCents, tuneDisplay, fmtPan, fmtLevel, dec14, BIPOLAR, PARAM, OBJ_BASE } =
  await import('../web-editor/components/controls/controls.js');

test('tuneCents: 0..127 wire → −99..+99 cents (hardware-measured curve)', () => {
  // edges clamp to ±99
  assert.equal(tuneCents(0), -99);
  assert.equal(tuneCents(2), -99);
  assert.equal(tuneCents(127), 99);
  assert.equal(tuneCents(126), 99);
  // coarse steps of 5 near the edges
  assert.equal(tuneCents(3), -95);
  assert.equal(tuneCents(11), -55);
  assert.equal(tuneCents(117), 55);
  assert.equal(tuneCents(125), 95);
  // fine linear halves around the centre detent
  assert.equal(tuneCents(12), -50);
  assert.equal(tuneCents(61), -1);
  assert.equal(tuneCents(67), 1);
  assert.equal(tuneCents(116), 50);
  // 4-wire centre detent reads 0
  for (const w of [62, 63, 64, 65, 66]) assert.equal(tuneCents(w), 0);
});

test('tuneDisplay formats with a sign', () => {
  assert.equal(tuneDisplay(12), '-50');
  assert.equal(tuneDisplay(64), '0');
  assert.equal(tuneDisplay(116), '+50');
});

test('fmtPan: 64 = centre, below = Lx, above = Rx', () => {
  assert.equal(fmtPan(64), 'CNT');
  assert.equal(fmtPan(0), 'L64');
  assert.equal(fmtPan(32), 'L32');
  assert.equal(fmtPan(96), 'R32');
  assert.equal(fmtPan(127), 'R63');
});

test('dec14: signed 14-bit two\'s-complement decode', () => {
  assert.equal(dec14(0), 0);
  assert.equal(dec14(24), 24);
  assert.equal(dec14(8191), 8191);
  assert.equal(dec14(8192), -8192);
  assert.equal(dec14(16383), -1);
  assert.equal(dec14(16360), -24);   // SEMITONE −24 = raw 0x3FE8 (hardware fact)
});

test('fmtLevel returns a display string', () => {
  assert.equal(typeof fmtLevel(101), 'string');
  assert.ok(fmtLevel(101).length > 0);
  // out-of-table index falls back to the raw number
  assert.equal(fmtLevel(99999), '99999');
});

test('param-id constants and bipolar set are as hardware-confirmed', () => {
  assert.equal(OBJ_BASE, 16);
  assert.equal(PARAM.LEVEL, 24);
  assert.equal(PARAM.TUNE, 28);
  assert.equal(PARAM.SEMITONE, 27);
  assert.ok(BIPOLAR.has(PARAM.SEMITONE));
  assert.ok(BIPOLAR.has(PARAM.VELO_INT));
  assert.ok(!BIPOLAR.has(PARAM.LEVEL));
});
