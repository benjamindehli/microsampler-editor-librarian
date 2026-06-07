// microSAMPLER Editor / Librarian — entry module.
// Talks to the local bridge (same origin). Live edits = POST /api/param with
// the hardware-verified 3-value Parameter Change (obj = 16 + slot).
import { $, apiJson } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { renderPads } from './pads.js';
import { renderMeter } from './meter.js';
import { showSlot } from './slot.js';
import { fxFromBank, renderFx } from './effect.js';
import { loadBackups } from './utility.js';
import { subscribeEvents } from './events.js';
import './waveform.js';     // wires marker drag, audition, resize redraw
import './dialogs.js';      // wires upload/rename dialogs + editor drop
import './patterns.js';     // wires the patterns view

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
}

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
    state.bank = await apiJson('/api/bank');
    $('#bank-name').textContent = (state.bank.name || '--------').padEnd(8);
    $('#bank-bpm').textContent = state.bank.bpm.toFixed(1);
    renderPads();
    renderMeter();
    if (state.sel != null) showSlot(state.sel, { keepWave: true });
    if (state.bank.effect) { fxFromBank(state.bank.effect); renderFx(); }
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
}
document.querySelectorAll('.view-btn').forEach(b =>
  b.onclick = () => showView(b.dataset.view));

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
