// Sample parameter controls: live-edit ids, value encodings, the control
// strip wiring, and panel-edit reflection.
import { state } from 'functions/state.js';
import { tick } from 'functions/ticker.js';
import { $, api, fmtSigned, jsonBody } from 'functions/util.js';
import { VALUE_TABLES } from 'functions/valueTables.js';

// Live-edit param ids — HARDWARE-CONFIRMED 2026-06-06 by panel-knob capture
// (the editor binary's converter table did NOT match the device's actual
// panel id scheme for the level/pan/semitone/tune/velo cluster — the device
// is authoritative). START/END are NOT live params (u32 frames > 14 bits);
// they're set via the param blob — see the waveform marker dragging.
export const PARAM = {
  LOOP: 16, BPM_SYNC: 17, REVERSE: 18,
  DECAY: 21, RELEASE: 22, LEVEL: 24, PAN: 25, FX_SW: 26,
  SEMITONE: 27, TUNE: 28, VELO_INT: 29,
};
const AMP_LEVEL = VALUE_TABLES.AmpLevel || [];
export const fmtPan = v => v === 64 ? 'CNT' : (v < 64 ? `L${64 - v}` : `R${v - 64}`);
export const fmtLevel = v => AMP_LEVEL[v] || String(v);

// Semitone/Velo Int travel as two's-complement 14-bit (signed model space on
// the slider; only RECEIVE needs decoding — pack14 handles the send side).
export const BIPOLAR = new Set([PARAM.SEMITONE, PARAM.VELO_INT]);
export const dec14 = v => (v >= 8192 ? v - 16384 : v);

// TUNE: 0..127 wire → −99..+99 cents, fully decoded from hardware (2026-06-06,
// exact at 35 measured points). The fine region is two linear halves around a
// centre detent — negative HW = wire−62, positive HW = wire−66, with wire
// 62..66 all reading 0 — and the panel's coarse settings step by 5 out to ±99.
export function tuneCents(w) {
  if (w <= 2) return -99;
  if (w < 12) return -50 - (12 - w) * 5;    // wire 3..11   → −95..−55
  if (w < 62) return w - 62;                // wire 12..61  → −50..−1
  if (w <= 66) return 0;                     // centre detent
  if (w <= 116) return w - 66;              // wire 67..116 → +1..+50
  if (w >= 126) return 99;
  return 50 + (w - 116) * 5;                // wire 117..125 → +55..+95
}
export const tuneDisplay = wire => fmtSigned(tuneCents(wire));
export const OBJ_BASE = 16;

// keep the bank cache in sync with every edit — controls initialise from it
// on pad selection, so without this, re-selecting a pad showed the state as
// of the last RECEIVE. `v` is display/model space (signed for bipolar).
export function cacheParam(slot, param, v) {
  const s = state.bank && state.bank.slots[slot];
  if (!s || s.empty) return;
  switch (param) {
    case PARAM.LOOP: s.loop = !!v; break;
    case PARAM.BPM_SYNC: s.bpm_sync = v; break;
    case PARAM.REVERSE: s.reverse = !!v; break;
    case PARAM.DECAY: s.decay = v; break;
    case PARAM.RELEASE: s.release = v; break;
    case PARAM.LEVEL: s.level = v; break;
    case PARAM.PAN: s.pan = v; break;
    case PARAM.FX_SW: s.fx_sw = !!v; break;
    case PARAM.SEMITONE: s.semitone = v; break;
    case PARAM.TUNE: s.tune = v; break;
    case PARAM.VELO_INT: s.velo_int = v; break;
  }
}

// read a param's current MODEL value from the cache (inverse of cacheParam;
// same space the control setters + the wire `value` use)
function readModel(slot, param) {
  const s = state.bank && state.bank.slots[slot];
  if (!s || s.empty) return null;
  switch (param) {
    case PARAM.LOOP: return s.loop ? 1 : 0;
    case PARAM.REVERSE: return s.reverse ? 1 : 0;
    case PARAM.FX_SW: return s.fx_sw ? 1 : 0;
    case PARAM.BPM_SYNC: return s.bpm_sync;
    case PARAM.DECAY: return s.decay;
    case PARAM.RELEASE: return s.release;
    case PARAM.LEVEL: return s.level;
    case PARAM.PAN: return s.pan;
    case PARAM.TUNE: return s.tune;
    case PARAM.SEMITONE: return s.semitone;
    case PARAM.VELO_INT: return s.velo_int;
  }
  return null;
}

// send a param to a SPECIFIC slot (model-space value): cache it, mirror the
// control if that slot is showing, POST it. Used by edits + undo/redo.
async function sendParamTo(slot, param, value) {
  cacheParam(slot, param, value);
  if (slot === state.sel) { flash(param); setControl(param, value); }
  try {
    await api('/api/param', jsonBody({ obj: OBJ_BASE + slot, param, value }));
    tick(`→ S${slot + 1} #${param} = ${value}`);
  } catch (e) { tick(`⚠ send failed: ${e.message}`); }
}

// ── undo / redo of sample param edits ────────────────────────────────────
const undoStack = [], redoStack = [];
async function sendParam(param, value) {
  if (state.sel == null) return;
  const before = readModel(state.sel, param);
  if (before !== value) {
    undoStack.push({ slot: state.sel, param, before, after: value });
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  await sendParamTo(state.sel, param, value);
}

async function step(stack, other, key, label) {
  const e = stack.pop();
  if (!e) return;
  other.push(e);
  const { selectSlot } = await import('components/pads/pads.js');
  if (e.slot !== state.sel) selectSlot(e.slot);
  await sendParamTo(e.slot, e.param, e[key]);
  tick(`${label} S${e.slot + 1} #${e.param}`);
}
export const undo = () => step(undoStack, redoStack, 'before', '↶ undo');
export const redo = () => step(redoStack, undoStack, 'after', '↷ redo');

export function flash(param) {
  const el = document.querySelector(`[data-flash="${param}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;                           // restart transition
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

// toggle switches
function wireSwitch(btnSel, valSel, param) {
  const btn = $(btnSel);
  btn.onclick = () => {
    const on = btn.getAttribute('aria-checked') !== 'true';
    setSwitch(btnSel, valSel, on);
    sendParam(param, on ? 1 : 0);
  };
}
export function setSwitch(btnSel, valSel, on) {
  $(btnSel).setAttribute('aria-checked', String(on));
  $(valSel).textContent = on ? 'ON' : 'OFF';
}
wireSwitch('#ctl-loop', '#val-loop', PARAM.LOOP);
wireSwitch('#ctl-reverse', '#val-reverse', PARAM.REVERSE);

// BPM Sync segmented switch (device rule: Pitch Change locks Tune)
$('#ctl-sync').querySelectorAll('button').forEach(b => {
  b.onclick = () => { setSeg(+b.dataset.v); sendParam(PARAM.BPM_SYNC, +b.dataset.v); };
});
export function setSeg(v) {
  $('#ctl-sync').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', +b.dataset.v === v);
    b.setAttribute('aria-pressed', String(+b.dataset.v === v));
  });
  // device rule: Pitch Change disables Tune AND Semitone
  $('#tune-block').classList.toggle('locked', v === 2);
  $('#semitone-block').classList.toggle('locked', v === 2);
}

// faders — `fmt` (optional) maps the 0..127 byte to a display string
function wireFader(inSel, valSel, param, fmt) {
  const input = $(inSel);
  input.oninput = () => setFader(inSel, valSel, +input.value, fmt);
  input.onchange = () => sendParam(param, +input.value);
}
export function setFader(inSel, valSel, v, fmt) {
  $(inSel).value = v;
  $(valSel).textContent = fmt ? fmt(v) : String(v);
}
wireFader('#ctl-decay', '#val-decay', PARAM.DECAY);
wireFader('#ctl-release', '#val-release', PARAM.RELEASE);
wireFader('#ctl-tune', '#val-tune', PARAM.TUNE, tuneDisplay);
wireFader('#ctl-level', '#val-level', PARAM.LEVEL, fmtLevel);
wireFader('#ctl-pan', '#val-pan', PARAM.PAN, fmtPan);
wireFader('#ctl-semitone', '#val-semitone', PARAM.SEMITONE, fmtSigned);
wireFader('#ctl-velo', '#val-velo', PARAM.VELO_INT, fmtSigned);
wireSwitch('#ctl-fx', '#val-fx', PARAM.FX_SW);

// set a control from a MODEL-space value (no dec14 — that's the wire form)
function setControl(param, value) {
  switch (param) {
    case PARAM.LOOP: setSwitch('#ctl-loop', '#val-loop', !!value); break;
    case PARAM.REVERSE: setSwitch('#ctl-reverse', '#val-reverse', !!value); break;
    case PARAM.BPM_SYNC: setSeg(value); break;
    case PARAM.DECAY: setFader('#ctl-decay', '#val-decay', value); break;
    case PARAM.RELEASE: setFader('#ctl-release', '#val-release', value); break;
    case PARAM.TUNE: setFader('#ctl-tune', '#val-tune', value, tuneDisplay); break;
    case PARAM.SEMITONE: setFader('#ctl-semitone', '#val-semitone', value, fmtSigned); break;
    case PARAM.LEVEL: setFader('#ctl-level', '#val-level', value, fmtLevel); break;
    case PARAM.PAN: setFader('#ctl-pan', '#val-pan', value, fmtPan); break;
    case PARAM.VELO_INT: setFader('#ctl-velo', '#val-velo', value, fmtSigned); break;
    case PARAM.FX_SW: setSwitch('#ctl-fx', '#val-fx', !!value); break;
  }
}

export function reflect(param, value) {          // from a device (wire) event
  flash(param);
  setControl(param, BIPOLAR.has(param) ? dec14(value) : value);
}
