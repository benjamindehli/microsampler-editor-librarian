// Browser-side audio tools for the upload dialog: decode a PCM WAV to float
// channels, optionally convert channels / trim silence / normalize / gain /
// fade, then re-encode a 16-bit PCM WAV the bridge accepts (it resamples to the
// nearest device rate itself). Pure functions, no DOM — they unit-test in plain
// node (see test below; run `node web-editor/js/audioTools.js`).

// Decode a PCM RIFF/WAVE → { channels: [Float32Array…], rate }. Handles the
// same shapes the bridge does (native-tools/upload.py): 8/16/24/32-bit integer
// PCM, mono or stereo. Returns null for anything else (float WAV, >2ch,
// malformed) so the caller falls back to sending the original bytes untouched.
export function decodeWavPcm(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 44) return null;
  if (dv.getUint32(0) !== 0x52494646 || dv.getUint32(8) !== 0x57415645) return null;
  let off = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off), size = dv.getUint32(off + 4, true);
    if (id === 0x666d7420) {                       // "fmt "
      fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true),
              rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    } else if (id === 0x64617461) {                // "data"
      dataOff = off + 8; dataLen = size; break;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || fmt.format !== 1) return null;       // PCM only
  const { channels, rate, bits } = fmt;
  if (![1, 2].includes(channels) || ![8, 16, 24, 32].includes(bits)) return null;
  const bytes = bits >> 3, frameBytes = channels * bytes;
  const frames = Math.floor(Math.min(dataLen, dv.byteLength - dataOff) / frameBytes);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + f * frameBytes + c * bytes;
      let v;
      if (bits === 8) v = (dv.getUint8(p) - 128) / 128;             // 8-bit unsigned
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 0x800000;
      } else v = dv.getInt32(p, true) / 0x80000000;                 // 32-bit int
      out[c][f] = v;
    }
  }
  return { channels: out, rate };
}

const DECLICK_IN_MS = 5;    // de-click fade on a trimmed start (kept short)
const DECLICK_OUT_MS = 10;  // de-click fade on a trimmed end
const TRIM_REL_DB = 66;     // "silence" = this far below the sample's own peak…
const TRIM_FLOOR_DB = -84;  // …but never treat anything above this as silence

// raised-cosine ramp 0→1 over n samples — smooth at both ends, so a fade to/from
// zero leaves no slope discontinuity (a linear ramp can still tick audibly).
const rcos = (i, n) => 0.5 - 0.5 * Math.cos(Math.PI * i / n);

// True when at least one tool would alter the audio (else send the file as-is).
export function toolsActive(o) {
  return o.channels !== 'keep' || o.normalize || !!o.gainDb || o.trim ||
         (o.fadeInMs | 0) > 0 || (o.fadeOutMs | 0) > 0;
}

// Apply the selected tools. Pure: returns a fresh { channels, rate }; never
// mutates the source. Order: channel convert → trim → normalize → gain → fade.
export function processBuffer(src, o) {
  let chans = src.channels.slice();
  const rate = src.rate;

  // 1. channel conversion
  if (o.channels === 'mono' && chans.length === 2) {
    const n = chans[0].length, m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = (chans[0][i] + chans[1][i]) * 0.5;
    chans = [m];
  } else if (o.channels === 'stereo' && chans.length === 1) {
    chans = [chans[0], chans[0].slice()];
  }

  // 2. trim leading/trailing silence, then de-click the cut edge(s): a hard cut
  //    at a non-zero sample is an instantaneous amplitude step → an audible pop,
  //    so each trimmed edge gets a raised-cosine fade. The silence threshold is
  //    RELATIVE to the sample's own peak (with an absolute floor) so a quiet
  //    sample isn't cut into the middle of its sound.
  if (o.trim) {
    const n = chans[0].length;
    let peak = 0;
    for (const c of chans) for (let i = 0; i < n; i++) {
      const a = Math.abs(c[i]); if (a > peak) peak = a;
    }
    const thr = o.trimDb != null
      ? Math.pow(10, o.trimDb / 20)                // explicit absolute (tests)
      : Math.max(peak * Math.pow(10, -TRIM_REL_DB / 20),
                 Math.pow(10, TRIM_FLOOR_DB / 20));
    const loud = i => chans.some(c => Math.abs(c[i]) >= thr);
    let lo = 0, hi = n - 1;
    while (lo < n && !loud(lo)) lo++;
    while (hi > lo && !loud(hi)) hi--;
    if (lo >= n) { lo = 0; hi = 0; }               // fully silent → keep 1 frame
    const cutHead = lo > 0, cutTail = hi < n - 1;
    if (cutHead || cutTail) {
      chans = chans.map(c => c.slice(lo, hi + 1));
      const len = chans[0].length;
      const half = Math.floor(len / 2);
      const dzIn = Math.min(Math.round(rate * DECLICK_IN_MS / 1000), half);
      const dzOut = Math.min(Math.round(rate * DECLICK_OUT_MS / 1000), half);
      for (const c of chans) {
        if (cutHead) for (let i = 0; i < dzIn; i++) c[i] *= rcos(i, dzIn);
        if (cutTail) for (let i = 0; i < dzOut; i++) c[len - 1 - i] *= rcos(i, dzOut);
      }
    }
  }

  // 3. normalize peak to target dBFS
  if (o.normalize) {
    let peak = 0;
    for (const c of chans) for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]); if (a > peak) peak = a;
    }
    if (peak > 0) chans = scale(chans, Math.pow(10, (o.normalizeDb == null ? -0.1 : o.normalizeDb) / 20) / peak);
  }

  // 4. gain (dB)
  if (o.gainDb) chans = scale(chans, Math.pow(10, o.gainDb / 20));

  // 5. linear fades
  const fi = Math.min(chans[0].length, Math.round((o.fadeInMs || 0) * rate / 1000));
  const fo = Math.min(chans[0].length, Math.round((o.fadeOutMs || 0) * rate / 1000));
  if (fi > 0 || fo > 0) {
    chans = chans.map(c => {
      const out = c.slice(), n = out.length;
      for (let i = 0; i < fi; i++) out[i] *= rcos(i, fi);
      for (let i = 0; i < fo; i++) out[n - 1 - i] *= rcos(i, fo);
      return out;
    });
  }
  return { channels: chans, rate };
}

function scale(chans, g) {
  return chans.map(c => {
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i] * g;
    return out;
  });
}

// Encode float channels → a 16-bit PCM little-endian WAV (what the bridge's
// Python `wave` reader expects; it byteswaps to big-endian for the device).
export function encodeWav(channels, rate) {
  const nch = channels.length, n = channels[0].length;
  const blockAlign = nch * 2, dataLen = n * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, dataLen, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      let v = channels[c][i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      let s = Math.round(v * 32767);
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      dv.setInt16(p, s, true); p += 2;
    }
  }
  return buf;
}

// ── offline self-test (node) ──────────────────────────────────────────────
// Runs only under node; the browser never hits this (no process global).
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].endsWith('audioTools.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
  // build a 2-ch 1000-frame 48k WAV: ch0 a 0.5 ramp, ch1 silence+blip
  const N = 1000, rate = 48000;
  const a = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) { a[i] = (i / N) * 0.5; }
  b[500] = 0.25;
  const wav = encodeWav([a, b], rate);
  const dec = decodeWavPcm(wav);
  assert(dec && dec.channels.length === 2 && dec.channels[0].length === N, 'roundtrip shape');
  assert(Math.abs(dec.channels[0][N - 1] - a[N - 1] * 32767 / 32768) < 1e-3, 'roundtrip value');

  // normalize: peak 0.5 → ~ -0.1 dBFS (≈0.9886)
  const nrm = processBuffer(dec, { channels: 'keep', normalize: true, gainDb: 0,
    trim: false, fadeInMs: 0, fadeOutMs: 0 });
  let peak = 0; for (const c of nrm.channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  assert(Math.abs(peak - Math.pow(10, -0.1 / 20)) < 2e-3, 'normalize to -0.1 dBFS, got ' + peak);

  // mono downmix halves the channel count
  const mono = processBuffer(dec, { channels: 'mono', normalize: false, gainDb: 0,
    trim: false, fadeInMs: 0, fadeOutMs: 0 });
  assert(mono.channels.length === 1, 'mono downmix');

  // gain -6 dB ≈ ×0.501
  const g = processBuffer(dec, { channels: 'keep', normalize: false, gainDb: -6,
    trim: false, fadeInMs: 0, fadeOutMs: 0 });
  assert(Math.abs(g.channels[0][N - 1] / dec.channels[0][N - 1] - 0.5012) < 1e-3, 'gain -6dB');

  // trim: silence outside [1000,5000], constant 0.4 inside → 4001 frames, with
  // the default (relative-to-peak) threshold; cut edges de-clicked to zero and
  // the interior left intact.
  const M = 6000, body = new Float32Array(M);
  for (let i = 1000; i <= 5000; i++) body[i] = 0.4;
  const tr = processBuffer({ channels: [body], rate }, { channels: 'keep', normalize: false,
    gainDb: 0, trim: true, fadeInMs: 0, fadeOutMs: 0 });
  assert(tr.channels[0].length === 4001, 'trim 1000..5000 -> 4001 frames, got ' + tr.channels[0].length);
  assert(tr.channels[0][0] === 0 && tr.channels[0][4000] === 0, 'trim de-clicks both edges to 0');
  assert(Math.abs(tr.channels[0][2000] - 0.4) < 1e-6, 'trim keeps the interior intact');

  // relative threshold: a −54 dBFS tail (below the old fixed −48) is preserved,
  // because the threshold tracks the sample's peak (would be 1500 with −48 dB).
  const q = new Float32Array(2000);
  for (let i = 0; i < 1500; i++) q[i] = 0.5;          // loud body
  for (let i = 1500; i < 1800; i++) q[i] = 0.002;     // ≈ −54 dBFS tail (kept)
  const qt = processBuffer({ channels: [q], rate }, { channels: 'keep', normalize: false,
    gainDb: 0, trim: true, fadeInMs: 0, fadeOutMs: 0 });
  assert(qt.channels[0].length === 1800, 'relative trim keeps the quiet tail, got ' + qt.channels[0].length);

  // fade in zeroes the first sample
  const fd = processBuffer({ channels: [a.slice()], rate }, { channels: 'keep',
    normalize: false, gainDb: 0, trim: false, fadeInMs: 1, fadeOutMs: 0 });
  assert(fd.channels[0][0] === 0, 'fade-in zeroes first sample');

  console.log('audioTools self-test: OK');
}
