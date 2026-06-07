// Upload + rename dialogs, incl. the upload memory pre-flight, and the
// editor-panel WAV drop target.
import { $, api, apiJson } from './util.js';
import { state, slotData } from './state.js';
import { tick } from './ticker.js';
import { noteName, renderPads } from './pads.js';
import { showSlot } from './slot.js';
import { refreshBank } from './app.js';
import { MEM_SMPL_TOTAL, memBlk, slotDevBytes, sampleMemUsage, fmtMem }
  from './meter.js';
import { forgetSample } from './sampleLoad.js';

// ────────────────────────────────────────────────────────────── upload ──
export function openUpload(file) {
  if (state.sel == null) return;
  const dlg = $('#upload-dialog');
  $('#ud-slot').textContent = `PAD ${state.sel + 1} (${noteName(state.sel)})`;
  const fileInput = $('#ud-file');
  if (file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
  } else fileInput.value = '';
  syncNameFromFile();
  $('#ud-progress').hidden = true;
  dlg.showModal();
}
function syncNameFromFile() {
  const f = $('#ud-file').files[0];
  if (f) $('#ud-name').value = f.name.replace(/\.\w+$/, '')
    .replace(/[^\x20-\x7e]/g, '').toUpperCase().slice(0, 8);
  uploadPreflight();
}
$('#ud-file').onchange = syncNameFromFile;

// minimal RIFF/WAVE chunk walk over the file head (proper fmt/data chunks —
// 44-byte assumptions break on files with LIST/INFO chunks)
function riffFormat(dv) {
  try {
    if (dv.getUint32(0) !== 0x52494646 || dv.getUint32(8) !== 0x57415645)
      return null;                               // "RIFF" … "WAVE"
    let off = 12, ch = 0, rate = 0, bits = 0, dataBytes = 0;
    while (off + 8 <= dv.byteLength) {
      const id = dv.getUint32(off), size = dv.getUint32(off + 4, true);
      if (id === 0x666d7420) {                   // "fmt "
        ch = dv.getUint16(off + 10, true);
        rate = dv.getUint32(off + 12, true);
        bits = dv.getUint16(off + 22, true);
      }
      if (id === 0x64617461) { dataBytes = size; break; }   // "data"
      off += 8 + size + (size & 1);
    }
    if (!ch || !rate || !bits) return null;
    return { channels: ch, rate, bytesPerFrame: ch * (bits >> 3), dataBytes };
  } catch { return null; }
}

// pre-flight: will this WAV fit the device's sample pool? Mirrors the
// device accounting (resample to nearest device rate, 16-bit, 32 KB blocks)
// and what replacing the target slot frees up.
async function uploadPreflight() {
  const el = $('#ud-mem');
  const ok = $('#ud-ok');
  el.hidden = true;
  el.classList.remove('over');
  ok.disabled = false;
  const f = $('#ud-file').files[0];
  if (!f || state.sel == null || !state.bank) return;
  const dv = new DataView(await f.slice(0, 64 * 1024).arrayBuffer());
  const fmt = riffFormat(dv);
  if (!fmt) return;                              // bridge will reject it anyway
  const frames = Math.floor(fmt.dataBytes / fmt.bytesPerFrame);
  const target = [48000, 24000, 12000, 6000].reduce((a, r) =>
    Math.abs(r - fmt.rate) < Math.abs(a - fmt.rate) ? r : a);
  const need = memBlk(Math.floor(frames * target / fmt.rate) * fmt.channels * 2);
  const { used, est } = sampleMemUsage();
  const freed = slotDevBytes(slotData(state.sel)).bytes;
  const free = MEM_SMPL_TOTAL - used + freed;
  el.hidden = false;
  const pre = est ? '≈' : '';
  if (need > free) {
    el.classList.add('over');
    el.textContent = `✕ WON'T FIT — needs ${fmtMem(need)}, ${pre}${fmtMem(Math.max(0, free))} free` +
      (est ? ' (estimate — MEASURE on the SAMPLES page for exact)' : '');
    ok.disabled = !est;                          // hard-block only when exact
  } else {
    el.textContent = `SMPL MEM after load: ${pre}${fmtMem(used - freed + need)}/${fmtMem(MEM_SMPL_TOTAL)}`;
  }
}
$('#upload-btn').onclick = () => openUpload(null);

$('#ud-ok').onclick = async e => {
  e.preventDefault();
  const f = $('#ud-file').files[0];
  if (!f) return;
  const name = encodeURIComponent($('#ud-name').value || 'SAMPLE');
  const tempo = +$('#ud-tempo').value || 120;
  $('#ud-progress').hidden = false;
  $('#ud-ok').setAttribute('aria-busy', 'true');
  try {
    await api(`/api/sample/${state.sel}?name=${name}&tempo=${tempo}`,
      { method: 'POST', body: await f.arrayBuffer() });
    tick(`⇧ loaded "${$('#ud-name').value}" → S${state.sel + 1}`);
    forgetSample(state.sel);                     // its content changed
    $('#upload-dialog').close();
    await refreshBank();
    await showSlot(state.sel);
  } catch (err) {
    tick(`⚠ upload failed: ${err.message}`);
    alert('Upload failed: ' + err.message);
  } finally {
    $('#ud-progress').hidden = true;
    $('#ud-ok').removeAttribute('aria-busy');
  }
};

// ────────────────────────────────────────────────────────────── rename ──
// (param-blob write: name bytes 0..7 + long name 0x20..0x3f)
$('#rename-btn').onclick = () => {
  if (state.sel == null) return;
  const s = slotData(state.sel);
  if (!s || s.empty) return;
  $('#rn-slot').textContent = `PAD ${state.sel + 1} (${noteName(state.sel)})`;
  $('#rn-name').value = s.name || '';
  $('#rn-long').value = s.long_name || '';
  $('#rename-dialog').showModal();
};
$('#rn-ok').onclick = async e => {
  e.preventDefault();
  const name = $('#rn-name').value.trim().toUpperCase().slice(0, 8);
  if (!name) return;
  const long_name = $('#rn-long').value.trim().slice(0, 32);
  $('#rn-ok').setAttribute('aria-busy', 'true');
  try {
    const res = await apiJson(`/api/sample/${state.sel}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, long_name }),
    });
    const s = slotData(state.sel);
    s.name = res.name;
    s.long_name = res.long_name;
    tick(`✎ S${state.sel + 1} renamed "${res.name}"`);
    $('#rename-dialog').close();
    renderPads();
    $('#sel-name').textContent = res.name.padEnd(8);
    $('#sel-long').textContent = res.long_name;
  } catch (err) {
    tick(`⚠ rename failed: ${err.message}`);
    alert('Rename failed: ' + err.message);
  } finally {
    $('#rn-ok').removeAttribute('aria-busy');
  }
};

// ────────────────────────────────────────────── bank name / BPM dialog ──
// Bank object = 0 (from EditBankParameterAction in the original binary):
// params 0..7 = the 8 name chars (sent one per message, space-padded),
// param 16 = BPM × 10. Targets the current bank (RAM), like all live edits.
$('#bank-lcd').onclick = () => {
  if (!state.bank) return;
  $('#bd-name').value = state.bank.name || '';
  $('#bd-bpm').value = state.bank.bpm.toFixed(1);
  $('#bank-dialog').showModal();
};
$('#bank-lcd').onkeydown = e => {
  if (e.key === 'Enter' || e.key === ' ') $('#bank-lcd').click();
};

$('#bd-ok').onclick = async e => {
  e.preventDefault();
  const name = $('#bd-name').value.trim().toUpperCase().slice(0, 8);
  const bpm = Math.max(20, Math.min(300, +$('#bd-bpm').value || 120));
  if (!name) return;
  $('#bd-ok').setAttribute('aria-busy', 'true');
  try {
    // one batched request — the bridge sends all 9 messages (8 name chars +
    // BPM) in a single device-lock acquisition; per-message /api/param
    // round-trips were user-visibly sluggish
    const res = await apiJson('/api/bank/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, bpm }),
    });
    state.bank.name = res.name;
    state.bank.bpm = res.bpm;
    $('#bank-name').textContent = res.name.padEnd(8);
    $('#bank-bpm').textContent = res.bpm.toFixed(1);
    tick(`✎ bank "${res.name}" · ${res.bpm.toFixed(1)} BPM`);
    $('#bank-dialog').close();
  } catch (err) {
    tick(`⚠ bank edit failed: ${err.message}`);
    alert('Bank edit failed: ' + err.message);
  } finally {
    $('#bd-ok').removeAttribute('aria-busy');
  }
};

// ─────────────────────────────────── drag & drop onto the editor panel ──
const editor = $('.editor');
editor.addEventListener('dragover', e => {
  if (state.sel == null) return;
  e.preventDefault();
  $('#drop-veil').hidden = false;
});
editor.addEventListener('dragleave', () => $('#drop-veil').hidden = true);
editor.addEventListener('drop', e => {
  e.preventDefault();
  $('#drop-veil').hidden = true;
  const f = [...e.dataTransfer.files].find(f => /\.wav$/i.test(f.name));
  if (f && state.sel != null) openUpload(f);
});
