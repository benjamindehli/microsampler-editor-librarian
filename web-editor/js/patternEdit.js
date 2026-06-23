// Pattern editor: an in-app piano-roll for the device's two pattern tracks —
// sample-mode (note number triggers a pad) and keyboard-mode (one assigned
// sample played chromatically). Edits a copy of the read-model note list, then
// saves by writing an SMF (smfWrite) to the existing, hardware-proven
// POST /api/pattern/N → smf_to_pattern → pattern_write path. No SEQP is built in
// the browser. Supports multi-select, copy/paste (clipboard persists across
// sessions, so it doubles as duplicate-to-another-slot) and undo/redo.
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

let cur = null;                  // { pattern, notes:[{start,dur,note,vel,track}], bars, sample, name, track, sel:Set, primary, origSmf, dirty }
let drag = null;                 // { mode:'move'|'resize', idx, grabTick, origNote, orig:Map }
let pePlaying = false;           // previewing on the device (transport running)
let clipboard = [];              // copied notes (relative to earliest start); persists across opens
let history = [], hpos = -1;     // undo/redo: a stack of full-state snapshots

const total = () => cur.bars * TPB;
const snap = () => +$('#pe-grid').value;          // grid step in ticks; 0 = OFF (free placement)
const step = () => snap() || 1;                   // snapping granularity (1 tick ⇒ effectively free)
const midiLabel = n => noteName(n - 48);             // MIDI note → 'C4' etc.
const rowTop = n => (HI - n) * ROWH;
const noteAtY = y => Math.max(LO, Math.min(HI, HI - Math.floor(y / ROWH)));
const trackRange = t => (t === 0 ? [PAD_LO, PAD_HI] : [LO, HI]);
const clampNote = (n, t) => { const [a, b] = trackRange(t); return Math.max(a, Math.min(b, n)); };
const selArr = () => [...cur.sel].filter(i => cur.notes[i]).sort((a, b) => a - b);

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

// screen-reader label for a note
const noteLabel = nt =>
  `${nt.track ? 'Keyboard' : 'Sample'} ${midiLabel(nt.note)}, bar ${Math.floor(nt.start / TPB) + 1}, velocity ${nt.vel}`;

function renderRoll() {
  const roll = $('#pe-roll');
  // the rebuild below replaces every note element, which would drop keyboard
  // focus — remember which note was focused and restore it afterwards
  const af = document.activeElement;
  const refocus = af && af.classList && af.classList.contains('pe-note') ? af.dataset.i : null;
  roll.style.height = ROWS * ROWH + 'px';
  const tot = total();
  // bar lines + black-key row shading: numeric-only markup, safe as an HTML string
  let html = '';
  for (let b = 0; b <= cur.bars; b++)
    html += `<div class="pe-bar" style="left:${b / cur.bars * 100}%"></div>`;
  for (let n = LO; n <= HI; n++)
    if (BLACK.has(n % 12))
      html += `<div class="pe-rowbg" style="top:${rowTop(n)}px;height:${ROWH}px"></div>`;
  roll.innerHTML = html;
  // notes carry text (aria-label/title) — build them with DOM APIs so the text
  // is set as data, never parsed as HTML (avoids any text-to-HTML injection path)
  cur.notes.forEach((nt, i) => {
    if (nt.start >= tot) return;
    const w = nt.dur / tot * 100;                 // actual length — independent of the grid setting
    const a = (0.4 + nt.vel / 127 * 0.6).toFixed(3);   // velocity → fill opacity
    const bg = nt.track ? `rgba(255,233,201,${a})` : `rgba(var(--amber-rgb),${a})`;
    const d = document.createElement('div');
    d.className = `pe-note ${nt.track ? 'kbd' : 'smp'}${cur.sel.has(i) ? ' sel' : ''}`;
    d.dataset.i = i;
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', noteLabel(nt));
    d.title = `${midiLabel(nt.note)} · vel ${nt.vel}`;
    d.style.cssText = `left:${nt.start / tot * 100}%;width:${w}%;top:${rowTop(nt.note) + 1}px;height:${ROWH - 2}px;background:${bg}`;
    const grip = document.createElement('span');
    grip.className = 'pe-resize';
    d.append(grip);
    roll.append(d);
  });
  if (refocus != null) roll.querySelector(`.pe-note[data-i="${refocus}"]`)?.focus();
}

function setVelUI() {
  const nt = cur.primary != null && cur.notes[cur.primary] ? cur.notes[cur.primary] : null;
  const v = nt ? nt.vel : +$('#pe-vel').value;
  $('#pe-vel').value = v;
  $('#pe-vel-val').textContent = v;
}

// ── undo / redo (full-state snapshots; dedups no-ops like a click without a move) ──
const stateStr = () => JSON.stringify({ notes: cur.notes, bars: cur.bars, sample: cur.sample, name: cur.name });
function pushHistory() {
  const s = stateStr();
  if (s === history[hpos]) return;
  history = history.slice(0, hpos + 1);
  history.push(s);
  if (history.length > 120) history.shift();
  hpos = history.length - 1;
  cur.dirty = true;
}
function restoreState(s) {
  const o = JSON.parse(s);
  cur.notes = o.notes; cur.bars = o.bars; cur.sample = o.sample; cur.name = o.name;
  cur.sel = new Set(); cur.primary = null;
  $('#pe-bars').value = cur.bars;
  $('#pe-name').value = cur.name;
  $('#pe-sample').value = cur.sample == null ? '' : String(cur.sample);
  renderRoll(); setVelUI();
  cur.dirty = true;
}
function undo() { if (hpos > 0) { hpos--; restoreState(history[hpos]); tick('undo'); } }
function redo() { if (hpos < history.length - 1) { hpos++; restoreState(history[hpos]); tick('redo'); } }

// ── selection / clipboard ──────────────────────────────────────────────────────
function selectAll() {
  cur.sel = new Set(cur.notes.map((_, i) => i));
  cur.primary = cur.notes.length ? cur.notes.length - 1 : null;
  setVelUI(); renderRoll();
}
function copySel() {
  const idxs = selArr();
  if (!idxs.length) return;
  const base = Math.min(...idxs.map(i => cur.notes[i].start));
  clipboard = idxs.map(i => {
    const n = cur.notes[i];
    return { start: n.start - base, dur: n.dur, note: n.note, vel: n.vel, track: n.track };
  });
  tick(`copied ${clipboard.length} note${clipboard.length !== 1 ? 's' : ''}`);
}
function paste() {
  if (!clipboard.length) return;
  const tot = total();
  const first = cur.notes.length;                 // pastes keep their relative timing, from tick 0
  for (const c of clipboard) {
    if (c.start >= tot) continue;
    cur.notes.push({ start: c.start, dur: Math.min(c.dur, tot - c.start),
                     note: clampNote(c.note, c.track), vel: c.vel, track: c.track });
  }
  cur.sel = new Set(cur.notes.map((_, i) => i).filter(i => i >= first));
  cur.primary = cur.notes.length - 1;
  setVelUI(); renderRoll(); pushHistory();
  tick(`pasted ${cur.sel.size} note${cur.sel.size !== 1 ? 's' : ''}`);
}

// ── interactions ──────────────────────────────────────────────────────────────
function eraseNote(i) {
  if (cur.notes[i] == null) return;
  cur.notes.splice(i, 1);
  cur.sel = new Set(); cur.primary = null;
  renderRoll();
}

function onPointerDown(e) {
  const roll = $('#pe-roll');
  const noteEl = e.target.closest('.pe-note');

  if (cur.tool === 'eraser') {                        // click/drag over notes to remove
    drag = { mode: 'erase' };
    roll.setPointerCapture(e.pointerId);
    if (noteEl) { drag.erased = true; eraseNote(+noteEl.dataset.i); }
    e.preventDefault();
    return;
  }

  if (noteEl) {                                       // select + move/resize (pencil & select)
    const i = +noteEl.dataset.i;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (cur.sel.has(i)) cur.sel.delete(i); else cur.sel.add(i);
    } else if (!cur.sel.has(i)) {
      cur.sel = new Set([i]);
    }
    cur.primary = i;
    if (e.target.classList.contains('pe-resize')) {
      drag = { mode: 'resize', idx: i };
    } else {
      drag = { mode: 'move', idx: i, grabTick: tickAtX(roll, e.clientX),
               origNote: cur.notes[i].note,
               orig: new Map(selArr().map(j => [j, { start: cur.notes[j].start, note: cur.notes[j].note }])) };
    }
    roll.setPointerCapture(e.pointerId);
    setVelUI(); renderRoll();
    roll.querySelector(`.pe-note[data-i="${cur.primary}"]`)?.focus();   // so arrow keys work after a click
    return;
  }

  // empty grid
  if (cur.tool === 'select') {                        // rubber-band marquee
    const r = roll.getBoundingClientRect();
    const m = document.createElement('div'); m.className = 'pe-marquee'; roll.append(m);
    drag = { mode: 'marquee', x0: e.clientX - r.left, y0: e.clientY - r.top, add: e.shiftKey, el: m };
    roll.setPointerCapture(e.pointerId); e.preventDefault();
    return;
  }
  // pencil → add a note and drag it
  const r = roll.getBoundingClientRect();
  cur.notes.push({ start: tickAtX(roll, e.clientX), dur: snap() || 24,
                   note: clampNote(noteAtY(e.clientY - r.top), cur.track),
                   vel: +$('#pe-vel').value, track: cur.track });
  const i = cur.notes.length - 1;
  cur.sel = new Set([i]); cur.primary = i;
  drag = { mode: 'move', idx: i, grabTick: cur.notes[i].start, origNote: cur.notes[i].note,
           orig: new Map([[i, { start: cur.notes[i].start, note: cur.notes[i].note }]]) };
  roll.setPointerCapture(e.pointerId);
  setVelUI(); renderRoll();
  roll.querySelector(`.pe-note[data-i="${i}"]`)?.focus();
}

function onPointerMove(e) {
  if (!drag) return;
  const roll = $('#pe-roll');
  if (drag.mode === 'erase') {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const ne = el && el.closest && el.closest('.pe-note');
    if (ne) { drag.erased = true; eraseNote(+ne.dataset.i); }
    return;
  }
  if (drag.mode === 'marquee') {
    const r = roll.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    Object.assign(drag.el.style, {
      left: Math.min(drag.x0, x) + 'px', top: Math.min(drag.y0, y) + 'px',
      width: Math.abs(x - drag.x0) + 'px', height: Math.abs(y - drag.y0) + 'px',
    });
    return;
  }
  const t = tickAtX(roll, e.clientX);
  const s = step();
  if (drag.mode === 'resize') {
    const nt = cur.notes[drag.idx];
    nt.dur = Math.max(s, Math.round((t - nt.start) / s) * s);
  } else {
    const r = roll.getBoundingClientRect();
    let dStart = t - drag.grabTick;
    let dNote = clampNote(noteAtY(e.clientY - r.top), cur.notes[drag.idx].track) - drag.origNote;
    const tot = total();
    let loS = -1e9, hiS = 1e9, loN = -1e9, hiN = 1e9;
    for (const [j, o] of drag.orig) {
      loS = Math.max(loS, -o.start); hiS = Math.min(hiS, (tot - s) - o.start);
      const [a, b] = trackRange(cur.notes[j].track);
      loN = Math.max(loN, a - o.note); hiN = Math.min(hiN, b - o.note);
    }
    dStart = Math.max(loS, Math.min(hiS, dStart));
    dNote = Math.max(loN, Math.min(hiN, dNote));
    for (const [j, o] of drag.orig) {
      cur.notes[j].start = o.start + dStart;
      cur.notes[j].note = o.note + dNote;
    }
  }
  renderRoll();
}

// select all notes intersecting the dragged box (content-px → tick/row ranges)
function finishMarquee() {
  const roll = $('#pe-roll'), W = roll.clientWidth, tot = total(), st = drag.el.style;
  const L = parseFloat(st.left) || 0, T = parseFloat(st.top) || 0;
  const w = parseFloat(st.width) || 0, h = parseFloat(st.height) || 0;
  drag.el.remove();
  if (w < 3 && h < 3) {                               // a click, not a drag → clear (unless shift)
    if (!drag.add) { cur.sel = new Set(); cur.primary = null; setVelUI(); renderRoll(); }
    return;
  }
  const tickLo = L / W * tot, tickHi = (L + w) / W * tot;
  const noteHi = HI - Math.floor(T / ROWH), noteLo = HI - Math.floor((T + h) / ROWH);
  const sel = drag.add ? new Set(cur.sel) : new Set();
  cur.notes.forEach((n, i) => {
    if (n.start < tickHi && n.start + n.dur > tickLo && n.note >= noteLo && n.note <= noteHi) sel.add(i);
  });
  cur.sel = sel; cur.primary = sel.size ? Math.max(...sel) : null;
  setVelUI(); renderRoll();
}

function onPointerUp() {
  if (!drag) return;
  if (drag.mode === 'marquee') finishMarquee();
  else if (drag.mode === 'erase') { if (drag.erased) pushHistory(); }
  else pushHistory();                                 // move / resize / pencil-add
  drag = null;
}

function onWheel(e) {                                 // scroll over a note → velocity
  const noteEl = e.target.closest('.pe-note');
  if (!noteEl) return;
  e.preventDefault();
  const i = +noteEl.dataset.i;
  cur.notes[i].vel = Math.max(1, Math.min(127, cur.notes[i].vel + (e.deltaY < 0 ? 4 : -4)));
  if (!cur.sel.has(i)) cur.sel = new Set([i]);
  cur.primary = i;
  setVelUI(); renderRoll(); pushHistory();
}

// a note receiving focus (Tab or click) becomes the primary + selection
function onFocusIn(e) {
  const el = e.target.closest && e.target.closest('.pe-note');
  if (!el) return;
  const idx = +el.dataset.i;
  cur.primary = idx;
  if (!cur.sel.has(idx)) { cur.sel = new Set([idx]); renderRoll(); }
  setVelUI();
}

const inField = el => el && (
  (el.tagName === 'INPUT' && ['text', 'number', 'search', 'range'].includes(el.type))
  || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
// a real text-entry field — where Space must type a space (so it can't be a shortcut)
const isText = el => el && (el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password'].includes(el.type)));

function onKey(e) {
  if (!$('#pattern-editor').open) return;   // editor closed → ignore (document-level listener)
  const ae = document.activeElement;
  // Spacebar = play/stop anywhere in the editor (even on a button/select/slider),
  // except an actual text field so the NAME can still take a space
  if (e.key === ' ' && !isText(ae)) { e.preventDefault(); preview(); return; }
  if (inField(ae)) return;              // other keys: keep native in inputs/selects/range
  // edit shortcuts (work anywhere in the editor that isn't a text field)
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'a') { e.preventDefault(); selectAll(); return; }
    if (k === 'c') { e.preventDefault(); copySel(); return; }
    if (k === 'v') { e.preventDefault(); paste(); return; }
  }
  // Delete removes the whole selection (plus a focused note, if any)
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const kill = new Set(cur.sel);
    if (ae && ae.classList && ae.classList.contains('pe-note')) kill.add(+ae.dataset.i);
    if (!kill.size) return;
    e.preventDefault();
    cur.notes = cur.notes.filter((_, i) => !kill.has(i));
    cur.sel = new Set(); cur.primary = null;
    renderRoll(); setVelUI(); pushHistory();
    ($('#pe-roll').querySelector('.pe-note') || $('#pe-roll')).focus();
    return;
  }
  // arrows nudge the FOCUSED note (single)
  if (!ae || !ae.classList || !ae.classList.contains('pe-note')) return;
  const idx = +ae.dataset.i;
  const nt = cur.notes[idx];
  if (!nt) return;
  const s = step();
  if (e.key === 'ArrowLeft') nt[e.shiftKey ? 'dur' : 'start'] =
    e.shiftKey ? Math.max(s, nt.dur - s) : Math.max(0, nt.start - s);
  else if (e.key === 'ArrowRight') nt[e.shiftKey ? 'dur' : 'start'] =
    e.shiftKey ? Math.min(total() - nt.start, nt.dur + s) : Math.min(total() - s, nt.start + s);
  else if (e.key === 'ArrowUp') nt.note = clampNote(nt.note + 1, nt.track);
  else if (e.key === 'ArrowDown') nt.note = clampNote(nt.note - 1, nt.track);
  else return;
  e.preventDefault();
  setVelUI(); renderRoll(); pushHistory();      // renderRoll restores focus to this note
}

function setTool(t) {
  cur.tool = t;
  for (const x of ['pencil', 'eraser', 'select']) $('#pe-tool-' + x).classList.toggle('on', x === t);
  const roll = $('#pe-roll');
  roll.classList.toggle('erasing', t === 'eraser');
  roll.classList.toggle('selecting', t === 'select');
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
    track: 0, tool: 'pencil', sel: new Set(), primary: null,
  };
  $('#pe-title').textContent = `EDIT P${String(p.pattern + 1).padStart(2, '0')}`;
  $('#pe-name').value = cur.name;
  $('#pe-bars').value = cur.bars;
  fillSampleSelect();
  $('#pe-sample').value = cur.sample == null ? '' : String(cur.sample);
  setTrack(0);
  setTool('pencil');
  buildGutter();
  renderRoll();
  setVelUI();
  cur.origSmf = buildSmf();         // pristine slot, for restore-on-cancel
  cur.dirty = false;
  history = [stateStr()]; hpos = 0;
  pePlaying = false; setPlayBtn();
  $('#pattern-editor').showModal();
  // start scrolled to the pad range (around C4)
  $('#pe-roll-wrap').scrollTop = rowTop(PAD_HI) - 40;
  $('#pe-roll').focus();            // start in the roll so the edit shortcuts work (not a text field)
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
  roll.addEventListener('focusin', onFocusIn);
  // document-level so the edit shortcuts work wherever focus is inside the open
  // editor (a click can land focus outside the note that was clicked)
  document.addEventListener('keydown', onKey);
  $('#pe-tool-pencil').onclick = () => setTool('pencil');
  $('#pe-tool-eraser').onclick = () => setTool('eraser');
  $('#pe-tool-select').onclick = () => setTool('select');
  $('#pe-track-smp').onclick = () => setTrack(0);
  $('#pe-track-kbd').onclick = () => setTrack(1);
  $('#pe-grid').onchange = renderRoll;
  $('#pe-bars').onchange = () => {
    cur.bars = Math.max(1, Math.min(99, +$('#pe-bars').value || 1));
    $('#pe-bars').value = cur.bars;
    renderRoll(); pushHistory();
  };
  $('#pe-name').oninput = () => { cur.name = $('#pe-name').value.slice(0, 8); };
  $('#pe-name').onchange = () => pushHistory();
  $('#pe-sample').onchange = () => {
    cur.sample = $('#pe-sample').value === '' ? null : +$('#pe-sample').value;
    pushHistory();
  };
  $('#pe-vel').oninput = () => {
    const v = +$('#pe-vel').value;
    $('#pe-vel-val').textContent = v;
    const idxs = selArr();
    if (idxs.length) { for (const i of idxs) cur.notes[i].vel = v; renderRoll(); }
  };
  $('#pe-vel').onchange = () => { if (selArr().length) pushHistory(); };
  $('#pe-play').onclick = () => { preview(); };
  $('#pe-save').onclick = () => { save(); };
  // Esc → discard (stop preview + restore the slot if a preview wrote to it)
  $('#pattern-editor').addEventListener('cancel', e => { e.preventDefault(); cancel(); });
  // click outside the dialog (on the backdrop) → save and close
  $('#pattern-editor').addEventListener('click', e => {
    if (e.target !== $('#pattern-editor')) return;           // a backdrop click targets the dialog itself
    const r = $('#pattern-editor').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) save();
  });
}
