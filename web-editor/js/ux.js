// UX polish: keyboard shortcuts, accent-colour theming, help overlay.
import { $ } from './util.js';
import { state, slotData } from './state.js';
import { selectSlot } from './pads.js';
import { undo, redo } from './controls.js';
import { refreshBank } from './app.js';

// ── accent theming (CSS custom props on :root, persisted) ────────────────
const THEMES = [
  { name: 'AMBER', amber: '#ff8a1e', hi: '#ffc063', dk: '#8a4500' },
  { name: 'GREEN', amber: '#36e07a', hi: '#9bffc4', dk: '#1c7a42' },
  { name: 'CYAN', amber: '#33c6ff', hi: '#9fe6ff', dk: '#1a6a8a' },
  { name: 'MAGENTA', amber: '#ff4fd0', hi: '#ffa7ec', dk: '#8a1e6e' },
];
function applyTheme(i) {
  const t = THEMES[((i % THEMES.length) + THEMES.length) % THEMES.length];
  const r = document.documentElement.style;
  r.setProperty('--amber', t.amber);
  r.setProperty('--amber-hi', t.hi);
  r.setProperty('--amber-dk', t.dk);
  try { localStorage.setItem('msmpl.theme', String(i)); } catch { /* ignore */ }
  $('#theme-btn').title = `Accent: ${t.name}`;
}
let themeIdx = (() => { try { return +localStorage.getItem('msmpl.theme') || 0; }
                       catch { return 0; } })();
applyTheme(themeIdx);
$('#theme-btn').onclick = () => applyTheme(++themeIdx);

// ── help overlay ─────────────────────────────────────────────────────────
$('#help-btn').onclick = () => $('#help-dialog').showModal();

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
  const COLS = 3, N = 36;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
  if (delta != null) {
    e.preventDefault();
    const cur = state.sel == null ? 0 : state.sel;
    const next = Math.max(0, Math.min(N - 1, cur + delta));
    if (next !== state.sel) selectSlot(next);
  }
});
