// Browser-side audio tools for the upload dialog: decode a PCM WAV to float
// channels, optionally convert channels / trim silence / normalize / gain /
// fade, then re-encode a 16-bit PCM WAV the bridge accepts (it resamples to the
// nearest device rate itself). Pure functions, no DOM — unit-tested in plain
// node (test/audioTools.test.mjs; `npm test`).

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

// ── slicing (auto-slice one sample across several pads) ────────────────────
const SLICE_FADE_IN_MS = 2;     // de-click slice head (short — keeps the attack)
const SLICE_FADE_OUT_MS = 5;    // de-click slice tail

// Onset detection for transient slicing: an RMS "flux" novelty over ~10 ms
// windows; keep windows whose rise peaks above a sensitivity-scaled threshold,
// with a minimum gap between hits. Returns segment START frames, always
// beginning at 0. Best-effort — the UI offers equal slicing as the fallback.
function detectOnsets(src, sensitivity, minMs) {
  const rate = src.rate, ch = src.channels, frames = ch[0].length;
  const hop = Math.max(1, Math.round(rate * 0.01));
  const nW = Math.ceil(frames / hop);
  const env = new Float32Array(nW);
  for (let w = 0; w < nW; w++) {
    let e = 0; const s = w * hop, end = Math.min(frames, s + hop);
    for (let i = s; i < end; i++) for (const c of ch) e += c[i] * c[i];
    env[w] = Math.sqrt(e / Math.max(1, (end - s) * ch.length));
  }
  const flux = new Float32Array(nW);
  let mx = 0;
  for (let w = 1; w < nW; w++) {
    flux[w] = Math.max(0, env[w] - env[w - 1]);
    if (flux[w] > mx) mx = flux[w];
  }
  if (mx <= 0) return [0];
  // higher sensitivity → lower threshold → more hits. The low end is
  // deliberately steep so minimum sensitivity yields very few slices (only the
  // strongest onsets survive).
  const thr = mx * (0.55 * (1 - sensitivity) + 0.03);
  const minGap = Math.max(1, Math.round(rate * minMs / 1000 / hop));
  const starts = [0];
  let last = -minGap;
  for (let w = 1; w < nW - 1; w++) {
    if (flux[w] >= thr && flux[w] >= flux[w - 1] && flux[w] > flux[w + 1]
        && w - last >= minGap) {
      starts.push(w * hop); last = w;
    }
  }
  return starts;
}

// Cut a decoded buffer into segments. spec:
//   { mode:'equal', count:N }                       → N equal-length pieces
//   { mode:'transient', sensitivity:0..1, minMs }   → cut at detected onsets
// Each segment is de-clicked (short raised-cosine at both edges) so the hard
// cut doesn't pop. Pure: returns an array of fresh { channels, rate }.
export function sliceBuffer(src, spec) {
  const frames = src.channels[0].length;
  let starts;
  if (spec.mode === 'transient') {
    starts = detectOnsets(src, spec.sensitivity == null ? 0.5 : spec.sensitivity,
                          spec.minMs || 60);
  } else {
    const n = Math.max(1, spec.count | 0);
    starts = [];
    for (let i = 0; i < n; i++) starts.push(Math.round(i * frames / n));
  }
  const segs = [];
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i], b = i + 1 < starts.length ? starts[i + 1] : frames;
    if (b <= a) continue;
    const chans = src.channels.map(c => c.slice(a, b));
    const len = chans[0].length, half = Math.floor(len / 2);
    const fi = Math.min(Math.round(src.rate * SLICE_FADE_IN_MS / 1000), half);
    const fo = Math.min(Math.round(src.rate * SLICE_FADE_OUT_MS / 1000), half);
    for (const c of chans) {
      for (let j = 0; j < fi; j++) c[j] *= rcos(j, fi);
      for (let j = 0; j < fo; j++) c[len - 1 - j] *= rcos(j, fo);
    }
    segs.push({ channels: chans, rate: src.rate });
  }
  return segs;
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
