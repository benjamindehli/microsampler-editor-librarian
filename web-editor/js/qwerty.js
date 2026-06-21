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
const held = new Map();              // e.code → slot currently sounding (keyboard)
let clickSlot = null;                // slot currently held by the mouse on the piano

// ── device note + visual paint ───────────────────────────────────────────────
function note(slot, on) {
  api('/api/note', jsonBody({ slot, on, velocity: 100 }))
    .catch(err => { if (on) tick(`⚠ note failed: ${err.message}`); });
}
function paint(slot, sounding) {
  for (const sel of [`#pad-grid .pad[data-slot="${slot}"]`, `#piano .pkey[data-slot="${slot}"]`]) {
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
addEventListener('blur', () => { releaseKeys(); clickRelease(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseKeys(); clickRelease(); }
});

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
{
  const raw = (() => { try { return localStorage.getItem('msmpl.qwerty.oct'); } catch { return null; } })();
  const n = raw == null ? 1 : +raw;
  octave = Number.isInteger(n) && n >= 0 && n <= 2 ? n : 1;
  const t = $('#qwerty-play');
  try { t.checked = localStorage.getItem('msmpl.qwerty') === '1'; } catch { /* ignore */ }
  enabled = t.checked;
  t.addEventListener('change', () => setEnabled(t.checked));
}

buildPiano();
syncKeybed();
