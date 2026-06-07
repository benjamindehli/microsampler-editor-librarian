// microSAMPLER Editor — sample edit page.
// Talks to the local bridge (same origin). Live edits = POST /api/param with
// the hardware-verified 3-value Parameter Change (obj = 16 + slot).
import { VALUE_TABLES } from './valueTables.js';
import { FX_TYPES, FX_TABLES_EXTRA } from './fxData.js';

const $ = s => document.querySelector(s);
// Live-edit param ids — HARDWARE-CONFIRMED 2026-06-06 by panel-knob capture
// (the editor binary's converter table did NOT match the device's actual
// panel id scheme for the level/pan/semitone/tune/velo cluster — the device
// is authoritative). START/END are NOT live params (u32 frames > 14 bits);
// they're set via the param blob — see the waveform marker dragging.
const PARAM = {
  LOOP: 16, BPM_SYNC: 17, REVERSE: 18,
  DECAY: 21, RELEASE: 22, LEVEL: 24, PAN: 25, FX_SW: 26,
  SEMITONE: 27, TUNE: 28, VELO_INT: 29,
};
const AMP_LEVEL = VALUE_TABLES.AmpLevel || [];
const fmtSigned = v => (v > 0 ? '+' : '') + v;
const fmtPan = v => v === 64 ? 'CNT' : (v < 64 ? `L${64 - v}` : `R${v - 64}`);
const fmtLevel = v => AMP_LEVEL[v] || String(v);

// Semitone/Velo Int travel as two's-complement 14-bit (signed model space on
// the slider; only RECEIVE needs decoding — pack14 handles the send side).
const BIPOLAR = new Set([PARAM.SEMITONE, PARAM.VELO_INT]);
const dec14 = v => (v >= 8192 ? v - 16384 : v);

// TUNE: 0..127 wire → −99..+99 cents, fully decoded from hardware (2026-06-06,
// exact at 35 measured points). The fine region is two linear halves around a
// centre detent — negative HW = wire−62, positive HW = wire−66, with wire
// 62..66 all reading 0 — and the panel's coarse settings step by 5 out to ±99.
function tuneCents(w) {
  if (w <= 2) return -99;
  if (w < 12) return -50 - (12 - w) * 5;    // wire 3..11   → −95..−55
  if (w < 62) return w - 62;                // wire 12..61  → −50..−1
  if (w <= 66) return 0;                     // centre detent
  if (w <= 116) return w - 66;              // wire 67..116 → +1..+50
  if (w >= 126) return 99;
  return 50 + (w - 116) * 5;                // wire 117..125 → +55..+95
}
const tuneDisplay = wire => fmtSigned(tuneCents(wire));
const OBJ_BASE = 16;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const state = {
  bank: null,            // /api/bank payload
  sel: null,             // selected slot index
  buffers: new Map(),    // slot -> AudioBuffer
  audio: null,           // AudioContext
  playing: null,         // current source node
  online: false,
};

// ───────────────────────────────────────────────────────── api helpers ──
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch { /* binary/none */ }
    throw new Error(msg);
  }
  return r;
}
const apiJson = async (path, opts) => (await api(path, opts)).json();

// ─────────────────────────────────────────────────────────── bootstrap ──
async function boot() {
  let st;
  try {
    st = await apiJson('/api/status');
  } catch {
    setOnline(false);                             // bridge truly unreachable
    setTimeout(boot, 2500);                       // auto-reconnect
    return;
  }
  setOnline(true, st);
  subscribeEvents();
  try {
    await refreshBank();
  } catch (e) {
    // bridge is up but the device op failed — stay online, surface the error
    tick(`⚠ bank read failed: ${e.message}`);
    $('#bank-name').textContent = 'ERROR';
    $('#editor-empty').querySelector('p').textContent =
      'BANK READ FAILED — ' + e.message.toUpperCase();
    console.error('bank read failed:', e.message);
  }
}

function setOnline(ok, st) {
  state.online = ok;
  $('#offline').hidden = ok;
  $('#conn-led').className = 'led ' + (ok ? 'ok' : 'err');
  $('#conn-caption').textContent = ok ? 'CONNECTED' : 'OFFLINE';
  $('#mock-badge').hidden = !(ok && st && st.mock);
}

async function refreshBank() {
  const btn = $('#refresh-btn');
  btn.setAttribute('aria-busy', 'true');
  try {
    state.bank = await apiJson('/api/bank');
    $('#bank-name').textContent = (state.bank.name || '--------').padEnd(8);
    $('#bank-bpm').textContent = state.bank.bpm.toFixed(1);
    renderPads();
    renderMeter();
    if (state.sel != null) showSlot(state.sel, { keepWave: true });
    if (state.bank.effect) { fxFromBank(state.bank.effect); renderFx(); }
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

// ─────────────────────────────────────────────────────────────── pads ──
function noteName(slot) {                          // pads are C3..B5 (36 keys)
  const n = 48 + slot;                             // MIDI C3 = 48 (Korg octave)
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

function renderPads() {
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

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ───────────────────────────────────────────────────────── slot editor ──
function slotData(i) { return state.bank.slots[i]; }

async function showSlot(i, { keepWave = false } = {}) {
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

  renderChips(s);

  // controls — initialised from the bank blob (loop/reverse/bpm-sync state
  // isn't in the blob, so those default off until a panel edit reports them)
  setSwitch('#ctl-loop', '#val-loop', false);
  setSwitch('#ctl-reverse', '#val-reverse', false);
  setSeg(0);
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

// ─────────────────────────────────────────────────────── memory meters ──
// Device storage accounting (RE'd from SampleSet/SequenceSet::
// getFreeStorageSize): sample pool 0xEA0000 (14.6 MB), each sample occupies
// frames×channels×2 rounded UP to 32 KB blocks; pattern pool 0x60000
// (384 KB), per-pattern usage = bank-blob seq_lengths[i] × 0x200 (the
// 0x800-block-rounded size). Sample sizes are exact once a slot's WAV has
// been seen (frames+channels known); otherwise estimated from the END point
// assuming stereo, flagged "≈" with a MEASURE button to fetch the rest.
const MEM_SMPL_TOTAL = 0xEA0000;
const MEM_PTRN_TOTAL = 0x60000;
const MEM_BLK = 0x8000;
const memBlk = b => Math.ceil(b / MEM_BLK) * MEM_BLK;

// device bytes a slot occupies: exact once frames+channels are known,
// estimated from the END point (assume stereo) otherwise
function slotDevBytes(s) {
  if (s.empty) return { bytes: 0, est: false };
  if (s.frames && s.stereo != null)
    return { bytes: memBlk(s.frames * (s.stereo ? 2 : 1) * 2), est: false };
  return { bytes: memBlk((s.end + 2) * 2 * 2), est: true };
}

function sampleMemUsage() {
  let used = 0, est = false;
  for (const s of state.bank.slots) {
    const u = slotDevBytes(s);
    used += u.bytes;
    est = est || u.est;
  }
  return { used, est };
}

function renderMeter() {
  if (!state.bank) return;
  $('#mem-block').hidden = false;
  const { used, est } = sampleMemUsage();
  const ptrn = (state.bank.seq_lengths || [])
    .reduce((a, b) => a + b * 0x200, 0);
  setMeter('smpl', used, MEM_SMPL_TOTAL, est);
  setMeter('ptrn', ptrn, MEM_PTRN_TOTAL, false);
  $('#mem-note').hidden = !est;
  $('#mem-measure').hidden = !est;
}

function setMeter(which, used, total, est) {
  const pct = Math.min(100, 100 * used / total);
  const fill = $(`#mem-${which}-fill`);
  fill.style.width = pct.toFixed(1) + '%';
  fill.classList.toggle('warn', pct > 85 && pct < 98);
  fill.classList.toggle('crit', pct >= 98);
  $(`#mem-${which}-val`).textContent =
    `${est ? '≈' : ''}${fmtMem(used)}/${fmtMem(total)}`;
}
const fmtMem = b => b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB'
  : `${Math.round(b / 1024)}KB`;

$('#mem-measure').onclick = async () => {
  const btn = $('#mem-measure');
  btn.disabled = true;
  try {
    for (const s of state.bank.slots) {
      if (s.empty || (s.frames && s.stereo != null)) continue;
      btn.textContent = `READING ${String(s.slot + 1).padStart(2, '0')}…`;
      const wav = await (await api(`/api/sample/${s.slot}.wav`)).arrayBuffer();
      const fmt = wavFormat(wav.slice(0, 44));
      if (fmt) {
        s.rate_hz = fmt.rate;
        s.stereo = fmt.channels === 2;
        s.frames = Math.floor((wav.byteLength - 44) / (fmt.channels * 2));
        s.seconds = s.frames / fmt.rate;
      }
      renderMeter();
      if (state.sel === s.slot) renderChips(s);
    }
    tick('▦ memory measured');
  } catch (e) { tick(`⚠ measure failed: ${e.message}`); }
  btn.textContent = 'MEASURE';
  btn.disabled = false;
};

// Rate/length aren't in the bank blob — they arrive once the WAV is fetched
// (reading headers per slot would strand the device's sample-select state).
function renderPoints(s) {
  const ro = $('#ro-row');
  ro.innerHTML = '';
  if (s.empty) { $('#meta-points').textContent = ''; return; }
  for (const [k, v] of [
    ['START', s.start.toLocaleString()], ['END', s.end.toLocaleString()],
  ]) ro.insertAdjacentHTML('beforeend',
    `<span class="ro">${k} <b>${esc(v)}</b></span>`);
  $('#meta-points').textContent =
    `START ${s.start.toLocaleString()} · END ${s.end.toLocaleString()}`;
}

function renderChips(s) {
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
  if (s.tempo_bpm) pairs.push(['BPM', s.tempo_bpm.toFixed(1)]);
  for (const [k, v] of pairs)
    chips.insertAdjacentHTML('beforeend', `<span class="chip">${k} <b>${v}</b></span>`);
}

function renderMetaFmt(s) {
  $('#meta-fmt').textContent = s.frames
    ? `${s.frames.toLocaleString()} FRAMES · 16-BIT ${s.stereo ? 'STEREO' : 'MONO'}`
    : 'CLICK ▶ PLAY OR WAIT FOR THE WAVEFORM TO LOAD FORMAT DETAILS';
}

function wavFormat(arrayBuf) {
  // minimal RIFF/WAVE fmt reader (LE): channels @22, rate @24
  const dv = new DataView(arrayBuf);
  if (dv.getUint32(0, false) !== 0x52494646) return null;     // 'RIFF'
  return { channels: dv.getUint16(22, true), rate: dv.getUint32(24, true) };
}

// ───────────────────────────────────────────────────────────── waveform ──
async function loadWave(i) {
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

function drawWave(buf, s) {
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

// ─────────────────────────────────────────────────────── param controls ──
async function sendParam(param, value) {
  if (state.sel == null) return;
  flash(param);
  try {
    await api('/api/param', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ obj: OBJ_BASE + state.sel, param, value }),
    });
    tick(`→ S${state.sel + 1} #${param} = ${value}`);
  } catch (e) { tick(`⚠ send failed: ${e.message}`); }
}

function flash(param) {
  const el = document.querySelector(`[data-flash="${param}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;                           // restart transition
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

// toggle switches
function wireSwitch(btnSel, valSel, param) {
  const btn = $(btnSel);
  btn.onclick = () => {
    const on = btn.getAttribute('aria-checked') !== 'true';
    setSwitch(btnSel, valSel, on);
    sendParam(param, on ? 1 : 0);
  };
}
function setSwitch(btnSel, valSel, on) {
  $(btnSel).setAttribute('aria-checked', String(on));
  $(valSel).textContent = on ? 'ON' : 'OFF';
}
wireSwitch('#ctl-loop', '#val-loop', PARAM.LOOP);
wireSwitch('#ctl-reverse', '#val-reverse', PARAM.REVERSE);

// BPM Sync segmented switch (device rule: Pitch Change locks Tune)
$('#ctl-sync').querySelectorAll('button').forEach(b => {
  b.onclick = () => { setSeg(+b.dataset.v); sendParam(PARAM.BPM_SYNC, +b.dataset.v); };
});
function setSeg(v) {
  $('#ctl-sync').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', +b.dataset.v === v));
  // device rule: Pitch Change disables Tune AND Semitone
  $('#tune-block').classList.toggle('locked', v === 2);
  $('#semitone-block').classList.toggle('locked', v === 2);
}

// faders — `fmt` (optional) maps the 0..127 byte to a display string
function wireFader(inSel, valSel, param, fmt) {
  const input = $(inSel);
  input.oninput = () => setFader(inSel, valSel, +input.value, fmt);
  input.onchange = () => sendParam(param, +input.value);
}
function setFader(inSel, valSel, v, fmt) {
  $(inSel).value = v;
  $(valSel).textContent = fmt ? fmt(v) : String(v);
}
wireFader('#ctl-decay', '#val-decay', PARAM.DECAY);
wireFader('#ctl-release', '#val-release', PARAM.RELEASE);
wireFader('#ctl-tune', '#val-tune', PARAM.TUNE, tuneDisplay);
wireFader('#ctl-level', '#val-level', PARAM.LEVEL, fmtLevel);
wireFader('#ctl-pan', '#val-pan', PARAM.PAN, fmtPan);
wireFader('#ctl-semitone', '#val-semitone', PARAM.SEMITONE, fmtSigned);
wireFader('#ctl-velo', '#val-velo', PARAM.VELO_INT, fmtSigned);
wireSwitch('#ctl-fx', '#val-fx', PARAM.FX_SW);

// ──────────────────────────────────────────────────────────── SSE feed ──
function subscribeEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    const evt = JSON.parse(e.data);
    if (evt.type === 'op' || evt.type === 'op_done') return onOpEvent(evt);
    if (evt.type === 'cc') return onCC(evt);
    if (evt.type !== 'parameter_change') return;
    const isFx = evt.obj === FX_OBJ;
    const who = evt.sample != null ? `S${evt.sample + 1}`
      : isFx ? 'FX' : `obj${evt.obj}`;
    const shown = isFx ? fmtSigned(dec14(evt.value))
      : BIPOLAR.has(evt.param) ? fmtSigned(dec14(evt.value))
      : evt.param === PARAM.TUNE ? tuneDisplay(evt.value)
      : evt.value;
    tick(`← ${who} #${evt.param} = ${shown}`);
    if (evt.sample === state.sel) reflect(evt.param, evt.value);
    if (isFx) fxReflect(evt.param, evt.value);
  };
  es.onerror = () => { /* EventSource retries on its own */ };
}

function reflect(param, value) {
  flash(param);
  if (BIPOLAR.has(param)) value = dec14(value);   // two's-complement 14-bit
  switch (param) {
    case PARAM.LOOP: setSwitch('#ctl-loop', '#val-loop', !!value); break;
    case PARAM.REVERSE: setSwitch('#ctl-reverse', '#val-reverse', !!value); break;
    case PARAM.BPM_SYNC: setSeg(value); break;
    case PARAM.DECAY: setFader('#ctl-decay', '#val-decay', value); break;
    case PARAM.RELEASE: setFader('#ctl-release', '#val-release', value); break;
    case PARAM.TUNE: setFader('#ctl-tune', '#val-tune', value, tuneDisplay); break;
    case PARAM.SEMITONE: setFader('#ctl-semitone', '#val-semitone', value, fmtSigned); break;
    case PARAM.LEVEL: setFader('#ctl-level', '#val-level', value, fmtLevel); break;
    case PARAM.PAN: setFader('#ctl-pan', '#val-pan', value, fmtPan); break;
    case PARAM.VELO_INT: setFader('#ctl-velo', '#val-velo', value, fmtSigned); break;
    case PARAM.FX_SW: setSwitch('#ctl-fx', '#val-fx', !!value); break;
  }
}

let tickerTimer;
function tick(text) {
  const log = $('#ticker-log');
  const prev = log.textContent.slice(0, 220);
  const b = document.createElement('b');
  b.textContent = text;                 // DOM nodes, not innerHTML — old
  log.replaceChildren(b, `  ${prev}`);  // entries must never round-trip
  const led = $('#ticker-led');         // back in as markup (CodeQL js/xss)
  led.classList.add('blip');
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => led.classList.remove('blip'), 250);
}

// ────────────────────────────────────────────────────────────── upload ──
function openUpload(file) {
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
    state.buffers.delete(state.sel);
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

// rename (param-blob write: name bytes 0..7 + long name 0x20..0x3f)
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

// drag & drop onto the editor panel
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

// ──────────────────────────────────────────────────────── effect view ──
// Bank effect = object 80. Wire ids: param 1 = FX type, 2-3 = the two
// assignable-knob targets, 16+i = effect param i. Wire VALUE = display
// value (negatives travel as signed 14-bit, like sample params); the bank
// blob stores byte = display + descriptor center.
const FX_OBJ = 80;
state.fx = null;                       // {type, knobs:[a,b], vals:[..32]}

// numeric formatters for the computed display "tables"
const FX_FMT = {
  PercentValue: v => `${v}%`,
  MsecValue: v => `${v}ms`,
  FxdBValue: v => `${(v / 2).toFixed(1)}dB`,     // ±36 raw = ±18.0 dB
  FxEqQ: v => (0.5 + v * 0.1).toFixed(1),
  FxWetDry: v => v === 0 ? 'Dry' : v === 100 ? 'Wet' : `${100 - v}:${v}`,
  FxFineValue: v => `${fmtSigned(v)}c`,
  FxVoiceCtrl: v => fmtSigned(v),
  FxLfoSpread: v => fmtSigned(v),
};
function fxValStr(p, v) {
  const t = VALUE_TABLES[p.table] || FX_TABLES_EXTRA[p.table];
  if (t && t.length) return t[v - p.min] ?? String(v);
  const f = FX_FMT[p.table];
  if (f) return f(v);
  return p.min < 0 ? fmtSigned(v) : String(v);
}

const fxDesc = () => FX_TYPES[state.fx?.type] || FX_TYPES[0];
const clampDef = p => Math.max(p.min, Math.min(p.max,
  p.def > p.max ? p.def - p.center : p.def));   // a few defs are byte-space

function fxFromBank(e) {
  // blob bytes -> display values via the current type's descriptor centers
  const fx = FX_TYPES[e.type] || FX_TYPES[0];
  const vals = new Array(32).fill(0);
  for (const p of fx.params) vals[p.idx] = (e.params[p.idx] ?? 0) - p.center;
  state.fx = { type: e.type, knobs: [...e.knobs], vals };
}

function fxDefaults(type) {
  const vals = new Array(32).fill(0);
  for (const p of (FX_TYPES[type] || FX_TYPES[0]).params)
    vals[p.idx] = clampDef(p);
  return vals;
}

async function sendFx(param, value) {
  try {
    await api('/api/param', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ obj: FX_OBJ, param, value }),
    });
    tick(`→ FX #${param} = ${value}`);
  } catch (e) { tick(`⚠ fx send failed: ${e.message}`); }
}

function renderFx() {
  if (!state.fx) return;
  const fx = fxDesc();
  $('#fx-type').innerHTML = FX_TYPES.map((f, i) =>
    `<option value="${i}"${i === state.fx.type ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
  const grid = $('#fx-params');
  grid.innerHTML = fx.params.length ? '' :
    '<p class="backup-empty">EFFECT OFF — NO PARAMETERS</p>';
  for (const p of fx.params) {
    const v = state.fx.vals[p.idx];
    const div = document.createElement('div');
    div.className = 'ctl fx-param';
    div.dataset.fxp = p.idx;
    if (p.type === 3) {                          // popup select
      const t = VALUE_TABLES[p.table] || FX_TABLES_EXTRA[p.table] || [];
      div.innerHTML = `<span class="ctl-label">${esc(p.name)}</span>
        <select class="fx-select">${Array.from({ length: p.max - p.min + 1 }, (_, i) =>
          `<option value="${p.min + i}"${p.min + i === v ? ' selected' : ''}>${esc(t[i] ?? String(p.min + i))}</option>`).join('')}</select>`;
      div.querySelector('select').onchange = ev =>
        fxSet(p, +ev.target.value);
    } else if (p.type === 4) {                   // on/off switch
      div.innerHTML = `<span class="ctl-label">${esc(p.name)}</span>
        <button class="switch" role="switch" aria-checked="${v ? 'true' : 'false'}">
          <span class="switch-track"><span class="switch-knob"></span></span>
          <span class="switch-val">${v ? 'ON' : 'OFF'}</span>
        </button>`;
      div.querySelector('button').onclick = () =>
        fxSet(p, state.fx.vals[p.idx] ? 0 : 1);
    } else {                                     // knob/slider
      const center = p.min < 0 ? ' center' : '';
      div.innerHTML = `<span class="ctl-label">${esc(p.name)}</span>
        <input type="range" class="fader${center}" min="${p.min}" max="${p.max}" value="${v}">
        <span class="ctl-val">${esc(fxValStr(p, v))}</span>`;
      const inp = div.querySelector('input');
      inp.oninput = () => {
        div.querySelector('.ctl-val').textContent = fxValStr(p, +inp.value);
      };
      inp.onchange = () => fxSet(p, +inp.value);
    }
    grid.append(div);
  }
  applyFxEnable();
}

function fxSet(p, value) {
  state.fx.vals[p.idx] = value;
  sendFx(16 + p.idx, value);
  fxUpdateControl(p.idx);
  applyFxEnable();
}

function fxUpdateControl(idx) {
  const div = document.querySelector(`#fx-params [data-fxp="${idx}"]`);
  if (!div) return;
  const p = fxDesc().params.find(q => q.idx === idx);
  const v = state.fx.vals[idx];
  const sel = div.querySelector('select');
  const inp = div.querySelector('input');
  const btn = div.querySelector('button');
  if (sel) sel.value = String(v);
  if (inp) {
    inp.value = v;
    div.querySelector('.ctl-val').textContent = fxValStr(p, v);
  }
  if (btn) {
    btn.setAttribute('aria-checked', v ? 'true' : 'false');
    btn.querySelector('.switch-val').textContent = v ? 'ON' : 'OFF';
  }
}

// conditional graying, straight from the firmware's isEnable rules
const FX_PRED = { eq0: v => v === 0, ne0: v => v !== 0,
                  le3: v => v <= 3, gt3: v => v > 3 };
function fxEnabledMap() {
  const fx = fxDesc();
  const enabled = {};
  for (const p of fx.params) enabled[p.idx] = true;
  for (const r of fx.rules)
    enabled[r.p] = FX_PRED[r.when](state.fx.vals[r.cond]);
  return enabled;
}

// firmware setKnobAssign behavior: a knob target always SNAPS to the
// currently-ACTIVE member of a swap pair (Reverb Time long/short, LFO
// Frequency/Sync Note, delay Time-Ratio pairs…). The device does the same
// internally when the physical knob is used; assigning the inactive twin
// explicitly makes the device display INVALID — so the app never offers it.
function fxSnapKnob(idx) {
  for (const s of fxDesc().swaps) {
    const on = FX_PRED[s.when](state.fx.vals[s.cond]);
    if (on && idx === s.off) return s.on;
    if (!on && idx === s.on) return s.off;
  }
  return idx;
}

function renderFxKnobs() {
  const fx = fxDesc();
  const seen = new Set();
  const opts = [];
  for (const p of fx.params) {
    if (!p.knob) continue;
    const idx = fxSnapKnob(p.idx);
    if (seen.has(idx)) continue;
    seen.add(idx);
    opts.push(fx.params.find(q => q.idx === idx));
  }
  for (const k of [0, 1]) {
    const sel = $(k ? '#fx-knob2' : '#fx-knob1');
    const cur = fxSnapKnob(state.fx.knobs[k]);
    const html = opts.map(p =>
      `<option value="${p.idx}"${p.idx === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;   // don't disturb an
    sel.disabled = !opts.length;                        // open dropdown
  }
}

function applyFxEnable() {
  const fx = fxDesc();
  const enabled = fxEnabledMap();
  for (const div of document.querySelectorAll('#fx-params .fx-param')) {
    const idx = +div.dataset.fxp;
    const on = enabled[idx] !== false;
    div.classList.toggle('locked', !on);
    div.querySelectorAll('input,select,button').forEach(el => el.disabled = !on);
    // in-place swap pairs (Reverb Time long/short, delay ms-vs-sync-note):
    // a disabled param whose same-named twin is enabled is HIDDEN outright —
    // the hardware and original GUI only ever show the active one.
    const p = fx.params.find(q => q.idx === idx);
    div.hidden = !on && fx.params.some(q =>
      q.idx !== idx && q.name === p.name && enabled[q.idx] !== false);
  }
  renderFxKnobs();        // active swap twins may have changed
}

$('#fx-type').onchange = ev => {
  const t = +ev.target.value;
  state.fx.type = t;
  state.fx.vals = fxDefaults(t);       // device re-inits its params on type
  const fx = FX_TYPES[t];              // change — mirror with the defaults
  state.fx.knobs = [...fx.knobs];
  sendFx(1, t);
  renderFx();
};
for (const k of [0, 1])
  $(k ? '#fx-knob2' : '#fx-knob1').onchange = ev => {
    state.fx.knobs[k] = +ev.target.value;
    sendFx(2 + k, +ev.target.value);
  };

// The panel's FX EDIT 1/2 knobs transmit plain MIDI CC (Korg's Effect
// Control 1/2 = CC#12/13), not SysEx — map them onto the assigned params.
// The 0..127 CC sweep covers the param's full display range.
const FX_KNOB_CC = [12, 13];
function onCC(evt) {
  const k = FX_KNOB_CC.indexOf(evt.cc);
  if (k < 0) { tick(`← CC#${evt.cc} = ${evt.value}`); return; }
  if (!state.fx) return;
  // the device applies the knob to the ACTIVE swap twin — mirror that
  const idx = fxSnapKnob(state.fx.knobs[k]);
  const p = fxDesc().params.find(q => q.idx === idx);
  if (!p) return;
  const v = p.min + Math.round(evt.value * (p.max - p.min) / 127);
  state.fx.vals[idx] = v;
  tick(`← FX KNOB${k + 1} ${p.name} = ${fxValStr(p, v)}`);
  fxUpdateControl(idx);
  applyFxEnable();
}

function fxReflect(param, value) {
  if (!state.fx) return;
  value = dec14(value);
  if (param === 1) {
    state.fx.type = value;
    state.fx.vals = fxDefaults(value);
    state.fx.knobs = [...(FX_TYPES[value] || FX_TYPES[0]).knobs];
    renderFx();
  } else if (param === 2 || param === 3) {
    state.fx.knobs[param - 2] = value;
    renderFx();
  } else if (param >= 16 && param <= 47) {
    state.fx.vals[param - 16] = value;
    fxUpdateControl(param - 16);
    applyFxEnable();
  }
}

// ─────────────────────────────────────────────────────── utility view ──
function showView(name) {
  document.querySelectorAll('.view-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.view === name));
  $('#view-samples').hidden = name !== 'samples';
  $('#view-effect').hidden = name !== 'effect';
  $('#view-patterns').hidden = name !== 'patterns';
  $('#view-utility').hidden = name !== 'utility';
  if (name === 'utility') loadBackups().catch(() => { });
  if (name === 'effect') renderFx();
}
document.querySelectorAll('.view-btn').forEach(b =>
  b.onclick = () => showView(b.dataset.view));

async function loadBackups() {
  const { backups } = await apiJson('/api/backups');
  const list = $('#backup-list');
  list.innerHTML = '';
  if (!backups.length) {
    list.innerHTML = '<p class="backup-empty">NO BACKUPS YET — MAKE ONE ←</p>';
    return;
  }
  for (const b of backups) {
    const row = document.createElement('div');
    row.className = 'backup-row';
    row.innerHTML =
      `<span class="b-name">${esc(b.name)}</span>
       <span class="b-meta">${esc(b.dir)} · ${b.samples} SAMPLES · ${b.patterns} PATTERNS</span>
       <span class="spacer"></span>`;
    const btn = document.createElement('button');
    btn.className = 'hw-btn';
    btn.innerHTML = '<span class="hw-btn-cap">RESTORE…</span>';
    btn.onclick = () => openRestore(b);
    row.append(btn);
    list.append(row);
  }
}

let opRunning = false;
function setOpRunning(on) {
  opRunning = on;
  for (const sel of ['#backup-btn', '#refresh-btn'])
    $(sel).toggleAttribute('aria-busy', on);
  document.querySelectorAll('#backup-list .hw-btn')
    .forEach(b => b.toggleAttribute('aria-busy', on));
}
function opPrint(line, { reset = false, err = false } = {}) {
  const con = $('#op-console');
  if (reset) con.textContent = '';
  con.classList.toggle('err', err);
  con.textContent += (con.textContent ? '\n' : '') + line;
  con.scrollTop = con.scrollHeight;
}

$('#backup-btn').onclick = async () => {
  if (opRunning) return;
  opPrint('starting backup…', { reset: true });
  setOpRunning(true);
  try { await apiJson('/api/backup', { method: 'POST' }); }
  catch (e) { opPrint('ERROR: ' + e.message, { err: true }); setOpRunning(false); }
};

function openRestore(b) {
  const dlg = $('#restore-dialog');
  $('#rd-name').textContent = `${b.name} (${b.dir})`;
  $('#rd-warning').textContent =
    `⚠ Writes ${b.samples} samples + ${b.patterns} patterns to the device, ` +
    `OVERWRITING the chosen target.`;
  dlg.showModal();
  $('#rd-ok').onclick = async e => {
    e.preventDefault();
    dlg.close();
    const v = $('#rd-target').value;
    const bank = v === '' ? null : +v;
    opPrint(`starting restore of ${b.dir}…`, { reset: true });
    setOpRunning(true);
    try {
      await apiJson('/api/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: b.dir, bank }),
      });
    } catch (err2) {
      opPrint('ERROR: ' + err2.message, { err: true });
      setOpRunning(false);
    }
  };
}

function onOpEvent(evt) {
  if (evt.type === 'op') opPrint(evt.line);
  if (evt.type === 'op_done') {
    opPrint(evt.ok ? `✓ ${evt.name} finished` : `✗ ${evt.name} FAILED`,
            { err: !evt.ok });
    setOpRunning(false);
    loadBackups().catch(() => { });
    if (evt.name === 'restore' && evt.ok) refreshBank().catch(() => { });
    tick(`${evt.ok ? '✓' : '✗'} ${evt.name} ${evt.ok ? 'complete' : 'failed'}`);
  }
}

// ─────────────────────────────────────────────────────── patterns view ──
async function loadPatterns() {
  const btn = $('#patterns-refresh');
  btn.setAttribute('aria-busy', 'true');
  $('#pattern-grid').innerHTML =
    '<p class="backup-empty">READING 16 PATTERNS FROM THE DEVICE…</p>';
  try {
    const { patterns } = await apiJson('/api/patterns');
    renderPatterns(patterns);
    tick('✓ received 16 patterns');
  } catch (e) {
    $('#pattern-grid').innerHTML =
      `<p class="backup-empty">PATTERN READ FAILED — ${esc(e.message.toUpperCase())}</p>`;
    tick('⚠ patterns: ' + e.message);
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

function renderPatterns(patterns) {
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
  // bar grid
  g.strokeStyle = 'rgba(255,138,30,.14)';
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
    g.fillStyle = ch ? '#ffe9c9' : '#ff8a1e';
    g.shadowColor = ch ? 'rgba(255,233,201,.6)' : 'rgba(255,138,30,.7)';
    g.globalAlpha = .4 + (vel / 127) * .6;
    g.fillRect(x, y, w, 3 * dpr);
  }
  g.globalAlpha = 1;
}

function importPatternSmf(q) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mid,.midi,audio/midi';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    if (!confirm(`Import "${f.name}" into PATTERN ${q + 1}?\n\n` +
                 `OVERWRITES that pattern in the device's current bank (RAM). ` +
                 `Notes on MIDI ch 1 → sample-mode track (pads by note), ` +
                 `other channels → keyboard-mode track.`)) return;
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
  if (!confirm(`Reset PATTERN ${q + 1} to the factory INIT pattern` +
               (recorded ? ' — its recorded notes will be LOST (RAM)' : '') +
               '?')) return;
  try {
    await apiJson(`/api/pattern/${q}/init`, { method: 'POST' });
    tick(`pattern ${q + 1} initialized`);
    await loadPatterns();
  } catch (e) { tick(`⚠ init failed: ${e.message}`); }
}

$('#patterns-refresh').onclick = () => loadPatterns();

// ─────────────────────────────────────────────────────────────── misc ──
$('#refresh-btn').onclick = () => refreshBank().catch(e => tick('⚠ ' + e.message));
addEventListener('resize', () => {
  if (state.sel != null && state.buffers.has(state.sel))
    drawWave(state.buffers.get(state.sel), slotData(state.sel));
});

boot();
