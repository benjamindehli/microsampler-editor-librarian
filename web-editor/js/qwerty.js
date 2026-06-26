// On-screen keyboard + QWERTY pad-play. A piano under the editor mirrors the 36
// pads (C3..B5 = exactly three octaves); clicking a key plays it through the
// device (POST /api/note — real envelope/FX/pitch). Ticking "⌨ TYPE TO PLAY"
// arms the computer keyboard as a one-octave piano (home row = white keys, top
// row = black keys; Z / X or the ◀ ▶ buttons shift the octave). The piano always
// shows which computer key maps to which note, lit brighter while armed. Off by
// default so the letter keys stay free for the normal shortcuts (ux.js).
import { noteName, QWERTY_KEYMAP, QWERTY_OCTAVES, qwertySlot } from './notes.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, api, jsonBody } from './util.js';

// the on-screen caption letter for each mapped computer key (see QWERTY_KEYMAP)
const KEYLABEL = {
  KeyA: 'A', KeyW: 'W', KeyS: 'S', KeyE: 'E', KeyD: 'D', KeyF: 'F', KeyT: 'T',
  KeyG: 'G', KeyY: 'Y', KeyH: 'H', KeyU: 'U', KeyJ: 'J', KeyK: 'K', KeyO: 'O',
  KeyL: 'L', KeyP: 'P', Semicolon: ';',
};
const WHITE = [0, 2, 4, 5, 7, 9, 11];          // white-key semitones within an octave
const BLACK_AFTER = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };  // white-index → black-key semitone

let enabled = false;
let octave = 1;                      // index into QWERTY_OCTAVES (default C4, the middle)
let mode = 'sample';                 // 'sample' = one sample per key; 'kbd' = selected sample, pitched
const held = new Map();              // e.code → slot currently sounding (keyboard)
let clickSlot = null;                // slot currently held by the mouse on the piano

// ── device note + visual paint ───────────────────────────────────────────────
// SAMPLE mode plays note 48+slot on the global channel (triggers that pad);
// KEYBOARD mode sends the same note one channel up, so the device plays its
// currently selected sample pitched (its keyboard-mode track) — the bridge maps
// the `keyboard` flag onto the channel. `body` carries slot OR a raw note (the
// latter for a real MIDI keyboard's full pitch range in keyboard mode).
function send(body) {
  api('/api/note', jsonBody({ velocity: 100, keyboard: mode === 'kbd', ...body }))
    .catch(err => { if (body.on) tick(`⚠ note failed: ${err.message}`); });
}
function note(slot, on) { send({ slot, on }); }   // on-screen/qwerty keys play at the send() default velocity
function paint(slot, sounding) {
  // always light the piano key; in KEYBOARD mode the pad isn't what's triggered
  // (the selected sample plays pitched), so don't light the pad grid there
  const sels = [`#piano .pkey[data-slot="${slot}"]`];
  if (mode !== 'kbd') sels.push(`#pad-grid .pad[data-slot="${slot}"]`);
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el) el.classList.toggle('sounding', sounding);
  }
}
function releaseKeys() {
  for (const slot of held.values()) { note(slot, false); paint(slot, false); }
  held.clear();
}

// ── the on-screen piano ──────────────────────────────────────────────────────
function buildPiano() {
  const piano = $('#piano');
  if (!piano) return;
  piano.innerHTML = '';
  const whites = [];
  for (let o = 0; o < 3; o++) for (let w = 0; w < 7; w++) whites.push(o * 12 + WHITE[w]);
  const nW = whites.length;          // 21

  whites.forEach((slot, idx) => {
    const k = document.createElement('button');
    k.className = 'pkey white';
    k.dataset.slot = slot;
    k.tabIndex = -1;
    k.style.left = (idx / nW * 100) + '%';
    k.style.width = (100 / nW) + '%';
    // mark each octave's C with its name; the rest stay clean
    k.innerHTML = `<span class="pk-note">${slot % 12 === 0 ? noteName(slot) : ''}</span>`
      + '<span class="pk-q"></span>';
    piano.append(k);
  });
  for (let o = 0; o < 3; o++) {
    for (const wStr in BLACK_AFTER) {
      const w = +wStr;
      const slot = o * 12 + BLACK_AFTER[w];
      const k = document.createElement('button');
      k.className = 'pkey black';
      k.dataset.slot = slot;
      k.tabIndex = -1;
      k.style.left = ((o * 7 + w + 1) / nW * 100) + '%';   // CSS centres it (translateX -50%)
      k.innerHTML = '<span class="pk-q"></span>';
      piano.append(k);
    }
  }
}

// reflect octave, the per-key QWERTY labels, and used/loaded/selected state
export function syncKeybed() {
  const piano = $('#piano');
  if (!piano || !piano.children.length) return;
  $('#kb-oct-val').textContent = QWERTY_OCTAVES[octave];
  $('#keybed').classList.toggle('armed', enabled);
  // SAMPLE mode dims keys with no sample; KEYBOARD mode plays the selected
  // sample across all keys (so the per-key sample state is irrelevant)
  $('#keybed').classList.toggle('mode-sample', mode === 'sample');
  $('#keybed').classList.toggle('mode-kbd', mode === 'kbd');

  const labelBySlot = {};
  for (const code in QWERTY_KEYMAP) {
    const slot = qwertySlot(code, octave);
    if (slot != null) labelBySlot[slot] = KEYLABEL[code];
  }
  const slots = state.bank && state.bank.slots;
  for (const key of piano.children) {
    const slot = +key.dataset.slot;
    key.querySelector('.pk-q').textContent = labelBySlot[slot] || '';
    key.classList.toggle('mapped', slot in labelBySlot);
    const s = slots && slots[slot];
    key.classList.toggle('used', !!(s && !s.empty));
    key.classList.toggle('loaded', state.buffers.has(slot));
    key.classList.toggle('sel', state.sel === slot);
  }
}

function setOctave(next) {
  next = Math.max(0, Math.min(QWERTY_OCTAVES.length - 1, next));
  if (next === octave) return;
  octave = next;
  try { localStorage.setItem('msmpl.qwerty.oct', String(octave)); } catch { /* ignore */ }
  tick(`octave: ${QWERTY_OCTAVES[octave]}`);
  syncKeybed();
}

function setMode(next) {
  if (next === mode) return;
  releaseKeys(); clickRelease(); releaseMidi();   // release held notes on the OLD channel first
  mode = next;
  for (const [id, m] of [['#kb-mode-sample', 'sample'], ['#kb-mode-kbd', 'kbd']]) {
    const b = $(id);
    b.classList.toggle('on', mode === m);
    b.setAttribute('aria-pressed', String(mode === m));
  }
  try { localStorage.setItem('msmpl.qwerty.mode', mode); } catch { /* ignore */ }
  syncKeybed();
  tick(mode === 'kbd'
    ? 'keyboard: KEYBOARD mode (selected sample, pitched)'
    : 'keyboard: SAMPLE mode (one sample per key)');
}

function setEnabled(on) {
  enabled = on;
  if (!on) releaseKeys();
  syncKeybed();
  try { localStorage.setItem('msmpl.qwerty', on ? '1' : '0'); } catch { /* ignore */ }
  tick(`type to play: ${on ? `ON (${QWERTY_OCTAVES[octave]})` : 'OFF'}`);
}

// ── computer-keyboard input ───────────────────────────────────────────────────
const onSamples = () => !$('#view-samples').hidden;
function blocked() {                 // typing in a text field / select, or a dialog is open
  if (document.querySelector('dialog[open]')) return true;
  const e = document.activeElement;
  if (!e) return false;
  if (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return true;
  if (e.tagName === 'INPUT')
    return !['checkbox', 'radio', 'range', 'button'].includes(e.type);
  return false;
}

// capture phase: consume a handled key BEFORE ux.js's shortcut handler sees it
addEventListener('keydown', e => {
  if (!enabled || e.metaKey || e.ctrlKey || e.altKey || !onSamples() || blocked()) return;
  if (e.code === 'KeyZ' || e.code === 'KeyX') {
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) setOctave(octave + (e.code === 'KeyX' ? 1 : -1));
    return;
  }
  if (QWERTY_KEYMAP[e.code] == null) return;    // not a piano key → leave for shortcuts
  e.preventDefault(); e.stopPropagation();      // a piano key is ours, even if out of range
  if (e.repeat || held.has(e.code)) return;
  const slot = qwertySlot(e.code, octave);
  if (slot == null) return;                     // mapped but above B5 → consumed, silent
  held.set(e.code, slot);
  paint(slot, true);
  note(slot, true);
}, true);

addEventListener('keyup', e => {
  const slot = held.get(e.code);
  if (slot == null) return;
  e.preventDefault();
  held.delete(e.code);
  paint(slot, false);
  note(slot, false);
}, true);

// never leave a note stuck if focus or tab visibility changes mid-hold
addEventListener('blur', () => { releaseKeys(); clickRelease(); releaseMidi(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseKeys(); clickRelease(); releaseMidi(); }
});

// ── real MIDI keyboard input (Web MIDI) ───────────────────────────────────────
// Forward a connected MIDI controller's notes to the device, honoring the current
// SAMPLE / KEYBOARD mode. The browser only READS the controller; the bridge still
// solely owns the device's USB, so this never contends for the port.
const MIDI_OK = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
let midiAccess = null;
const midiHeld = new Map();          // controller note physically down → on-screen slot (null = out of range)
const sustainedOff = new Map();      // note whose key is UP but held sounding by the pedal → slot
let sustainOn = false;               // CC#64 damper pedal state

// resolve a controller note for the current mode: KEYBOARD = raw pitch (full
// range), SAMPLE = a pad (note−48, ignoring notes outside C3..B5). null = not playable.
function midiTarget(m) {
  const slot = m - 48, inRange = slot >= 0 && slot <= 35;
  if (mode === 'kbd') return { body: { note: m }, slot: inRange ? slot : null };
  return inRange ? { body: { slot }, slot } : null;
}
function sendOff(m, slot) { send(mode === 'kbd' ? { note: m, on: false } : { slot, on: false }); }

function midiNoteOn(m, vel) {
  const t = midiTarget(m);
  if (!t) return;
  if (sustainedOff.has(m)) { sendOff(m, sustainedOff.get(m)); sustainedOff.delete(m); }   // clean re-attack
  send({ ...t.body, on: true, velocity: vel });
  if (t.slot != null) paint(t.slot, true);
  midiHeld.set(m, t.slot);
}
function midiNoteOff(m) {
  if (!midiHeld.has(m)) return;
  const slot = midiHeld.get(m);
  midiHeld.delete(m);
  if (sustainOn) {                   // pedal down: keep it sounding (and lit) until the pedal lifts
    sustainedOff.set(m, slot);
  } else {
    sendOff(m, slot);
    if (slot != null) paint(slot, false);
  }
}
function midiSustain(on) {            // CC#64 — app-side (the device may not honor the CC itself)
  sustainOn = on;
  if (!on) {                         // pedal up: release everything it was holding
    for (const [m, slot] of sustainedOff) { sendOff(m, slot); if (slot != null) paint(slot, false); }
    sustainedOff.clear();
  }
}
let bentKbd = false;                 // a non-centre bend is currently applied (keyboard channel)
function midiPitchBend(lsb, msb) {
  if (mode !== 'kbd') return;        // the device pitch-bends only the keyboard-mode voice
  const value = (msb << 7) | lsb;    // 14-bit, centre 8192
  bentKbd = value !== 8192;
  api('/api/pitch-bend', jsonBody({ value, keyboard: true })).catch(() => { /* ignore */ });
}
function resetBend() {               // return the wheel to centre (on release / mode switch / blur)
  if (!bentKbd) return;
  bentKbd = false;
  api('/api/pitch-bend', jsonBody({ value: 8192, keyboard: true })).catch(() => { /* ignore */ });
}
function releaseMidi() {
  for (const [m, slot] of midiHeld) { sendOff(m, slot); if (slot != null) paint(slot, false); }
  midiHeld.clear();
  for (const [m, slot] of sustainedOff) { sendOff(m, slot); if (slot != null) paint(slot, false); }
  sustainedOff.clear();
  sustainOn = false;
  resetBend();
}
function onMidiMessage(e) {
  const [status, d1, d2] = e.data;
  const cmd = status & 0xf0;
  if (cmd === 0x90 && d2 > 0) midiNoteOn(d1, d2);
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) midiNoteOff(d1);
  else if (cmd === 0xe0) midiPitchBend(d1, d2);          // pitch bend wheel
  else if (cmd === 0xb0 && d1 === 64) midiSustain(d2 >= 64);   // sustain pedal (CC#64)
  // other CC / clock etc. ignored
}
function midiInputNames() {
  return midiAccess ? [...midiAccess.inputs.values()].map(i => i.name).filter(Boolean) : [];
}
function bindMidiInputs() {            // (re)attach to every input — also the hotplug handler
  if (!midiAccess) return;
  for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidiMessage;
  const names = midiInputNames();
  $('#midi-toggle').title = names.length
    ? 'MIDI input: ' + names.join(', ')
    : 'No MIDI device detected yet — connect one and it is picked up automatically';
}
async function setMidi(on) {
  if (on) {
    try { midiAccess = midiAccess || await navigator.requestMIDIAccess(); }
    catch { tick('⚠ MIDI access was blocked'); $('#midi-in').checked = false; return; }
    midiAccess.onstatechange = bindMidiInputs;
    bindMidiInputs();
    const names = midiInputNames();
    tick(names.length ? `MIDI input: ON (${names.join(', ')})` : 'MIDI input: ON (waiting for a device)');
  } else {
    if (midiAccess) for (const input of midiAccess.inputs.values()) input.onmidimessage = null;
    releaseMidi();
    tick('MIDI input: OFF');
  }
  $('#keybed').classList.toggle('midi-on', on);
  try { localStorage.setItem('msmpl.midi', on ? '1' : '0'); } catch { /* ignore */ }
}

// ── mouse/touch on the on-screen piano (works even when not armed) ────────────
function clickRelease() {
  if (clickSlot == null) return;
  const s = clickSlot; clickSlot = null;
  paint(s, false); note(s, false);
}
{
  const piano = $('#piano');
  piano.addEventListener('pointerdown', e => {
    const key = e.target.closest('.pkey');
    if (!key) return;
    e.preventDefault();
    clickSlot = +key.dataset.slot;
    paint(clickSlot, true);
    note(clickSlot, true);
  });
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, clickRelease);
}

// ── controls (octave buttons + arm toggle), persisted ─────────────────────────
$('#kb-oct-down').onclick = () => setOctave(octave - 1);
$('#kb-oct-up').onclick = () => setOctave(octave + 1);
$('#kb-mode-sample').onclick = () => setMode('sample');
$('#kb-mode-kbd').onclick = () => setMode('kbd');
{
  const raw = (() => { try { return localStorage.getItem('msmpl.qwerty.oct'); } catch { return null; } })();
  const n = raw == null ? 1 : +raw;
  octave = Number.isInteger(n) && n >= 0 && n <= 2 ? n : 1;
  try { if (localStorage.getItem('msmpl.qwerty.mode') === 'kbd') mode = 'kbd'; } catch { /* ignore */ }
  for (const [id, m] of [['#kb-mode-sample', 'sample'], ['#kb-mode-kbd', 'kbd']]) {
    const b = $(id);
    b.classList.toggle('on', mode === m);
    b.setAttribute('aria-pressed', String(mode === m));
  }
  const t = $('#qwerty-play');
  try { t.checked = localStorage.getItem('msmpl.qwerty') === '1'; } catch { /* ignore */ }
  enabled = t.checked;
  t.addEventListener('change', () => setEnabled(t.checked));

  // MIDI input: only offer it where Web MIDI exists (Chrome/Edge/Firefox; not Safari)
  if (MIDI_OK) {
    $('#midi-toggle').hidden = false;
    const mi = $('#midi-in');
    mi.addEventListener('change', () => setMidi(mi.checked));
    // re-enable only if it was on before — avoids a surprise permission prompt on every load
    let want = false;
    try { want = localStorage.getItem('msmpl.midi') === '1'; } catch { /* ignore */ }
    if (want) { mi.checked = true; setMidi(true); }
  }
}

buildPiano();
syncKeybed();
