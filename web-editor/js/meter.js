// Device memory meters (SMPL/PTRN bars under the pad grid).
// Device storage accounting (RE'd from SampleSet/SequenceSet::
// getFreeStorageSize): sample pool 0xEA0000 (14.6 MB), each sample occupies
// frames×channels×2 rounded UP to 32 KB blocks; pattern pool 0x60000
// (384 KB), per-pattern usage = bank-blob seq_lengths[i] × 0x200 (the
// 0x800-block-rounded size). Sample sizes are exact once a slot's WAV has
// been seen (frames+channels known); otherwise estimated from the END point
// assuming stereo, flagged "≈" with a MEASURE button to fetch the rest.
import { $ } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { renderChips } from './slot.js';
import { loadSampleAudio } from './sampleLoad.js';
import { renderPads } from './pads.js';

export const MEM_SMPL_TOTAL = 0xEA0000;
export const MEM_PTRN_TOTAL = 0x60000;
const MEM_BLK = 0x8000;
export const memBlk = b => Math.ceil(b / MEM_BLK) * MEM_BLK;

// device bytes a slot occupies: exact once frames+channels are known,
// estimated from the END point (assume stereo) otherwise
export function slotDevBytes(s) {
  if (s.empty) return { bytes: 0, est: false };
  if (s.frames && s.stereo != null)
    return { bytes: memBlk(s.frames * (s.stereo ? 2 : 1) * 2), est: false };
  return { bytes: memBlk((s.end + 2) * 2 * 2), est: true };
}

export function sampleMemUsage() {
  let used = 0, est = false;
  for (const s of state.bank.slots) {
    const u = slotDevBytes(s);
    used += u.bytes;
    est = est || u.est;
  }
  return { used, est };
}

export function renderMeter() {
  if (!state.bank) return;
  $('#mem-block').hidden = false;
  const { used, est } = sampleMemUsage();
  const ptrn = (state.bank.seq_lengths || [])
    .reduce((a, b) => a + b * 0x200, 0);
  setMeter('smpl', used, MEM_SMPL_TOTAL, est);
  setMeter('ptrn', ptrn, MEM_PTRN_TOTAL, false);
  $('#mem-note').hidden = !est;
  $('#mem-measure').hidden = !est;
}

function setMeter(which, used, total, est) {
  const pct = Math.min(100, 100 * used / total);
  const fill = $(`#mem-${which}-fill`);
  fill.style.width = pct.toFixed(1) + '%';
  fill.classList.toggle('warn', pct > 85 && pct < 98);
  fill.classList.toggle('crit', pct >= 98);
  $(`#mem-${which}-val`).textContent =
    `${est ? '≈' : ''}${fmtMem(used)}/${fmtMem(total)}`;
}
export const fmtMem = b => b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB'
  : `${Math.round(b / 1024)}KB`;

// LOAD ALL: download + decode every not-yet-loaded sample. Makes the meter
// exact AND caches the audio so subsequent pad clicks/auditions are instant.
// Shows a determinate progress bar + count (n/total) on the button.
$('#mem-measure').onclick = async () => {
  const btn = $('#mem-measure');
  const todo = state.bank.slots.filter(s => !s.empty && !state.buffers.has(s.slot));
  if (!todo.length) return;
  btn.disabled = true;
  btn.classList.add('loading');
  let done = 0;
  const show = () => {
    btn.style.setProperty('--p', `${Math.round(100 * done / todo.length)}%`);
    btn.textContent = `LOADING ${done}/${todo.length}`;
  };
  show();
  try {
    for (const s of todo) {
      await loadSampleAudio(s.slot);
      done++;
      show();
      renderMeter();
      renderPads();                              // light the loaded indicator
      if (state.sel === s.slot) renderChips(s);
    }
    tick(`▦ loaded ${done} sample${done === 1 ? '' : 's'}`);
  } catch (e) { tick(`⚠ load failed: ${e.message}`); }
  btn.classList.remove('loading');
  btn.style.removeProperty('--p');
  btn.textContent = 'LOAD ALL';
  btn.disabled = false;
};
