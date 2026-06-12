// 36-slot pad grid: rendering, selection, device note-play, WAV drop.
import { openUpload, uploadBatch } from './dialogs.js';
import { showSlot } from './slot.js';
import { openSlotOp } from './slotops.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, api, esc, jsonBody } from './util.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(slot) {                   // pads are C3..B5 (36 keys)
  const n = 48 + slot;                             // MIDI C3 = 48 (Korg octave)
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

export function selectSlot(i) {
  state.sel = i;
  renderPads();
  showSlot(i).then(renderPads).catch(() => { });   // light the loaded dot
}

export function renderPads() {
  const grid = $('#pad-grid');
  grid.innerHTML = '';
  let used = 0;
  state.bank.slots.forEach(s => {
    if (!s.empty) used++;
    const b = document.createElement('button');
    b.dataset.slot = s.slot;
    // "loaded" = decoded audio cached → instant audition/waveform, exact meter
    const loaded = !s.empty && state.buffers.has(s.slot);
    b.className = 'pad ' + (s.empty ? 'empty' : 'used') +
      (state.sel === s.slot ? ' sel' : '') + (loaded ? ' loaded' : '');
    b.innerHTML = `<span class="pad-num">${String(s.slot + 1).padStart(2, '0')} · ${noteName(s.slot)}</span>
                   <span class="pad-name">${s.empty ? '· · · ·' : esc(s.name)}</span>
                   <span class="pad-led"></span>` +
      (s.empty ? '' : '<span class="pad-play" title="Play on the device (hold)">▶</span>');
    b.onclick = () => selectSlot(s.slot);
    if (!s.empty) {                              // used pads drag → copy/swap
      b.draggable = true;
      b.addEventListener('dragstart', e =>
        e.dataTransfer.setData('application/x-msmpl-slot', String(s.slot)));
    }
    grid.append(b);
  });
  $('#count-used').textContent = used;
  applyPadFilter();                                // re-apply any active filter
}

// dim pads whose name doesn't match the filter box (keeps the fixed 3-col note
// grid intact rather than hiding/reflowing pads)
function applyPadFilter() {
  const q = ($('#pad-search').value || '').trim().toLowerCase();
  for (const b of $('#pad-grid').children) {
    const name = (b.querySelector('.pad-name').textContent || '').toLowerCase();
    const match = !q || (!b.classList.contains('empty') && name.includes(q));
    b.classList.toggle('dimmed', !!q && !match);
  }
}
$('#pad-search').addEventListener('input', applyPadFilter);

// play pads THROUGH THE DEVICE: hold the ▶ corner of a pad → MIDI note
// on/off via the bridge (note 48+slot on the global channel — the same
// sample-mode numbering patterns use). The device plays the sample with
// its real envelope/FX, unlike the browser-side audition.
{
  const grid = $('#pad-grid');
  let down = null;                       // slot currently sounding
  const noteOff = () => {
    if (down == null) return;
    const slot = down;
    down = null;
    api('/api/note', jsonBody({ slot, on: false })).catch(() => { });
  };
  grid.addEventListener('pointerdown', e => {
    const play = e.target.closest('.pad-play');
    if (!play) return;
    e.preventDefault();
    e.stopPropagation();                 // don't select the pad
    const slot = +play.closest('.pad').dataset.slot;
    down = slot;
    play.closest('.pad').classList.add('sounding');
    api('/api/note', jsonBody({ slot, on: true, velocity: 100 }))
      .catch(err => tick(`⚠ note failed: ${err.message}`));
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    window.addEventListener(ev, () => {
      grid.querySelectorAll('.pad.sounding').forEach(p =>
        p.classList.remove('sounding'));
      noteOff();
    });
  }
  // a click on ▶ must not bubble into the pad's select handler
  grid.addEventListener('click', e => {
    if (e.target.closest('.pad-play')) e.stopPropagation();
  }, true);
}

// drag & drop a WAV straight onto a pad — selects that slot and opens the
// upload dialog pre-filled with the file (works for used AND empty pads)
{
  const grid = $('#pad-grid');
  const hint = pad => {
    for (const p of grid.querySelectorAll('.pad.drop-hint'))
      if (p !== pad) p.classList.remove('drop-hint');
    if (pad) pad.classList.add('drop-hint');
  };
  grid.addEventListener('dragover', e => {
    const pad = e.target.closest('.pad');
    if (!pad) return;
    e.preventDefault();
    e.stopPropagation();                 // keep the editor's drop veil out
    hint(pad);
  });
  grid.addEventListener('dragleave', e => {
    if (!grid.contains(e.relatedTarget)) hint(null);
  });
  grid.addEventListener('drop', e => {
    e.preventDefault();
    hint(null);
    const pad = e.target.closest('.pad');
    if (!pad) return;
    const slot = +pad.dataset.slot;
    // pad-to-pad drag → copy/swap dialog (internal drag, no files)
    const from = e.dataTransfer.getData('application/x-msmpl-slot');
    if (from !== '' && +from !== slot) return openSlotOp(+from, slot);
    // file drop → upload to this pad; many WAVs → fill consecutive pads from here
    const wavs = [...e.dataTransfer.files].filter(f => /\.wav$/i.test(f.name));
    if (!wavs.length) return;
    if (wavs.length > 1) return uploadBatch(slot, wavs);
    state.sel = slot;
    renderPads();
    showSlot(slot);                      // no await — dialog opens right away
    openUpload(wavs[0]);
  });
}
