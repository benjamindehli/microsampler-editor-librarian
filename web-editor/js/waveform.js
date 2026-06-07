// Waveform screen: lazy WAV load, peak rendering, start/end marker dragging,
// browser-side audition.
import { $, api, wavFormat } from './util.js';
import { state, slotData } from './state.js';
import { tick } from './ticker.js';
import { renderPoints, renderChips, renderMetaFmt } from './slot.js';
import { renderMeter } from './meter.js';

export async function loadWave(i) {
  const s = slotData(i);
  const canvas = $('#wave');
  const status = $('#wave-status');
  const ctx2d = canvas.getContext('2d');
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  if (s.empty) { status.hidden = false; status.textContent = 'NO DATA'; return; }

  status.hidden = false; status.textContent = 'READING…';
  try {
    let buf = state.buffers.get(i);
    if (!buf) {
      const wav = await (await api(`/api/sample/${i}.wav`)).arrayBuffer();
      const fmt = wavFormat(wav.slice(0, 44));
      state.audio = state.audio || new AudioContext();
      buf = await state.audio.decodeAudioData(wav);
      state.buffers.set(i, buf);
      if (fmt) {                                 // backfill format from the WAV
        s.rate_hz = fmt.rate;
        s.stereo = fmt.channels === 2;
        s.frames = Math.round(buf.duration * fmt.rate);
        s.seconds = buf.duration;
      }
    }
    if (state.sel !== i) return;                 // user moved on meanwhile
    status.hidden = true;
    renderChips(s);
    renderMetaFmt(s);
    renderMeter();                               // exact size now known
    drawWave(buf, s);
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

  // faint grid
  g.strokeStyle = 'rgba(255,138,30,.07)';
  g.lineWidth = 1;
  for (let x = 0; x < W; x += W / 16) line(g, x, 0, x, H);
  line(g, 0, mid, W, mid);

  // min/max peaks across all channels
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const n = chans[0].length;
  const step = Math.max(1, Math.floor(n / W));
  // start/end are DEVICE frames; the decoded buffer may be resampled
  const total = s.frames || n;
  const startX = (s.start / total) * W, endX = (s.end / total) * W;

  // pass 1: min/max bars (dense material reads as a filled band)
  const mids = new Float32Array(W);
  g.save();
  g.shadowColor = 'rgba(255,138,30,.8)';
  g.shadowBlur = 6 * dpr;
  g.fillStyle = '#ff8a1e';
  for (let x = 0; x < W; x++) {
    let lo = 1, hi = -1, acc = 0, cnt = 0;
    const base = Math.floor((x / W) * n);
    for (let j = 0; j < step; j += Math.max(1, Math.floor(step / 24))) {
      for (const ch of chans) {
        const v = ch[base + j] || 0;
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
  g.strokeStyle = 'rgba(255,192,99,.85)';
  g.lineWidth = dpr;
  g.shadowColor = 'rgba(255,138,30,.6)';
  g.shadowBlur = 4 * dpr;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    const y = mid + mids[x] * (mid * .92);
    x ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  g.restore();

  // start/end flags
  g.globalAlpha = 1;
  for (const [x, label] of [[startX, 'S'], [endX, 'E']]) {
    g.strokeStyle = '#ffc063'; g.lineWidth = dpr;
    line(g, x, 0, x, H);
    g.fillStyle = '#ffc063';
    g.font = `${10 * dpr}px "Share Tech Mono", monospace`;
    g.fillText(label, x + 3 * dpr, 12 * dpr);
  }
}
const line = (g, a, b, c, d) => { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); };

// ─────────────────────────────────────────── start/end marker dragging ──
// Points are u32 frame counts (too big for a live 0x41 value): drag updates
// the display locally, release sends them via the param blob (POST …/points).
{
  const wave = $('#wave');
  let dragging = null;                            // 'start' | 'end' | null

  const sel = () => {
    const s = state.sel != null ? slotData(state.sel) : null;
    return s && !s.empty && state.buffers.get(state.sel) ? s : null;
  };
  const frameAt = (ev, s) => {
    const r = wave.getBoundingClientRect();
    const f = Math.round(((ev.clientX - r.left) / r.width) * (s.frames || 1));
    return Math.max(0, Math.min((s.frames || 2) - 2, f));
  };
  const nearMarker = (ev, s) => {
    const r = wave.getBoundingClientRect();
    const total = s.frames || 1;
    const x = ev.clientX - r.left;
    const sx = (s.start / total) * r.width, ex = (s.end / total) * r.width;
    const ds = Math.abs(x - sx), de = Math.abs(x - ex);
    if (ds < 9 && ds <= de) return 'start';
    if (de < 9) return 'end';
    return null;
  };
  const redraw = (s) => {
    drawWave(state.buffers.get(state.sel), s);
    renderPoints(s);
  };

  wave.addEventListener('pointerdown', ev => {
    const s = sel();
    if (!s) return;
    const m = nearMarker(ev, s);
    if (!m) return;
    dragging = m;
    wave.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  wave.addEventListener('pointermove', ev => {
    const s = sel();
    if (!s) return;
    if (!dragging) {
      wave.style.cursor = nearMarker(ev, s) ? 'ew-resize' : '';
      return;
    }
    const f = frameAt(ev, s);
    if (dragging === 'start') s.start = Math.min(f, s.end - 1);
    else s.end = Math.max(f, s.start + 1);
    redraw(s);
  });
  wave.addEventListener('pointerup', async ev => {
    if (!dragging) return;
    dragging = null;
    const i = state.sel, s = slotData(i);
    try {
      await api(`/api/sample/${i}/points`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: s.start, end: s.end }),
      });
      tick(`→ S${i + 1} points ${s.start.toLocaleString()}…${s.end.toLocaleString()}`);
    } catch (e) { tick(`⚠ points failed: ${e.message}`); }
  });
}

// ───────────────────────────────────────────────────────────── audition ──
$('#audition-btn').onclick = () => {
  if (state.sel == null) return;
  const buf = state.buffers.get(state.sel);
  if (!buf) return;
  if (state.playing) { try { state.playing.stop(); } catch { } state.playing = null; return; }
  const src = state.audio.createBufferSource();
  src.buffer = buf;
  src.connect(state.audio.destination);
  src.onended = () => { state.playing = null; cap.textContent = '▶ PLAY'; };
  const cap = $('#audition-btn .hw-btn-cap');
  cap.textContent = '■ STOP';
  // honor the START/END points like the hardware does. Points are DEVICE
  // frames; decodeAudioData may have resampled, so map proportionally.
  const s = slotData(state.sel);
  const total = s.frames || Math.round(buf.duration * (s.rate_hz || 48000));
  const t0 = Math.max(0, (s.start / total) * buf.duration);
  const t1 = Math.min(buf.duration, ((s.end + 2) / total) * buf.duration);
  src.start(0, t0, Math.max(0.01, t1 - t0));
  state.playing = src;
};

// keep the waveform crisp on window resizes
addEventListener('resize', () => {
  if (state.sel != null && state.buffers.has(state.sel))
    drawWave(state.buffers.get(state.sel), slotData(state.sel));
});
