// UX polish: keyboard shortcuts, accent-colour theming, help overlay,
// master-volume slider.
import { refreshBank } from './app.js';
import { redo, undo } from './controls.js';
import { selectSlot } from './pads.js';
import { stopTransport } from './patterns.js';
import { slotData, state } from './state.js';
import { tick } from './ticker.js';
import { $, api, jsonBody } from './util.js';
import { stopAudition } from './waveform.js';

// ── accent theming (CSS custom props on :root, persisted) ────────────────
// Only the three RGB triplets are overridden — every accent surface (glows,
// borders, the phosphor backgrounds, the canvas waveform) derives from them,
// so switching theme recolours the whole app.
const THEMES = [
  { name: 'AMBER',   rgb: '255, 138, 30',  hi: '255, 192, 99',  dk: '138, 69, 0' },
  { name: 'GREEN',   rgb: '54, 224, 122',  hi: '155, 255, 196', dk: '28, 122, 66' },
  { name: 'CYAN',    rgb: '51, 198, 255',  hi: '159, 230, 255', dk: '26, 106, 138' },
  { name: 'MAGENTA', rgb: '255, 79, 208',  hi: '255, 167, 236', dk: '138, 30, 110' },
  { name: 'RED',     rgb: '255, 74, 61',   hi: '255, 150, 140', dk: '138, 28, 22' },
];
const themeSelect = $('#theme-select');
themeSelect.innerHTML = THEMES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');

function applyTheme(i) {
  i = ((i % THEMES.length) + THEMES.length) % THEMES.length;
  const t = THEMES[i];
  const r = document.documentElement.style;
  r.setProperty('--amber-rgb', t.rgb);
  r.setProperty('--amber-hi-rgb', t.hi);
  r.setProperty('--amber-dk-rgb', t.dk);
  try { localStorage.setItem('msmpl.theme', String(i)); } catch { /* ignore */ }
  themeSelect.value = String(i);
  dispatchEvent(new Event('msmpl-theme'));   // recolour the canvas waveform
}
let themeIdx = (() => { try { return +localStorage.getItem('msmpl.theme') || 0; }
                       catch { return 0; } })();
applyTheme(themeIdx);
themeSelect.onchange = () => applyTheme(+themeSelect.value);

// ── help overlay ─────────────────────────────────────────────────────────
$('#help-btn').onclick = () => $('#help-dialog').showModal();

// ── panic: all sound off + stop, and reset the local playing UI ──────────
$('#panic-btn').onclick = () => {
  stopAudition(false);                             // bridge silences it; just reset UI
  stopTransport();
  api('/api/panic', { method: 'POST' })
    .then(() => tick('⏻ panic — all sound off')).catch(() => { });
};

// ── master volume (device output, Universal SysEx) ───────────────────────
// Live while dragging but throttled (one SysEx each), with the final value
// always sent on release. Sets only — the device doesn't report its level, so
// the slider starts at max and doesn't transmit until the user moves it.
{
  const vol = $('#master-vol');
  let lastSent = 0;
  const send = () => api('/api/master-volume', jsonBody({ value: +vol.value })).catch(() => { });
  vol.addEventListener('input', () => {
    const now = performance.now();
    if (now - lastSent > 80) { lastSent = now; send(); }
  });
  vol.addEventListener('change', send);
}

// ── keyboard shortcuts ───────────────────────────────────────────────────
const typing = () => {
  const e = document.activeElement;
  return e && (e.tagName === 'INPUT' || e.tagName === 'SELECT' ||
               e.tagName === 'TEXTAREA');
};
const dialogOpen = () => !!document.querySelector('dialog[open]');

addEventListener('keydown', e => {
  // undo/redo work even while a slot control has focus
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    (e.shiftKey ? redo : undo)();
    return;
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (typing() || dialogOpen() || mod) return;

  const onSamples = !$('#view-samples').hidden;
  if (e.key === '?') { $('#help-dialog').showModal(); e.preventDefault(); return; }
  if (e.key === 'r' || e.key === 'R') {
    refreshBank().catch(() => { }); e.preventDefault(); return;
  }
  if (!onSamples) return;
  if (e.key === ' ') {                           // audition selected
    if (state.sel != null && !slotData(state.sel).empty) {
      $('#audition-btn').click(); e.preventDefault();
    }
    return;
  }
  // waveform zoom: + in, - out, 0 fit (the buttons no-op/disable as needed)
  const zoom = { '+': '#wz-in', '=': '#wz-in', '-': '#wz-out', _: '#wz-out', '0': '#wz-fit' }[e.key];
  if (zoom) {
    const btn = $(zoom);
    if (btn && !btn.disabled) btn.click();
    e.preventDefault();
    return;
  }
  const COLS = 3, N = 36;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
  if (delta != null) {
    e.preventDefault();
    const cur = state.sel == null ? 0 : state.sel;
    const next = Math.max(0, Math.min(N - 1, cur + delta));
    if (next !== state.sel) selectSlot(next);
  }
});
