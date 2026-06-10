// LIBRARY: browse the user's own .wav folder (served by the bridge) and load a
// file onto a pad — drag it onto a pad, or click it to load the selected pad.
// Both routes reuse the normal upload dialog (audio tools, resample, etc.), so
// the file just gets fetched from the bridge and handed to openUpload().
import { openUpload } from './dialogs.js';
import { renderPads } from './pads.js';
import { showSlot } from './slot.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, apiJson, esc } from './util.js';

function fmtSize(n) {
  return n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB'
       : n >= 1 << 10 ? Math.round(n / (1 << 10)) + ' KB' : n + ' B';
}

// fetch a library file from the bridge → File → the standard upload dialog,
// pre-selecting the target pad (same flow as a desktop WAV dropped on a pad)
export async function loadLibraryToSlot(rel, slot) {
  try {
    const res = await fetch(`/api/library/${encodeURIComponent(rel)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], rel.split('/').pop(), { type: 'audio/wav' });
    state.sel = slot;
    renderPads();
    showSlot(slot);                     // no await — dialog opens right away
    openUpload(file);
  } catch (e) {
    tick('⚠ library load failed: ' + e.message);
  }
}

export async function loadLibrary() {
  const list = $('#lib-list'), hint = $('#lib-hint');
  try {
    const { items, dir } = await apiJson('/api/library');
    if (!items.length) {
      list.innerHTML = '';
      hint.textContent = `Drop .wav files in ${dir} (or run the bridge with --library DIR)`;
      return;
    }
    list.innerHTML = items.map(it =>
      `<button class="lib-item" draggable="true" data-rel="${esc(it.rel)}"
               title="${esc(it.rel)} — drag onto a pad, or click to load the selected pad">
         <span class="lib-name">${esc(it.name)}</span>
         <span class="lib-size">${fmtSize(it.size)}</span>
       </button>`).join('');
    hint.textContent = `${items.length} file${items.length === 1 ? '' : 's'} · drag onto a pad`;
  } catch (e) {
    list.innerHTML = '';
    hint.textContent = 'library unavailable: ' + e.message;
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────
$('#lib-refresh').onclick = () => loadLibrary();

// drag a library item: hand the pad-grid drop handler the relative path
$('#lib-list').addEventListener('dragstart', e => {
  const item = e.target.closest('.lib-item');
  if (!item) return;
  e.dataTransfer.setData('application/x-msmpl-libfile', item.dataset.rel);
  e.dataTransfer.effectAllowed = 'copy';
});

// click a library item: load it onto the currently-selected pad
$('#lib-list').addEventListener('click', e => {
  const item = e.target.closest('.lib-item');
  if (!item) return;
  if (state.sel == null) { tick('select a pad first, then click a library file'); return; }
  loadLibraryToSlot(item.dataset.rel, state.sel);
});
