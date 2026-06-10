// Waveform screen: lazy WAV load, peak rendering, zoom/pan, start/end marker
// dragging, device audition + approximate playhead.
import { tuneCents } from './controls.js';
import { renderMeter } from './meter.js';
import { loadSampleAudio } from './sampleLoad.js';
import { renderChips, renderMetaFmt, renderPoints } from './slot.js';
import { slotData, state } from './state.js';
import { tick } from './ticker.js';
import { $, api, jsonBody } from './util.js';

// Zoom window into the decoded buffer, in SAMPLE space [0..n]. vlen === 0 means
// "fit on next draw". The window is global (not per-slot) and resets to fit
// whenever a different sample's waveform is (re)loaded.
const MIN_SAMPLES = 32;                          // tightest zoom (~frame level)
let view = { v0: 0, vlen: 0 };

const wave = $('#wave');
const curBuf = () => (state.sel != null ? state.buffers.get(state.sel) : null);

export async function loadWave(i) {
  stopAudition();                  // end any held audition note before switching
  const s = slotData(i);
  const canvas = $('#wave');
  const status = $('#wave-status');
  const ctx2d = canvas.getContext('2d');
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  if (s.empty) {
    status.hidden = false; status.textContent = 'NO DATA';
    $('#wave-zoom').hidden = true;
    return;
  }

  status.hidden = false; status.textContent = 'READING…';
  try {
    const buf = await loadSampleAudio(i);        // fetch+decode+cache+format
    if (state.sel !== i) return;                 // user moved on meanwhile
    status.hidden = true;
    renderChips(s);
    renderMetaFmt(s);
    renderMeter();                               // exact size now known
    view = { v0: 0, vlen: buf.length };          // fresh sample → fit
    drawWave(buf, s);
    updateZoomUI();
  } catch (e) {
    status.textContent = 'READ ERROR — ' + e.message.toUpperCase();
  }
}

export function drawWave(buf, s) {
  const canvas = $('#wave');
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const mid = H / 2;

  // min/max peaks across all channels
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const n = chans[0].length;
  // clamp the zoom window to the buffer (also handles the "fit" sentinel)
  if (!(view.vlen > 0) || view.vlen > n) view = { v0: 0, vlen: n };
  view.v0 = Math.max(0, Math.min(n - view.vlen, view.v0));
  const { v0, vlen } = view;

  // accent colours follow the active theme (read the CSS custom props live)
  const cs = getComputedStyle(document.documentElement);
  const rgb = cs.getPropertyValue('--amber-rgb').trim() || '255,138,30';
  const hiRgb = cs.getPropertyValue('--amber-hi-rgb').trim() || '255,192,99';
  const A = a => `rgba(${rgb},${a})`;

  // faint grid
  g.strokeStyle = A(.07);
  g.lineWidth = 1;
  for (let x = 0; x < W; x += W / 16) line(g, x, 0, x, H);
  line(g, 0, mid, W, mid);

  // start/end are DEVICE frames; the decoded buffer may be resampled. Map a
  // device frame → buffer sample → canvas x through the current zoom window.
  const total = s.frames || n;
  const frameToX = f => (((f / total) * n - v0) / vlen) * W;
  const startX = frameToX(s.start), endX = frameToX(s.end);

  // pass 1: min/max bars (dense material reads as a filled band)
  const mids = new Float32Array(W);
  const spp = vlen / W;                          // samples per pixel column
  g.save();
  g.shadowColor = A(.8);
  g.shadowBlur = 6 * dpr;
  g.fillStyle = `rgb(${rgb})`;
  for (let x = 0; x < W; x++) {
    const a = v0 + x * spp;
    let i0 = Math.floor(a), i1 = Math.max(i0 + 1, Math.ceil(a + spp));
    if (i0 < 0) i0 = 0;
    if (i1 > n) i1 = n;
    let lo = 1, hi = -1, acc = 0, cnt = 0;
    const stride = Math.max(1, Math.floor((i1 - i0) / 24));
    for (let i = i0; i < i1; i += stride) {
      for (const ch of chans) {
        const v = ch[i] || 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        acc += v; cnt++;
      }
    }
    mids[x] = cnt ? acc / cnt : 0;
    const inRange = x >= startX && x <= endX;
    g.globalAlpha = inRange ? .95 : .2;
    const y0 = mid + lo * (mid * .92), y1 = mid + hi * (mid * .92);
    g.fillRect(x, y1, 1, Math.max(1, y0 - y1));
  }
  g.restore();

  // pass 2: connecting trace (tonal material reads as a waveform)
  g.save();
  g.strokeStyle = `rgba(${hiRgb},.85)`;
  g.lineWidth = dpr;
  g.shadowColor = A(.6);
  g.shadowBlur = 4 * dpr;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    const y = mid + mids[x] * (mid * .92);
    x ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  g.restore();

  // start/end flags (skip when scrolled off-screen)
  g.globalAlpha = 1;
  for (const [x, label] of [[startX, 'S'], [endX, 'E']]) {
    if (x < -2 || x > W + 2) continue;
    g.strokeStyle = `rgb(${hiRgb})`; g.lineWidth = dpr;
    line(g, x, 0, x, H);
    g.fillStyle = `rgb(${hiRgb})`;
    g.font = `${10 * dpr}px "Share Tech Mono", monospace`;
    g.fillText(label, x + 3 * dpr, 12 * dpr);
  }
}
const line = (g, a, b, c, d) => { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); };

// ───────────────────────────────────────────────────────────────── zoom ──
function fitView() {
  const buf = curBuf();
  if (buf) view = { v0: 0, vlen: buf.length };
}
// scale the window by `factor` (>1 zooms out) keeping the sample under `frac`
// (0..1 across the canvas) anchored in place.
function zoomAround(frac, factor) {
  const buf = curBuf();
  if (!buf) return;
  const n = buf.length;
  const anchor = view.v0 + frac * view.vlen;
  const vlen = Math.max(MIN_SAMPLES, Math.min(n, view.vlen * factor));
  const v0 = Math.max(0, Math.min(n - vlen, anchor - frac * vlen));
  view = { v0, vlen };
}
function updateZoomUI() {
  const z = $('#wave-zoom');
  const buf = curBuf();
  if (!buf) { z.hidden = true; return; }
  z.hidden = false;
  const level = buf.length / (view.vlen || buf.length);
  $('#wz-level').textContent =
    (level < 9.95 ? level.toFixed(1) : Math.round(level)) + '×';
  const atFit = view.vlen >= buf.length - 0.5;
  $('#wz-out').disabled = atFit;
  $('#wz-fit').disabled = atFit;
}
function redrawZoom() {
  const buf = curBuf();
  if (!buf) return;
  drawWave(buf, slotData(state.sel));
  updateZoomUI();
}

$('#wz-in').onclick = () => { zoomAround(0.5, 0.6); redrawZoom(); };
$('#wz-out').onclick = () => { zoomAround(0.5, 1 / 0.6); redrawZoom(); };
$('#wz-fit').onclick = () => { fitView(); redrawZoom(); };

wave.addEventListener('wheel', ev => {
  const buf = curBuf();
  if (!buf) return;
  ev.preventDefault();
  const r = wave.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  zoomAround(frac, ev.deltaY < 0 ? 0.8 : 1.25);
  redrawZoom();
}, { passive: false });

wave.addEventListener('dblclick', () => { fitView(); redrawZoom(); });

// ─────────────────────────────── start/end marker dragging · pan dragging ──
// Points are u32 frame counts (too big for a live 0x41 value): drag updates
// the display locally, release sends them via the param blob (POST …/points).
// Dragging the body (not a marker) pans the zoom window instead.
{
  let drag = null;                                // {mode:'start'|'end'|'pan', …}

  const sel = () => {
    const s = state.sel != null ? slotData(state.sel) : null;
    return s && !s.empty && state.buffers.get(state.sel) ? s : null;
  };
  const frameAt = (ev, s) => {
    const n = (curBuf() || { length: 1 }).length;
    const r = wave.getBoundingClientRect();
    const samp = view.v0 + ((ev.clientX - r.left) / r.width) * view.vlen;
    const total = s.frames || n;
    const f = Math.round((samp / n) * total);
    return Math.max(0, Math.min((s.frames || 2) - 2, f));
  };
  const nearMarker = (ev, s) => {
    const n = (curBuf() || { length: 1 }).length;
    const total = s.frames || n;
    const r = wave.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const toX = f => (((f / total) * n - view.v0) / view.vlen) * r.width;
    const ds = Math.abs(x - toX(s.start)), de = Math.abs(x - toX(s.end));
    if (ds < 9 && ds <= de) return 'start';
    if (de < 9) return 'end';
    return null;
  };
  const canPan = () => { const b = curBuf(); return b && view.vlen < b.length - 0.5; };

  wave.addEventListener('pointerdown', ev => {
    const s = sel();
    if (!s) return;
    const m = nearMarker(ev, s);
    if (m) drag = { mode: m };
    else if (canPan()) drag = { mode: 'pan', x: ev.clientX, v0: view.v0 };
    else return;                                  // at fit, body drag is a no-op
    wave.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  wave.addEventListener('pointermove', ev => {
    const s = sel();
    if (!s) return;
    if (!drag) {
      wave.style.cursor = nearMarker(ev, s) ? 'ew-resize' : (canPan() ? 'grab' : '');
      return;
    }
    if (drag.mode === 'pan') {
      const n = curBuf().length;
      const r = wave.getBoundingClientRect();
      const dxFrac = (ev.clientX - drag.x) / r.width;
      view = { v0: Math.max(0, Math.min(n - view.vlen, drag.v0 - dxFrac * view.vlen)),
               vlen: view.vlen };
      wave.style.cursor = 'grabbing';
      redrawZoom();
      return;
    }
    const f = frameAt(ev, s);
    if (drag.mode === 'start') s.start = Math.min(f, s.end - 1);
    else s.end = Math.max(f, s.start + 1);
    drawWave(curBuf(), s);
    renderPoints(s);
  });
  const endDrag = async () => {
    if (!drag) return;
    const mode = drag.mode;
    drag = null;
    wave.style.cursor = '';
    if (mode === 'pan') return;                   // panning sends nothing
    const i = state.sel, s = slotData(i);
    try {
      await api(`/api/sample/${i}/points`, jsonBody({ start: s.start, end: s.end }));
      tick(`→ S${i + 1} points ${s.start.toLocaleString()}…${s.end.toLocaleString()}`);
    } catch (e) { tick(`⚠ points failed: ${e.message}`); }
  };
  wave.addEventListener('pointerup', endDrag);
  wave.addEventListener('pointercancel', () => { drag = null; wave.style.cursor = ''; });
}

// ───────────────────────────────────────────────────────────── audition ──
// Audition plays the sample ON THE DEVICE (like the pad ▶), via a MIDI note —
// click toggles note-on/off. The playhead is APPROXIMATE: the app can't read
// the device's true position, so a rAF line sweeps START→END over the region's
// natural duration ((end−start)/rate), looping if the sample loops, mapped
// through the zoom window. Needs the slot's WAV loaded (it is — its waveform is
// shown); skipped otherwise.
let playRAF = null, playing = false, playingSlot = null;

export function stopAudition(sendNoteOff = true) {
  if (!playing) return;
  if (playRAF) cancelAnimationFrame(playRAF);
  playRAF = null;
  $('#playhead').hidden = true;
  $('#audition-btn .hw-btn-cap').textContent = '▶ PLAY';
  if (sendNoteOff && playingSlot != null)
    api('/api/note', jsonBody({ slot: playingSlot, on: false })).catch(() => { });
  playing = false; playingSlot = null;
}

// playback-speed multiplier the device applies to a pad-played sample, so the
// playhead sweeps at the right rate. BPM SYNC off → pitched by SEMITONE (±24)
// + TUNE (±1 semitone, via cents); stretch/pitch-sync → time scales by the
// bank BPM ÷ the sample's original BPM (orig BPM known only once the WAV has
// loaded — falls back to 1 until then).
function playbackSpeed(s) {
  if ((s.bpm_sync || 0) === 0) {
    const semis = (s.semitone || 0) + tuneCents(s.tune == null ? 64 : s.tune) / 100;
    return 2 ** (semis / 12);
  }
  return (s.tempo_bpm && state.bank && state.bank.bpm)
    ? state.bank.bpm / s.tempo_bpm : 1;
}

function startPlayhead(s) {
  const buf = state.buffers.get(playingSlot);
  if (!buf || !s.rate_hz || s.end <= s.start) return;   // unknown duration → no playhead
  const ph = $('#playhead');
  const total = s.frames || buf.length, n = buf.length;
  const speed = playbackSpeed(s) || 1;                  // faster pitch = shorter sweep
  const regionMs = ((s.end - s.start) / s.rate_hz / speed) * 1000;
  const rev = !!s.reverse;                              // REVERSE → sweep END→START
  let t0 = null;
  const frame = (ts) => {
    if (!playing) return;
    if (t0 == null) t0 = ts;
    let elapsed = ts - t0;
    if (elapsed >= regionMs) {
      if (s.loop) { t0 = ts; elapsed = 0; }            // looping sample → repeat
      else return stopAudition();                      // one-shot finished
    }
    const frac = regionMs > 0 ? elapsed / regionMs : 0;
    const pos = rev ? 1 - frac : frac;
    const devFrame = s.start + pos * (s.end - s.start);
    const x = (((devFrame / total) * n - view.v0) / view.vlen) * wave.clientWidth;
    if (x < 0 || x > wave.clientWidth) ph.hidden = true;   // scrolled off (zoom)
    else { ph.hidden = false; ph.style.left = x + 'px'; }
    playRAF = requestAnimationFrame(frame);
  };
  playRAF = requestAnimationFrame(frame);
}

$('#audition-btn').onclick = () => {
  if (playing) { stopAudition(); return; }
  if (state.sel == null) return;
  const s = slotData(state.sel);
  if (s.empty) return;
  playing = true; playingSlot = state.sel;
  $('#audition-btn .hw-btn-cap').textContent = '■ STOP';
  api('/api/note', jsonBody({ slot: playingSlot, on: true, velocity: 100 }))
    .catch(err => { tick(`⚠ play failed: ${err.message}`); stopAudition(false); });
  startPlayhead(s);
};

// keep the waveform crisp on window resizes — and recoloured on theme changes
const redrawCurrent = () => {
  if (state.sel != null && state.buffers.has(state.sel)) {
    drawWave(state.buffers.get(state.sel), slotData(state.sel));
    updateZoomUI();
  }
};
addEventListener('resize', redrawCurrent);
addEventListener('msmpl-theme', redrawCurrent);
