// 36-slot pad grid: rendering, selection, device note-play, WAV drop.
import { $, esc, api } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { showSlot } from './slot.js';
import { openUpload } from './dialogs.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(slot) {                   // pads are C3..B5 (36 keys)
  const n = 48 + slot;                             // MIDI C3 = 48 (Korg octave)
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

export function renderPads() {
  const grid = $('#pad-grid');
  grid.innerHTML = '';
  let used = 0;
  state.bank.slots.forEach(s => {
    if (!s.empty) used++;
    const b = document.createElement('button');
    b.dataset.slot = s.slot;
    b.className = 'pad ' + (s.empty ? 'empty' : 'used') + (state.sel === s.slot ? ' sel' : '');
    b.innerHTML = `<span class="pad-num">${String(s.slot + 1).padStart(2, '0')} · ${noteName(s.slot)}</span>
                   <span class="pad-name">${s.empty ? '· · · ·' : esc(s.name)}</span>
                   <span class="pad-led"></span>` +
      (s.empty ? '' : '<span class="pad-play" title="Play on the device (hold)">▶</span>');
    b.onclick = () => { state.sel = s.slot; renderPads(); showSlot(s.slot); };
    grid.append(b);
  });
  $('#count-used').textContent = used;
}

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
    api('/api/note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, on: false }),
    }).catch(() => { });
  };
  grid.addEventListener('pointerdown', e => {
    const play = e.target.closest('.pad-play');
    if (!play) return;
    e.preventDefault();
    e.stopPropagation();                 // don't select the pad
    const slot = +play.closest('.pad').dataset.slot;
    down = slot;
    play.closest('.pad').classList.add('sounding');
    api('/api/note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, on: true, velocity: 100 }),
    }).catch(err => tick(`⚠ note failed: ${err.message}`));
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
    const f = [...e.dataTransfer.files].find(f => /\.wav$/i.test(f.name));
    if (!f) return;
    const slot = +pad.dataset.slot;
    state.sel = slot;
    renderPads();
    showSlot(slot);                      // no await — dialog opens right away
    openUpload(f);
  });
}
