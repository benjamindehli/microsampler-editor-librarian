// Device memory meters (SMPL/PTRN bars under the pad grid).
// Device storage accounting (RE'd from SampleSet/SequenceSet::
// getFreeStorageSize): sample pool 0xEA0000 (14.6 MB), each sample occupies
// frames×channels×2 rounded UP to 32 KB blocks; pattern pool 0x60000
// (384 KB), per-pattern usage = bank-blob seq_lengths[i] × 0x200 (the
// 0x800-block-rounded size). Sample sizes are exact once a slot's WAV has
// been seen (frames+channels known); otherwise estimated from the END point
// assuming stereo, flagged "≈" with a MEASURE button to fetch the rest.
import { $, api, wavFormat } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { renderChips } from './slot.js';

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

$('#mem-measure').onclick = async () => {
  const btn = $('#mem-measure');
  btn.disabled = true;
  try {
    for (const s of state.bank.slots) {
      if (s.empty || (s.frames && s.stereo != null)) continue;
      btn.textContent = `READING ${String(s.slot + 1).padStart(2, '0')}…`;
      const wav = await (await api(`/api/sample/${s.slot}.wav`)).arrayBuffer();
      const fmt = wavFormat(wav.slice(0, 44));
      if (fmt) {
        s.rate_hz = fmt.rate;
        s.stereo = fmt.channels === 2;
        s.frames = Math.floor((wav.byteLength - 44) / (fmt.channels * 2));
        s.seconds = s.frames / fmt.rate;
      }
      renderMeter();
      if (state.sel === s.slot) renderChips(s);
    }
    tick('▦ memory measured');
  } catch (e) { tick(`⚠ measure failed: ${e.message}`); }
  btn.textContent = 'MEASURE';
  btn.disabled = false;
};
