// Device memory meters (SMPL/PTRN bars under the pad grid).
// Device storage accounting (RE'd from SampleSet/SequenceSet::
// getFreeStorageSize): sample pool 0xEA0000 (14.6 MB), each sample occupies
// frames×channels×2 rounded UP to 32 KB blocks; pattern pool 0x60000 (384 KB),
// per-pattern usage = bank-blob seq_lengths[i] × 0x200. All samples are
// preloaded on connect (loadAllSamples), so sizes are ALWAYS REAL — no
// estimation: an as-yet-unloaded slot just counts 0 until its WAV arrives.
import { renderPads } from 'components/pads/pads.js';
import { loadSampleAudio } from 'components/sample-editor/sampleLoad.js';
import { renderChips } from 'components/sample-editor/slot.js';
import { state } from 'functions/state.js';
import { tick } from 'functions/ticker.js';
import { $ } from 'functions/util.js';

export const MEM_SMPL_TOTAL = 0xEA0000;
export const MEM_PTRN_TOTAL = 0x60000;
const MEM_BLK = 0x8000;
export const memBlk = b => Math.ceil(b / MEM_BLK) * MEM_BLK;

// device bytes a slot occupies — exact (frames + channels come from the loaded
// WAV); 0 for empty or not-yet-loaded slots (loaded momentarily by preload).
export function slotDevBytes(s) {
  if (s.empty || !s.frames || s.stereo == null) return 0;
  return memBlk(s.frames * (s.stereo ? 2 : 1) * 2);
}

export function sampleMemUsage() {
  let used = 0;
  for (const s of state.bank.slots) used += slotDevBytes(s);
  return used;
}

export function renderMeter() {
  if (!state.bank) return;
  $('#mem-block').hidden = false;
  // empty/unrecorded patterns store 0xFF in the seq-length byte (init fill),
  // NOT a real 255-block length — treat it as 0 (else 16×255×0x200 ≈ 2 MB,
  // which can't even fit the 384 KB pool).
  const ptrn = (state.bank.seq_lengths || [])
    .reduce((a, b) => a + (b === 0xFF ? 0 : b) * 0x200, 0);
  setMeter('smpl', sampleMemUsage(), MEM_SMPL_TOTAL);
  setMeter('ptrn', ptrn, MEM_PTRN_TOTAL);
}

function setMeter(which, used, total) {
  const pct = Math.min(100, 100 * used / total);
  const fill = $(`#mem-${which}-fill`);
  fill.style.width = pct.toFixed(1) + '%';
  fill.classList.toggle('warn', pct > 85 && pct < 98);
  fill.classList.toggle('crit', pct >= 98);
  $(`#mem-${which}-val`).textContent = `${fmtMem(used)}/${fmtMem(total)}`;
}
export const fmtMem = b => b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB'
  : `${Math.round(b / 1024)}KB`;

// Download + decode every not-yet-loaded sample, so the meter is exact and pad
// clicks / auditions / hardware-follow are instant (no per-select transfer).
// Runs automatically on connect (app.js); shows a prominent progress bar. Full
// downloads (the session-safe path) — never the header-only scan that wedged.
let loadingAll = false;
export async function loadAllSamples() {
  if (loadingAll || !state.bank) return;
  const todo = state.bank.slots.filter(s => !s.empty && !state.buffers.has(s.slot));
  if (!todo.length) return;
  loadingAll = true;
  const bar = $('#preload'), fill = $('#preload-fill'), txt = $('#preload-txt');
  bar.hidden = false;
  let done = 0;
  const show = () => {
    fill.style.width = `${Math.round(100 * done / todo.length)}%`;
    txt.textContent = `LOADING SAMPLES ${done} / ${todo.length}`;
  };
  show();
  let failed = 0;
  for (const s of todo) {
    try {                                        // per-slot: one bad download
      await loadSampleAudio(s.slot);             // must not abort the rest
      renderMeter();
      renderPads();                              // light the loaded indicator
      if (state.sel === s.slot) renderChips(s);
    } catch { failed++; }
    done++;
    show();
  }
  tick(failed
    ? `⚠ loaded ${done - failed}/${todo.length} samples (${failed} failed — RECEIVE retries)`
    : `▦ loaded ${done} sample${done === 1 ? '' : 's'}`);
  bar.hidden = true;
  loadingAll = false;
}
