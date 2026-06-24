// Slot editor header: name LCD, info chips, start/end readout, control init.
import { fmtLevel, fmtPan, setFader, setSeg, setSwitch, tuneDisplay }
  from './controls.js';
import { noteName } from './notes.js';
import { slotData, state } from './state.js';
import { tick } from './ticker.js';
import { $, apiJson, fmtSigned, jsonBody } from './util.js';
import { loadWave } from './waveform.js';

export async function showSlot(i, { keepWave = false } = {}) {
  const s = slotData(i);
  $('#editor-empty').hidden = true;
  $('#editor-body').hidden = false;
  $('#sel-slot').textContent = noteName(i);
  $('#sel-name').textContent = s.empty ? '--------' : s.name.padEnd(8);
  $('#sel-long').textContent = s.empty ? 'EMPTY SLOT' : (s.long_name || '');
  $('#download-btn').href = `/api/sample/${i}.wav`;
  $('#download-btn').style.visibility = s.empty ? 'hidden' : 'visible';
  $('#audition-btn').style.visibility = s.empty ? 'hidden' : 'visible';
  $('#rename-btn').style.visibility = s.empty ? 'hidden' : 'visible';
  $('#clear-btn').style.visibility = s.empty ? 'hidden' : 'visible';

  renderChips(s);

  // controls — fully initialised from the bank blob (flags8 decoded
  // 2026-06-08: bit7=loop, bits5-6=bpm sync, bit4=reverse, bit3=fx sw)
  setSwitch('#ctl-loop', '#val-loop', !s.empty && !!s.loop);
  setSwitch('#ctl-reverse', '#val-reverse', !s.empty && !!s.reverse);
  setSeg(s.empty ? 0 : (s.bpm_sync ?? 0));
  setFader('#ctl-decay', '#val-decay', s.empty ? 127 : s.decay);
  setFader('#ctl-release', '#val-release', s.empty ? 0 : s.release);
  setFader('#ctl-tune', '#val-tune', s.empty ? 64 : (s.tune ?? 64), tuneDisplay);
  setFader('#ctl-level', '#val-level', s.empty ? 101 : s.level, fmtLevel);
  setFader('#ctl-pan', '#val-pan', s.empty ? 64 : s.pan, fmtPan);
  setFader('#ctl-semitone', '#val-semitone', s.empty ? 0 : (s.semitone ?? 0), fmtSigned);
  setFader('#ctl-velo', '#val-velo', s.empty ? 0 : (s.velo_int ?? 0), fmtSigned);
  setSwitch('#ctl-fx', '#val-fx', !s.empty && s.fx_sw);

  // start/end points — editable by dragging the S/E flags on the waveform
  renderPoints(s);
  if (!s.empty) renderMetaFmt(s);
  else $('#meta-fmt').textContent = '';

  // waveform
  if (!keepWave) await loadWave(i);
}

// Rate/length aren't in the bank blob — they arrive once the WAV is fetched
// (reading headers per slot would strand the device's sample-select state).
export function renderPoints(s) {
  const ro = $('#ro-row');
  if (s.empty) { ro.innerHTML = ''; $('#meta-points').textContent = ''; return; }
  // editable START/END (device frames) — committed by waveform.js. Build the
  // inputs once, then only update their values, so a drag redraw doesn't churn
  // the DOM or stomp a field the user is typing in.
  let si = ro.querySelector('[data-point="start"]');
  if (!si) {
    ro.innerHTML =
      `<label class="ro">START <input class="ro-input" type="number" data-point="start" min="0" step="1"></label>
       <label class="ro">END <input class="ro-input" type="number" data-point="end" min="0" step="1"></label>`;
    si = ro.querySelector('[data-point="start"]');
  }
  const ei = ro.querySelector('[data-point="end"]');
  const max = (s.frames || 2) - 2;
  si.max = ei.max = max;
  // not editable until the WAV (hence the frame count) has loaded — committing a
  // point against an unknown length clamps to a 1-frame region (corrupts the
  // sample on the device). loadWave() re-renders to re-enable once frames known.
  si.disabled = ei.disabled = !s.frames;
  if (document.activeElement !== si) si.value = s.start;
  if (document.activeElement !== ei) ei.value = s.end;
  $('#meta-points').textContent =
    `START ${s.start.toLocaleString()} · END ${s.end.toLocaleString()}`;
}

export function renderChips(s) {
  const chips = $('#info-chips');
  chips.innerHTML = '';
  if (s.empty) return;
  const pairs = [];
  if (s.rate_hz) {
    pairs.push(['RATE', `${s.rate_hz / 1000}k`], ['CH', s.stereo ? 'ST' : 'MONO'],
               ['LEN', `${s.seconds >= 10 ? s.seconds.toFixed(1) : s.seconds.toFixed(2)}s`]);
  } else {
    pairs.push(['RATE', '—'], ['LEN', '—']);
  }
  for (const [k, v] of pairs)
    chips.insertAdjacentHTML('beforeend', `<span class="chip">${k} <b>${v}</b></span>`);
  // ORIG BPM is editable — a clickable chip opens the dialog (it re-uploads)
  if (s.tempo_bpm)
    chips.insertAdjacentHTML('beforeend',
      `<button class="chip chip-btn" id="chip-bpm"
         title="Original BPM (sample tempo) — click to edit">BPM <b>${s.tempo_bpm.toFixed(1)}</b></button>`);
}

// ORIG BPM lives only in the sample's upload header, so there is no live command —
// applying re-uploads the sample (audio + all other params preserved). A dialog
// (like the bank name/BPM editor) makes the value + decimals legible and the
// re-upload deliberate.
$('#info-chips').addEventListener('click', e => {
  if (!e.target.closest('#chip-bpm') || state.sel == null) return;
  const s = slotData(state.sel);
  if (s.empty || !s.tempo_bpm) return;
  $('#td-bpm').value = s.tempo_bpm.toFixed(1);
  $('#tempo-dialog').showModal();
});
$('#td-ok').onclick = async e => {
  e.preventDefault();
  if (state.sel == null) return;
  const i = state.sel, s = slotData(i);
  const bpm = Math.max(20, Math.min(300, +$('#td-bpm').value || 0));
  if (!bpm || Math.abs(bpm - (s.tempo_bpm || 0)) < 0.05) { $('#tempo-dialog').close(); return; }
  $('#td-ok').setAttribute('aria-busy', 'true');     // dims APPLY while the re-upload runs
  tick(`→ ${noteName(i)} rewriting sample (ORIG BPM ${bpm.toFixed(1)})…`);
  try {
    const r = await apiJson(`/api/sample/${i}/tempo`, jsonBody({ bpm }));
    s.tempo_bpm = r.tempo_bpm;
    if (state.sel === i) renderChips(s);
    tick(`→ ${noteName(i)} ORIG BPM = ${r.tempo_bpm.toFixed(1)}`);
    $('#tempo-dialog').close();
  } catch (err) {
    tick(`⚠ ORIG BPM failed: ${err.message}`);
  } finally {
    $('#td-ok').removeAttribute('aria-busy');
  }
};

export function renderMetaFmt(s) {
  $('#meta-fmt').textContent = s.frames
    ? `${s.frames.toLocaleString()} FRAMES · 16-BIT ${s.stereo ? 'STEREO' : 'MONO'}`
    : 'CLICK ▶ PLAY OR WAIT FOR THE WAVEFORM TO LOAD FORMAT DETAILS';
}
