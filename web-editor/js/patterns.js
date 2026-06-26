// PATTERNS view: receive, piano-roll cards, .mid export/import, init, in-app edit.
import { openPatternEditor } from './patternEdit.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, apiJson, confirmDialog, esc, jsonBody } from './util.js';

let loadingPatterns = false;
let lastPatterns = null;            // for recolouring the rolls on theme change

// repaint the piano-roll cards when the accent theme changes
addEventListener('msmpl-theme', () => { if (lastPatterns) renderPatterns(lastPatterns); });
// the pattern editor reports the one changed pattern after a save (detail = the
// updated pattern JSON) — update just that card, no full re-receive
addEventListener('msmpl-pattern-changed', e => applyPattern(e.detail));

// live progress from the bridge (one SSE event per pattern read)
export function onPatternsProgress(done, total) {
  if (!loadingPatterns) return;
  const fill = $('#pat-progress-fill');
  const txt = $('#pat-progress-txt');
  if (!fill) return;
  fill.style.width = `${Math.round(100 * done / total)}%`;
  txt.textContent = done >= total
    ? 'PARSING…' : `READING PATTERN ${done + 1} / ${total}`;
}

async function loadPatterns() {
  const btn = $('#patterns-refresh');
  btn.setAttribute('aria-busy', 'true');
  loadingPatterns = true;
  $('#pattern-grid').innerHTML =
    `<div class="pat-progress">
       <div class="pat-progress-txt" id="pat-progress-txt">READING PATTERNS…</div>
       <div class="pat-progress-bar"><div class="pat-progress-fill" id="pat-progress-fill"></div></div>
     </div>`;
  try {
    const { patterns } = await apiJson('/api/patterns');
    renderPatterns(patterns);
    tick('✓ received 16 patterns');
  } catch (e) {
    $('#pattern-grid').innerHTML =
      `<p class="backup-empty">PATTERN READ FAILED — ${esc(e.message.toUpperCase())}</p>`;
    tick('⚠ patterns: ' + e.message);
  } finally {
    loadingPatterns = false;
    btn.removeAttribute('aria-busy');
  }
}

function renderPatterns(patterns) {
  lastPatterns = patterns;
  stopTransport();                     // cards are about to be rebuilt
  const grid = $('#pattern-grid');
  grid.innerHTML = '';
  for (const p of patterns) {
    const card = buildCard(p);
    grid.append(card);
    if (p.valid) drawRoll(card.querySelector('.pattern-roll'), p);
  }
}

// build one pattern card's DOM (the caller inserts it and draws its roll)
function buildCard(p) {
    const card = document.createElement('div');
    const recorded = p.valid && p.note_count > 0;
    card.className = 'pattern-card' + (recorded ? '' : ' is-empty');
    // The stored sample# is the KEYBOARD-mode track's sample; the sample-mode
    // track triggers pads by note number (can use many samples).
    const tracks = [];
    if (!p.valid) tracks.push('????');
    else if (!recorded) tracks.push('EMPTY');
    else {
      if (p.smp_notes) tracks.push(`<i class="dot smp"></i>SMP ${p.smp_notes}`);
      if (p.kbd_notes) tracks.push(`<i class="dot kbd"></i>KBD ${p.kbd_notes}`);
    }
    card.innerHTML = `
      <div class="p-head">
        <span class="p-num">P${String(p.pattern + 1).padStart(2, '0')}</span>
        <span class="p-name">${p.valid ? esc(p.name) : '????'}</span>
        <span class="spacer"></span>
        <span class="p-meta">${tracks.join(' · ')}</span>
      </div>
      <div class="pattern-roll-wrap"><canvas class="pattern-roll"></canvas></div>
      <div class="p-head">
        <span class="p-meta">BARS <b>${p.valid ? p.bars : '–'}</b></span>
        <span class="p-meta" title="Sample assigned to the keyboard-mode track">
          KBD SAMPLE <b>${esc(sampleLabel(p.sample))}</b></span>
        <span class="spacer"></span>
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'p-actions';
    // PLAY/STOP on the device — icon + label both toggle via the .playing class
    const play = document.createElement('button');
    play.className = 'hw-btn';
    play.disabled = !recorded;
    play.title = recorded ? 'Play this pattern on the device' : 'No pattern data to play';
    play.innerHTML =
      `<span class="hw-btn-cap ai-cap">
         <svg class="ai-ico ai-play" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5 11 6 3 10.5Z"/></svg>
         <svg class="ai-ico ai-stop" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>
         <span class="ai-lbl ai-play">PLAY</span><span class="ai-lbl ai-stop">STOP</span>
       </span>`;
    if (recorded) play.onclick = () => playPattern(p, play);
    const imp = document.createElement('button');
    imp.className = 'hw-btn';
    imp.title = 'Import a .mid file into this pattern';
    imp.innerHTML = '<span class="hw-btn-cap"><span class="ico ico-up"></span>IMPORT</span>';
    imp.onclick = () => importPatternSmf(p.pattern);
    const exp = document.createElement('a');
    exp.className = 'hw-btn';
    exp.href = `/api/pattern/${p.pattern}.mid`;
    exp.download = `pattern${String(p.pattern + 1).padStart(2, '0')}.mid`;
    exp.title = 'Export this pattern as a .mid file';
    exp.innerHTML = '<span class="hw-btn-cap"><span class="ico ico-dn"></span>EXPORT</span>';
    // EDIT — in-app piano roll (works on empty patterns too, to build from scratch)
    const ed = document.createElement('button');
    ed.className = 'hw-btn';
    ed.disabled = !p.valid;
    ed.title = p.valid ? 'Edit this pattern in the piano roll' : 'Pattern data unreadable';
    ed.innerHTML = '<span class="hw-btn-cap">✎ EDIT</span>';
    if (p.valid) ed.onclick = () => openPatternEditor(p);
    const ini = document.createElement('button');
    ini.className = 'hw-btn';
    ini.title = 'Reset this pattern to the factory INIT';
    ini.innerHTML = '<span class="hw-btn-cap"><span class="ico ico-reset"></span>INIT</span>';
    ini.onclick = () => initPattern(p.pattern, recorded);
    const row1 = document.createElement('div'); row1.className = 'p-row';
    row1.append(play, ed, ini);                  // PLAY · EDIT · INIT
    const row2 = document.createElement('div'); row2.className = 'p-row';
    row2.append(imp, exp);                         // IMPORT · EXPORT
    actions.append(row1, row2);
    card.append(actions);
    return card;
}

// Update a single card in place after a save / INIT / import — avoids re-receiving
// all 16 patterns from the device (slow + stops the sequencer). The write's POST
// response already carries the changed pattern (bridge pattern_write → _pattern_json).
export function applyPattern(p) {
  if (!p || !lastPatterns) return;
  lastPatterns[p.pattern] = p;
  if (playing && playing.pattern === p.pattern) stopTransport();   // DOM swap orphans the btn
  const grid = $('#pattern-grid');
  const card = buildCard(p);
  const old = grid.children[p.pattern];
  if (old) grid.replaceChild(card, old); else grid.append(card);
  if (p.valid) drawRoll(card.querySelector('.pattern-roll'), p);
}

function sampleLabel(idx) {
  if (idx == null) return '—';
  const s = state.bank && state.bank.slots[idx];
  return s && !s.empty ? s.name : `#${idx + 1}`;
}

function drawRoll(canvas, p) {
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth * dpr || 300, H = canvas.clientHeight * dpr || 60;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const total = Math.max(p.ticks, 1);
  // sample-mode track follows the theme accent; keyboard-mode track keeps its
  // distinct pale-cream so the two tracks stay tellable apart on any theme.
  const rgb = getComputedStyle(document.documentElement)
    .getPropertyValue('--amber-rgb').trim() || '255,138,30';
  // bar grid
  g.strokeStyle = `rgba(${rgb},.14)`;
  g.lineWidth = 1;
  for (let b = 0; b <= p.bars; b++) {
    const x = (b * 384 / total) * W;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  if (!p.notes.length) return;
  const lo = Math.min(...p.notes.map(n => n[2]));
  const hi = Math.max(...p.notes.map(n => n[2]));
  const span = Math.max(hi - lo, 1);
  g.shadowBlur = 3 * dpr;
  for (const [t, ch, note, vel, dur] of p.notes) {
    const x = (t / total) * W;
    const w = Math.max((dur / total) * W, 2 * dpr);
    const y = H - ((note - lo) / span) * (H - 8 * dpr) - 6 * dpr;
    // sample-mode track = amber, keyboard-mode track = pale cream
    g.fillStyle = ch ? '#ffe9c9' : `rgb(${rgb})`;
    g.shadowColor = ch ? 'rgba(255,233,201,.6)' : `rgba(${rgb},.7)`;
    g.globalAlpha = .4 + (vel / 127) * .6;
    g.fillRect(x, y, w, 3 * dpr);
  }
  g.globalAlpha = 1;
}

// ── pattern playback (on the DEVICE) ───────────────────────────────────────
// Play patterns through the hardware sequencer (it sounds exactly like the
// device). The bridge selects the pattern via NRPN on the [PATTERN] dial, then
// streams MIDI clock and sends MIDI Start (0xFA) — the sequencer is a slave, so
// the clock is what advances it; STOP sends MIDI Stop (0xFC) + clock off.
// Hardware-confirmed (device must be on GLOBAL > MIDI CLK = AUTO/EXT MIDI). One
// transport, so only one pattern plays at a time.
let playing = null;      // { pattern, btn } currently transport-playing, or null

// APPROXIMATE play sweep on the card's mini-roll (the app can't read the device's
// true position): a rAF line over the pattern's duration (bars × 4 beats at the
// bank BPM, ticks == bars×384 so it maps linearly), looping like the device does.
let pRAF = null, pPlayhead = null;
function stopPlayhead() {
  if (pRAF) cancelAnimationFrame(pRAF);
  pRAF = null;
  if (pPlayhead) { pPlayhead.remove(); pPlayhead = null; }
}
function startPlayhead(p, btn, bpm) {
  stopPlayhead();
  const wrap = btn.closest('.pattern-card') && btn.closest('.pattern-card').querySelector('.pattern-roll-wrap');
  if (!wrap) return;
  const ph = document.createElement('div');
  ph.className = 'p-playhead';
  wrap.append(ph);
  pPlayhead = ph;
  const durMs = p.bars * 4 * (60000 / Math.max(20, Math.min(300, bpm || 120)));
  let t0 = null;
  const frame = ts => {
    if (pPlayhead !== ph) return;                 // stopped or superseded by another card
    if (t0 == null) t0 = ts;
    ph.style.left = (((ts - t0) % durMs) / durMs * wrap.clientWidth) + 'px';
    pRAF = requestAnimationFrame(frame);
  };
  pRAF = requestAnimationFrame(frame);
}

export function stopTransport() {
  if (!playing) return;
  const btn = playing.btn;
  playing = null;
  btn.classList.remove('playing');
  stopPlayhead();
  apiJson('/api/transport/stop', { method: 'POST' }).catch(() => { });
}

async function playPattern(p, btn) {
  if (playing && playing.pattern === p.pattern) { stopTransport(); return; }  // click again = stop
  // switching patterns: just revert the previous button — the new /play stops
  // it on the device itself (atomically), so we DON'T fire a separate /stop
  // (two racing requests sometimes restarted the OLD pattern).
  if (playing) playing.btn.classList.remove('playing');
  playing = { pattern: p.pattern, btn };
  btn.classList.add('playing');
  const bpm = (state.bank && state.bank.bpm) || 120;
  startPlayhead(p, btn, bpm);
  try {
    // the device sequencer is a slave — the bridge streams MIDI clock at this
    // tempo so Start actually advances (device needs MIDI CLK = AUTO/EXT MIDI)
    await apiJson(`/api/pattern/${p.pattern}/play`, jsonBody({ bpm }));
    tick(`▶ pattern ${p.pattern + 1} (device)`);
  } catch (e) {
    tick(`⚠ play failed: ${e.message}`);
    if (playing && playing.pattern === p.pattern) {
      btn.classList.remove('playing'); playing = null; stopPlayhead();
    }
  }
}

function importPatternSmf(q) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mid,.midi,audio/midi';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    if (!await confirmDialog(`IMPORT → PATTERN ${q + 1}`,
        `Import "${f.name}"? OVERWRITES that pattern in the device's current ` +
        `bank (RAM). MIDI ch 1 → sample-mode track (pads by note), other ` +
        `channels → keyboard-mode track.`, 'IMPORT')) return;
    try {
      const r = await apiJson(`/api/pattern/${q}`, {
        method: 'POST', body: await f.arrayBuffer(),
      });
      tick(`⇧ pattern ${q + 1}: ${r.note_count} notes, ${r.bars} bars written`);
      applyPattern(r);                   // single-card update (no full re-receive)
    } catch (e) {
      tick(`⚠ pattern import failed: ${e.message}`);
      alert('Pattern import failed: ' + e.message);
    }
  };
  input.click();
}

async function initPattern(q, recorded) {
  if (!await confirmDialog(`INIT PATTERN ${q + 1}`,
      `Reset to the factory INIT pattern` +
      (recorded ? ' — its recorded notes will be LOST (RAM)?' : '?'), 'INIT')) return;
  try {
    const r = await apiJson(`/api/pattern/${q}/init`, { method: 'POST' });
    tick(`pattern ${q + 1} initialized`);
    applyPattern(r);                     // single-card update (no full re-receive)
  } catch (e) { tick(`⚠ init failed: ${e.message}`); }
}

$('#patterns-refresh').onclick = () => loadPatterns();

// REC — press the device's [REC] button (NRPN); fire-and-forget, no readback,
// so the user watches the device screen (arm → start → end). Mirrors SAMPLING.
$('#pattern-rec').onclick = () =>
  apiJson('/api/pattern/rec', { method: 'POST' })
    .then(() => tick('● REC pressed — arm → start → end on the device'))
    .catch(e => tick(`⚠ rec failed: ${e.message}`));
