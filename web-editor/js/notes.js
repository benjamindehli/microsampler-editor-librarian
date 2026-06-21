// Pure note/keyboard theory for the 36 pads (C3..B5; MIDI C3 = 48, the Korg
// octave). A leaf module that imports nothing, so it never sits in an import cycle
// — both pads.js and qwerty.js use it (pads.js imports qwerty.js for syncKeybed, so
// a shared definition in either would form a cycle, and a back-import once hit
// NOTE_NAMES's temporal dead zone while qwerty.js built the piano at module-eval).
// Being import-free it's also directly unit-testable (test/notes.test.mjs).
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(slot) {
  const n = 48 + slot;
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

// ── QWERTY computer-keyboard piano (used by qwerty.js) ───────────────────────
// DAW-style layout: home row = white keys, top row = black keys. e.code → semitone
// offset from the base C. The keyboard sits at one of three base octaves.
export const QWERTY_KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
  KeyP: 15, Semicolon: 16,
};
export const QWERTY_OCTAVES = ['C3', 'C4', 'C5'];   // base of each octave = slot 0/12/24

// The pad slot (0..35) a key plays at the given octave index, or null if the key
// isn't a piano key, or the note falls outside the 36 pads (e.g. high keys at C5).
export function qwertySlot(code, octaveIdx) {
  const off = QWERTY_KEYMAP[code];
  if (off == null) return null;
  const slot = octaveIdx * 12 + off;                // octave 0=C3(0), 1=C4(12), 2=C5(24)
  return slot >= 0 && slot <= 35 ? slot : null;
}
