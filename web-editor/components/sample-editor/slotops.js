// Slot operations: copy / swap (pad drag-and-drop) + clear (editor button).
// All run device-side in the bridge (no audio round-trips through the browser).
import { refreshBank } from 'app.js';
import { forgetSample } from 'components/sample-editor/sampleLoad.js';
import { showSlot } from 'components/sample-editor/slot.js';
import { noteName } from 'functions/notes.js';
import { slotData, state } from 'functions/state.js';
import { tick } from 'functions/ticker.js';
import { $, apiJson, confirmDialog, jsonBody } from 'functions/util.js';

const padLabel = i => `PAD ${i + 1} (${noteName(i)})`;
const nameOf = i => { const s = slotData(i); return s.empty ? 'empty' : s.name; };

export function openSlotOp(from, to) {
  const dlg = $('#slotop-dialog');
  $('#so-title').textContent = `${padLabel(from)} → ${padLabel(to)}`;
  $('#so-warn').textContent =
    `COPY overwrites ${padLabel(to)} ("${nameOf(to)}") with "${nameOf(from)}". ` +
    `SWAP exchanges the two. (Current bank / RAM.)`;
  dlg.showModal();
  $('#so-copy').onclick = e => { e.preventDefault(); dlg.close(); runOp('copy', from, to); };
  $('#so-swap').onclick = e => { e.preventDefault(); dlg.close(); runOp('swap', from, to); };
}

async function runOp(kind, from, to) {
  forgetSample(from); forgetSample(to);          // their audio changes
  try {
    if (kind === 'copy')
      await apiJson('/api/sample/copy', jsonBody({ from, to }));
    else
      await apiJson('/api/sample/swap', jsonBody({ a: from, b: to }));
    tick(`${kind} S${from + 1}${kind === 'copy' ? '→' : '↔'}S${to + 1}`);
    await refreshBank();
  } catch (e) {
    tick(`⚠ ${kind} failed: ${e.message}`);
    alert(`${kind} failed: ${e.message}`);
  }
}

// CLEAR the selected slot (empties it on the device — RAM)
$('#clear-btn').onclick = async () => {
  if (state.sel == null) return;
  const s = slotData(state.sel);
  if (s.empty) return;
  if (!await confirmDialog(`CLEAR ${padLabel(state.sel)}`,
      `Clear "${s.name}"? Empties the slot in the device's current bank (RAM).`,
      'CLEAR')) return;
  const sel = state.sel;
  forgetSample(sel);
  try {
    await apiJson(`/api/sample/${sel}/clear`, { method: 'POST' });
    tick(`✕ cleared S${sel + 1}`);
    await refreshBank();
    // refreshBank redraws with keepWave (keeps the canvas); force a full
    // reload so the now-empty slot's stale waveform is cleared too.
    if (state.sel === sel) await showSlot(sel);
  } catch (e) {
    tick(`⚠ clear failed: ${e.message}`);
    alert('Clear failed: ' + e.message);
  }
};
