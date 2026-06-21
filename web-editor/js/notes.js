// Note naming for the 36 pads (C3..B5; MIDI C3 = 48, the Korg octave). A leaf
// module that imports nothing, so it never sits in an import cycle — both pads.js
// and qwerty.js use it (pads.js imports qwerty.js for syncKeybed, so a shared
// definition in either would form a cycle, and a back-import once hit NOTE_NAMES's
// temporal dead zone while qwerty.js built the piano at module-eval).
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(slot) {
  const n = 48 + slot;
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}
