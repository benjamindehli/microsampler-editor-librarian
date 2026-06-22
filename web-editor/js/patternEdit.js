// Pattern editor: an in-app piano-roll for the device's two pattern tracks —
// sample-mode (note number triggers a pad) and keyboard-mode (one assigned
// sample played chromatically). Edits a copy of the read-model note list, then
// saves by writing an SMF (smfWrite) to the existing, hardware-proven
// POST /api/pattern/N → smf_to_pattern → pattern_write path. No SEQP is built in
// the browser.
import { noteName } from './notes.js';
import { notesToSmf } from './smfWrite.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, api, apiJson, jsonBody } from './util.js';

const TPB = 384;                 // ticks per 4/4 bar (96/quarter)
const LO = 36, HI = 96;          // visible MIDI-note range (rows, high note on top)
const ROWS = HI - LO + 1;
const ROWH = 14;                 // px per note row
const PAD_LO = 48, PAD_HI = 83;  // sample-mode notes map to pads 0..35 (note−48)
const BLACK = new Set([1, 3, 6, 8, 10]);

let cur = null;                  // { pattern, notes:[{start,dur,note,vel,track}], bars, sample, name, track, sel, origSmf, dirty }
let drag = null;                 // { mode:'move'|'resize', idx, grabTick, origStart, origDur }
let pePlaying = false;           // previewing on the device (transport running)

const total = () => cur.bars * TPB;
const snap = () => +$('#pe-grid').value;          // grid step in ticks; 0 = OFF (free placement)
const step = () => snap() || 1;                   // snapping granularity (1 tick ⇒ effectively free)
const midiLabel = n => noteName(n - 48);             // MIDI note → 'C4' etc.
const rowTop = n => (HI - n) * ROWH;
const noteAtY = y => Math.max(LO, Math.min(HI, HI - Math.floor(y / ROWH)));
const trackRange = t => (t === 0 ? [PAD_LO, PAD_HI] : [LO, HI]);
const clampNote = (n, t) => { const [a, b] = trackRange(t); return Math.max(a, Math.min(b, n)); };

function tickAtX(roll, clientX) {
  const r = roll.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const s = step();
  return Math.max(0, Math.min(total() - s, Math.round(frac * total() / s) * s));
}

// ── render ───────────────────────────────────────────────────────────────────
function buildGutter() {
  const g = $('#pe-gutter');
  g.style.height = ROWS * ROWH + 'px';
  g.innerHTML = '';
  for (let n = HI; n >= LO; n--) {
    const d = document.createElement('div');
    d.className = 'pe-key' + (BLACK.has(n % 12) ? ' black' : '')
      + (n >= PAD_LO && n <= PAD_HI ? ' pe-pad' : '');   // not ".pad" — collides with the pad-grid rule
    d.style.top = rowTop(n) + 'px';                  // absolute, same formula as the roll
    d.style.height = ROWH + 'px';
    d.textContent = midiLabel(n);
    g.append(d);
  }
}

function renderRoll() {
  const roll = $('#pe-roll');
  roll.style.height = ROWS * ROWH + 'px';
  const tot = total();
  let html = '';
  for (let b = 0; b <= cur.bars; b++)                 // bar lines
    html += `<div class="pe-bar" style="left:${b / cur.bars * 100}%"></div>`;
  for (let n = LO; n <= HI; n++)                       // black-key row shading
    if (BLACK.has(n % 12))
      html += `<div class="pe-rowbg" style="top:${rowTop(n)}px;height:${ROWH}px"></div>`;
  cur.notes.forEach((nt, i) => {
    if (nt.start >= tot) return;
    const w = nt.dur / tot * 100;                 // actual length — independent of the grid setting
    html += `<div class="pe-note ${nt.track ? 'kbd' : 'smp'}${i === cur.sel ? ' sel' : ''}"
        data-i="${i}" title="${midiLabel(nt.note)} · vel ${nt.vel}"
        style="left:${nt.start / tot * 100}%;width:${w}%;top:${rowTop(nt.note) + 1}px;height:${ROWH - 2}px">
        <span class="pe-resize"></span></div>`;
  });
  roll.innerHTML = html;
}

function setVelUI() {
  const v = cur.sel != null ? cur.notes[cur.sel].vel : +$('#pe-vel').value;
  $('#pe-vel').value = v;
  $('#pe-vel-val').textContent = v;
}

// ── interactions ──────────────────────────────────────────────────────────────
function onPointerDown(e) {
  const roll = $('#pe-roll');
  const noteEl = e.target.closest('.pe-note');
  if (noteEl) {
    const i = +noteEl.dataset.i;
    cur.sel = i;
    const resize = e.target.classList.contains('pe-resize');
    drag = { mode: resize ? 'resize' : 'move', idx: i, grabTick: tickAtX(roll, e.clientX),
             origStart: cur.notes[i].start, origDur: cur.notes[i].dur };
    roll.setPointerCapture(e.pointerId);
  } else {                                            // empty grid → add a note
    const r = roll.getBoundingClientRect();
    const nt = { start: tickAtX(roll, e.clientX), dur: snap() || 24,   // one grid cell (1/16 when off)
                 note: clampNote(noteAtY(e.clientY - r.top), cur.track),
                 vel: +$('#pe-vel').value, track: cur.track };
    cur.notes.push(nt);
    cur.sel = cur.notes.length - 1;
    drag = { mode: 'move', idx: cur.sel, grabTick: nt.start, origStart: nt.start, origDur: nt.dur };
    roll.setPointerCapture(e.pointerId);
  }
  setVelUI();
  renderRoll();
}

function onPointerMove(e) {
  if (!drag) return;
  const roll = $('#pe-roll');
  const nt = cur.notes[drag.idx];
  const t = tickAtX(roll, e.clientX);
  const s = step();
  if (drag.mode === 'resize') {
    nt.dur = Math.max(s, Math.round((t - nt.start) / s) * s);
  } else {
    const r = roll.getBoundingClientRect();
    nt.start = Math.max(0, Math.min(total() - s, drag.origStart + (t - drag.grabTick)));
    nt.note = clampNote(noteAtY(e.clientY - r.top), nt.track);
  }
  renderRoll();
}

function onPointerUp() { drag = null; }

function onWheel(e) {                                 // scroll over a note → velocity
  const noteEl = e.target.closest('.pe-note');
  if (!noteEl) return;
  e.preventDefault();
  const nt = cur.notes[+noteEl.dataset.i];
  nt.vel = Math.max(1, Math.min(127, nt.vel + (e.deltaY < 0 ? 4 : -4)));
  cur.sel = +noteEl.dataset.i;
  setVelUI(); renderRoll();
}

function onKey(e) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && cur.sel != null) {
    e.preventDefault();
    cur.notes.splice(cur.sel, 1);
    cur.sel = null;
    setVelUI(); renderRoll();
  }
}

// ── open / save ────────────────────────────────────────────────────────────────
function fillSampleSelect() {
  const sel = $('#pe-sample');
  const opts = ['<option value="">— none —</option>'];
  const slots = (state.bank && state.bank.slots) || [];
  for (let i = 0; i < 36; i++) {
    const s = slots[i];
    const label = s && !s.empty ? s.name : '· · · ·';
    opts.push(`<option value="${i}">${String(i + 1).padStart(2, '0')} · ${midiLabel(48 + i)} · ${label}</option>`);
  }
  sel.innerHTML = opts.join('');
}

export function openPatternEditor(p) {
  cur = {
    pattern: p.pattern,
    notes: (p.notes || []).map(([start, track, note, vel, dur]) =>
      ({ start, track: track ? 1 : 0, note, vel, dur: Math.max(1, dur) })),
    bars: Math.max(1, Math.min(99, p.bars || 1)),
    sample: p.sample == null ? null : p.sample,
    name: p.name || 'PATTERN',
    track: 0, sel: null,
  };
  $('#pe-title').textContent = `EDIT P${String(p.pattern + 1).padStart(2, '0')}`;
  $('#pe-name').value = cur.name;
  $('#pe-bars').value = cur.bars;
  fillSampleSelect();
  $('#pe-sample').value = cur.sample == null ? '' : String(cur.sample);
  setTrack(0);
  buildGutter();
  renderRoll();
  setVelUI();
  cur.origSmf = buildSmf();         // pristine slot, for restore-on-cancel
  cur.dirty = false;
  pePlaying = false; setPlayBtn();
  $('#pattern-editor').showModal();
  // start scrolled to the pad range (around C4)
  $('#pe-roll-wrap').scrollTop = rowTop(PAD_HI) - 40;
}

function setTrack(t) {
  cur.track = t;
  $('#pe-track-smp').classList.toggle('on', t === 0);
  $('#pe-track-kbd').classList.toggle('on', t === 1);
}

const pNum = () => `P${String(cur.pattern + 1).padStart(2, '0')}`;

// serialise the current edit to an SMF (the proven save format)
function buildSmf() {
  const tot = total();
  const notes = cur.notes
    .filter(n => n.start < tot)
    .map(n => ({ ...n, dur: Math.min(n.dur, tot - n.start) }));
  return notesToSmf(notes, { bars: cur.bars, sample: cur.sample, name: cur.name });
}
// returns the updated pattern JSON (bridge pattern_write → _pattern_json), which
// the PATTERNS view uses to refresh just this card — no full 16-pattern re-receive
const writePattern = smf => apiJson(`/api/pattern/${cur.pattern}`, { method: 'POST', body: smf });
const announce = p => dispatchEvent(new CustomEvent('msmpl-pattern-changed', { detail: p }));

function setPlayBtn() {
  $('#pe-play').classList.toggle('playing', pePlaying);
  $('#pe-play-cap').textContent = pePlaying ? '■ STOP' : '▶ PLAY';
}
async function stopPreview() {
  if (!pePlaying) return;
  pePlaying = false; setPlayBtn();
  try { await api('/api/transport/stop', { method: 'POST' }); } catch { /* ignore */ }
}

// PLAY: the device can only play patterns it holds, so previewing writes the edit
// to its (RAM) slot first, then plays it. CANCEL restores the slot — so this stays
// non-destructive until you SAVE.
async function preview() {
  if (pePlaying) { stopPreview(); return; }
  try {
    await writePattern(buildSmf());
    cur.dirty = true;
    await api(`/api/pattern/${cur.pattern}/play`,
              jsonBody({ bpm: (state.bank && state.bank.bpm) || 120 }));
    pePlaying = true; setPlayBtn();
    tick(`▶ preview ${pNum()}`);
  } catch (err) {
    pePlaying = false; setPlayBtn();
    tick(`⚠ preview: ${err.message}`);
  }
}

async function closeEditor() {
  await stopPreview();
  $('#pattern-editor').close();
}

async function save() {
  const btn = $('#pe-save');
  btn.disabled = true;
  try {
    announce(await writePattern(buildSmf()));        // refresh just this card
    cur.dirty = false;
    tick(`✓ pattern ${pNum()} saved`);
    await closeEditor();
  } catch (err) {
    tick(`⚠ pattern save failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// discard edits; if a preview wrote to the device, restore the slot to how it was
async function cancel() {
  if (cur.dirty) { try { announce(await writePattern(cur.origSmf)); } catch { /* ignore */ } }
  await closeEditor();
}

// ── wiring ──────────────────────────────────────────────────────────────────
{
  const roll = $('#pe-roll');
  roll.addEventListener('pointerdown', onPointerDown);
  roll.addEventListener('pointermove', onPointerMove);
  for (const ev of ['pointerup', 'pointercancel']) roll.addEventListener(ev, onPointerUp);
  roll.addEventListener('wheel', onWheel, { passive: false });
  $('#pattern-editor').addEventListener('keydown', onKey);
  $('#pe-track-smp').onclick = () => setTrack(0);
  $('#pe-track-kbd').onclick = () => setTrack(1);
  $('#pe-grid').onchange = renderRoll;
  $('#pe-bars').onchange = () => {
    cur.bars = Math.max(1, Math.min(99, +$('#pe-bars').value || 1));
    $('#pe-bars').value = cur.bars;
    renderRoll();
  };
  $('#pe-name').oninput = () => { cur.name = $('#pe-name').value.slice(0, 8); };
  $('#pe-sample').onchange = () => {
    const v = $('#pe-sample').value;
    cur.sample = v === '' ? null : +v;
  };
  $('#pe-vel').oninput = () => {
    const v = +$('#pe-vel').value;
    $('#pe-vel-val').textContent = v;
    if (cur.sel != null) { cur.notes[cur.sel].vel = v; renderRoll(); }
  };
  $('#pe-play').onclick = () => { preview(); };
  $('#pe-cancel').onclick = () => { cancel(); };
  $('#pe-save').onclick = () => { save(); };
  // Esc → treat as cancel (stop preview + restore the slot if a preview wrote to it)
  $('#pattern-editor').addEventListener('cancel', e => { e.preventDefault(); cancel(); });
}
