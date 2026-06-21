// Unit tests for the pure note/keyboard theory (web-editor/js/notes.js).
// Built-in node:test — no deps. Run: node --test test/*.test.mjs  (or: npm test)
import assert from 'node:assert/strict';
import test from 'node:test';

import { noteName, QWERTY_KEYMAP, QWERTY_OCTAVES, qwertySlot }
  from '../web-editor/js/notes.js';

test('noteName covers the 36 pads C3..B5', () => {
  assert.equal(noteName(0), 'C3');     // first pad
  assert.equal(noteName(1), 'C#3');
  assert.equal(noteName(11), 'B3');
  assert.equal(noteName(12), 'C4');
  assert.equal(noteName(24), 'C5');
  assert.equal(noteName(35), 'B5');    // last pad
});

test('qwertySlot: home/top rows play the base octave (C4 = octave 1)', () => {
  assert.equal(qwertySlot('KeyA', 1), 12);        // C4 (white, base)
  assert.equal(qwertySlot('KeyW', 1), 13);        // C#4 (black)
  assert.equal(qwertySlot('KeyK', 1), 24);        // C5 (one octave up, offset 12)
  assert.equal(qwertySlot('Semicolon', 1), 28);   // E5 (offset 16, the highest key)
  assert.equal(noteName(qwertySlot('Semicolon', 1)), 'E5');
});

test('qwertySlot: the C3 octave bottom key is pad 0', () => {
  assert.equal(qwertySlot('KeyA', 0), 0);
  assert.equal(noteName(qwertySlot('KeyA', 0)), 'C3');
});

test('qwertySlot: shifting octave moves every key by exactly 12 slots', () => {
  for (const code of Object.keys(QWERTY_KEYMAP)) {
    const lo = qwertySlot(code, 0);
    const mid = qwertySlot(code, 1);
    if (lo != null && mid != null) assert.equal(mid - lo, 12, code);
  }
});

test('qwertySlot: unmapped keys return null (left for shortcuts)', () => {
  for (const code of ['KeyR', 'KeyZ', 'KeyX', 'Space', 'Digit1', 'ArrowLeft'])
    assert.equal(qwertySlot(code, 1), null, code);
});

test('qwertySlot: notes above B5 clamp to null at the top octave', () => {
  assert.equal(qwertySlot('KeyJ', 2), 35);        // B5 (offset 11) — the top pad
  assert.equal(qwertySlot('KeyK', 2), null);      // C6 (offset 12) → above B5
  assert.equal(qwertySlot('Semicolon', 2), null); // offset 16 → above
});

test('qwertySlot: every mapped key lands on a valid pad (0..35) across all octaves', () => {
  for (let oct = 0; oct < QWERTY_OCTAVES.length; oct++)
    for (const code of Object.keys(QWERTY_KEYMAP)) {
      const s = qwertySlot(code, oct);
      if (s != null) assert.ok(s >= 0 && s <= 35, `${code}@${oct} -> ${s}`);
    }
});
