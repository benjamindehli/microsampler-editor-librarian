// microSAMPLER Editor / Librarian — entry module.
// Talks to the local bridge (same origin). Live edits = POST /api/param with
// the hardware-verified 3-value Parameter Change (obj = 16 + slot).
import './dialogs.js';      // wires upload/rename dialogs + editor drop
import './patterns.js';     // wires the patterns view
import './slotops.js';      // wires copy/swap drop + clear button
import './ux.js';           // keyboard shortcuts, theming, help overlay

import { fxFromBank, renderFx } from './effect.js';
import { subscribeEvents } from './events.js';
import { loadAllSamples, renderMeter } from './meter.js';
import { renderPads } from './pads.js';
import { reapplyFormats } from './sampleLoad.js';
import { showSlot } from './slot.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, apiJson } from './util.js';
import { loadBackups } from './utility.js';
import { redrawCurrent } from './waveform.js';   // also wires marker drag/audition

async function boot() {
  let st;
  try {
    st = await apiJson('/api/status');
  } catch {
    setOnline(false);                             // bridge truly unreachable
    setTimeout(boot, 2500);                       // auto-reconnect
    return;
  }
  setOnline(true, st);
  subscribeEvents();
  try {
    await refreshBank();
  } catch (e) {
    // bridge is up but the device op failed — stay online, surface the error
    tick(`⚠ bank read failed: ${e.message}`);
    $('#bank-name').textContent = 'ERROR';
    $('#editor-empty').querySelector('p').textContent =
      'BANK READ FAILED — ' + e.message.toUpperCase();
    console.error('bank read failed:', e.message);
  }
  restoreView();                                  // now that the app is up
}                                                 // refreshBank() preloads samples

function setOnline(ok, st) {
  state.online = ok;
  $('#offline').hidden = ok;
  $('#conn-led').className = 'led ' + (ok ? 'ok' : 'err');
  $('#conn-caption').textContent = ok ? 'CONNECTED' : 'OFFLINE';
  $('#mock-badge').hidden = !(ok && st && st.mock);
}

export async function refreshBank() {
  const btn = $('#refresh-btn');
  btn.setAttribute('aria-busy', 'true');
  try {
    const prevName = state.bank && state.bank.name;
    state.bank = await apiJson('/api/bank');
    // a different bank (switched on the device, or the first load) invalidates
    // cached audio; same bank keeps it — re-stamp persisted formats so the meter
    // stays exact and load state survives a focus re-sync.
    const bankChanged = state.bank.name !== prevName;
    if (bankChanged) { state.buffers.clear(); state.formats.clear(); }
    reapplyFormats();
    $('#bank-name').textContent = (state.bank.name || '--------').padEnd(8);
    $('#bank-bpm').textContent = state.bank.bpm.toFixed(1);
    renderPads();
    renderMeter();
    if (state.sel != null) {
      showSlot(state.sel, { keepWave: true });   // refresh header/readouts…
      redrawCurrent();                            // …and the waveform markers
    }
    if (state.bank.effect) { fxFromBank(state.bank.effect); renderFx(); }
    // a fresh bank (first connect, or switched on the device) → preload all its
    // samples so the meter is exact and waveforms are instant. Guarded + skips
    // cached slots, so a same-bank re-sync is a no-op.
    if (bankChanged) loadAllSamples().catch(() => { });
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

// ── view nav ─────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.view === name));
  $('#view-samples').hidden = name !== 'samples';
  $('#view-effect').hidden = name !== 'effect';
  $('#view-patterns').hidden = name !== 'patterns';
  $('#view-utility').hidden = name !== 'utility';
  if (name === 'utility') loadBackups().catch(() => { });
  if (name === 'effect') renderFx();
  try { localStorage.setItem('msmpl.view', name); } catch { /* ignore */ }
}
document.querySelectorAll('.view-btn').forEach(b =>
  b.onclick = () => showView(b.dataset.view));

// restore the last-open view across reloads (defaults to SAMPLES). Deferred to
// boot() rather than module load so a saved EFFECT/UTILITY view doesn't render
// or fetch (loadBackups) against empty state before the bridge is connected.
function restoreView() {
  try {
    const v = localStorage.getItem('msmpl.view');
    if (v && v !== 'samples' && $(`.view-btn[data-view="${v}"]`)) showView(v);
  } catch { /* ignore */ }
}

$('#refresh-btn').onclick = () => refreshBank().catch(e => tick('⚠ ' + e.message));

// Auto re-sync from the device when returning to the window. The microSAMPLER
// only transmits panel param-edits while on its SAMPLE-EDIT page, so toggles
// made elsewhere on the hardware leave the GUI snapshot stale; re-reading the
// authoritative bank blob on focus-return fixes that transparently. Guarded:
// online only, skip while any device op holds the lock (#refresh-btn busy),
// debounced to 2 s so a quick click-in doesn't double-read.
let lastSync = Date.now();
function maybeResync() {
  if (document.visibilityState !== 'visible' || !state.online) return;
  if ($('#refresh-btn').hasAttribute('aria-busy')) return;   // device busy
  if (Date.now() - lastSync < 2000) return;
  lastSync = Date.now();
  refreshBank().catch(() => { });
}
window.addEventListener('focus', maybeResync);
document.addEventListener('visibilitychange', maybeResync);

boot();
