// PATTERNS view: receive, piano-roll cards, .mid export/import, init.
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, apiJson, confirmDialog, esc, jsonBody } from './util.js';

let loadingPatterns = false;
let lastPatterns = null;            // for recolouring the rolls on theme change

// repaint the piano-roll cards when the accent theme changes
addEventListener('msmpl-theme', () => { if (lastPatterns) renderPatterns(lastPatterns); });

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
      <canvas class="pattern-roll"></canvas>
      <div class="p-head">
        <span class="p-meta">BARS <b>${p.valid ? p.bars : '–'}</b></span>
        <span class="p-meta" title="Sample assigned to the keyboard-mode track">
          KBD SAMPLE <b>${esc(sampleLabel(p.sample))}</b></span>
        <span class="spacer"></span>
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'p-actions';
    if (recorded) {                                  // play on the device (transport)
      const play = document.createElement('button');
      play.className = 'hw-btn';
      play.title = 'Play this pattern on the device';
      play.innerHTML = '<span class="hw-btn-cap">▶</span>';
      play.onclick = () => playPattern(p, play.querySelector('.hw-btn-cap'));
      actions.append(play);
    }
    const dl = document.createElement('a');
    dl.className = 'hw-btn';
    dl.href = `/api/pattern/${p.pattern}.mid`;
    dl.download = `pattern${String(p.pattern + 1).padStart(2, '0')}.mid`;
    dl.innerHTML = '<span class="hw-btn-cap">⇩ .MID</span>';
    const up = document.createElement('button');
    up.className = 'hw-btn accent';
    up.innerHTML = '<span class="hw-btn-cap">⇧ .MID</span>';
    up.onclick = () => importPatternSmf(p.pattern);
    const ini = document.createElement('button');
    ini.className = 'hw-btn';
    ini.innerHTML = '<span class="hw-btn-cap">INIT</span>';
    ini.onclick = () => initPattern(p.pattern, recorded);
    actions.append(dl, up, ini);
    card.append(actions);
    grid.append(card);
    if (p.valid) drawRoll(card.querySelector('.pattern-roll'), p);
  }
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
// Play patterns through the hardware sequencer (the synth must be connected
// anyway, and it sounds exactly like the device). The bridge sends a Program
// Change to try to select the pattern, then MIDI Start (0xFA); STOP sends MIDI
// Stop (0xFC). ⚠ Remote pattern SELECT is experimental — the device may only
// play the pattern selected on its panel (verify on hardware). One transport,
// so only one pattern plays at a time.
let playing = null;      // { pattern, cap } currently transport-playing, or null

export function stopTransport() {
  if (!playing) return;
  const cap = playing.cap;
  playing = null;
  cap.textContent = '▶';
  apiJson('/api/transport/stop', { method: 'POST' }).catch(() => { });
}

async function playPattern(p, cap) {
  if (playing && playing.pattern === p.pattern) { stopTransport(); return; }  // click again = stop
  // switching patterns: just revert the previous button — the new /play stops
  // it on the device itself (atomically), so we DON'T fire a separate /stop
  // (two racing requests sometimes restarted the OLD pattern).
  if (playing) playing.cap.textContent = '▶';
  playing = { pattern: p.pattern, cap };
  cap.textContent = '■';
  try {
    // the device sequencer is a slave — the bridge streams MIDI clock at this
    // tempo so Start actually advances (device needs MIDI CLK = AUTO/EXT MIDI)
    await apiJson(`/api/pattern/${p.pattern}/play`,
                  jsonBody({ bpm: (state.bank && state.bank.bpm) || 120 }));
    tick(`▶ pattern ${p.pattern + 1} (device)`);
  } catch (e) {
    tick(`⚠ play failed: ${e.message}`);
    if (playing && playing.pattern === p.pattern) { cap.textContent = '▶'; playing = null; }
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
      await loadPatterns();
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
    await apiJson(`/api/pattern/${q}/init`, { method: 'POST' });
    tick(`pattern ${q + 1} initialized`);
    await loadPatterns();
  } catch (e) { tick(`⚠ init failed: ${e.message}`); }
}

$('#patterns-refresh').onclick = () => loadPatterns();
