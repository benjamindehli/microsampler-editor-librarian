// Auto-slice: chop one decoded sample into several pads. Opened from the upload
// dialog's SLICE… button with the (already tool-processed) decoded buffer. Two
// modes — equal-length pieces, or detected transients (audioTools.sliceBuffer)
// — then each slice is encoded to a WAV and uploaded to consecutive slots via
// the same raw /api/sample/N path uploadBatch uses.
import { refreshBank } from 'app.js';
import { loadAllSamples } from 'components/meter/meter.js';
import { forgetSample } from 'components/sample-editor/sampleLoad.js';
import { showSlot } from 'components/sample-editor/slot.js';
import { encodeWav, sliceBuffer } from 'functions/audioTools.js';
import { state } from 'functions/state.js';
import { tick } from 'functions/ticker.js';
import { $, api } from 'functions/util.js';

let cur = null;            // { buf:{channels,rate}, base, startSlot }

// 8-char device name for slice n: base (≤6) + 2-digit index.
const sliceName = (base, n) =>
  ((base || 'SLICE').replace(/\s+/g, '').slice(0, 6) + String(n).padStart(2, '0'));

function readSpec() {
  const mode = $('#slice-dialog').querySelector('input[name="sl-mode"]:checked').value;
  return mode === 'transient'
    ? { mode: 'transient', sensitivity: (+$('#sl-sens').value || 0) / 100 }
    : { mode: 'equal', count: Math.max(1, +$('#sl-count').value || 1) };
}

// run the slicer and report how many pads it would fill (clamped to 36)
function preview() {
  if (!cur) return [];
  const segs = sliceBuffer(cur.buf, readSpec());
  const avail = 36 - cur.startSlot;
  const fit = Math.min(segs.length, avail);
  const last = cur.startSlot + fit;
  $('#sl-info').textContent =
    `${segs.length} slice${segs.length !== 1 ? 's' : ''} → PADS ${cur.startSlot + 1}–${last}`
    + (segs.length > avail ? ` (only the first ${avail} fit)` : '');
  return segs;
}

export function openSlice(buf, base, startSlot) {
  if (!buf || startSlot == null) return;
  cur = { buf, base, startSlot };
  const secs = buf.channels[0].length / buf.rate;
  $('#sl-from').textContent = `PAD ${startSlot + 1}`;
  $('#sl-src').textContent =
    `${(base || 'SAMPLE')} · ${secs.toFixed(2)} s · ${buf.channels.length === 2 ? 'stereo' : 'mono'}`;
  // default to equal mode
  $('#slice-dialog').querySelector('input[name="sl-mode"][value="equal"]').checked = true;
  $('#sl-count-row').hidden = false;
  $('#sl-sens-row').hidden = true;
  $('#sl-progress').hidden = true;
  preview();
  $('#slice-dialog').showModal();
}

async function doSlice() {
  if (!cur) return;
  const segs = sliceBuffer(cur.buf, readSpec());
  const use = segs.slice(0, 36 - cur.startSlot);
  if (!use.length) return;
  const go = $('#sl-go'); go.disabled = true;
  const bar = $('#sl-progress'); bar.hidden = false;
  const fill = bar.firstElementChild;
  let done = 0;
  for (let i = 0; i < use.length; i++) {
    const slot = cur.startSlot + i;
    const name = sliceName(cur.base, i + 1);
    try {
      await api(`/api/sample/${slot}?name=${encodeURIComponent(name)}&tempo=120`,
                { method: 'POST', body: encodeWav(use[i].channels, use[i].rate) });
      forgetSample(slot);
      done++;
      fill.style.width = `${Math.round(100 * done / use.length)}%`;
      tick(`⇧ slice ${done}/${use.length} → S${slot + 1}`);
    } catch (err) {
      tick(`⚠ slicing stopped at S${slot + 1}: ${err.message}`);
      break;
    }
  }
  go.disabled = false;
  $('#slice-dialog').close();
  await refreshBank();
  if (done) {
    state.sel = cur.startSlot; await showSlot(cur.startSlot);
    loadAllSamples().catch(() => { });             // eager-load the new slices
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────
for (const r of document.querySelectorAll('input[name="sl-mode"]'))
  r.addEventListener('change', () => {
    const transient = readSpec().mode === 'transient';
    $('#sl-count-row').hidden = transient;
    $('#sl-sens-row').hidden = !transient;
    preview();
  });
$('#sl-count').addEventListener('input', preview);
$('#sl-sens').addEventListener('input', preview);
$('#sl-go').addEventListener('click', () => { doSlice().catch(() => { }); });
