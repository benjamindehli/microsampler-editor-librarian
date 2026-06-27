// Unit tests for the pure upload-audio DSP (web-editor/js/audioTools.js).
// Built-in node:test — no deps. Run: node --test test/  (or: npm test)
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeWavPcm, encodeWav, nearestZeroCrossing, processBuffer, sliceBuffer, toolsActive }
  from '../web-editor/functions/audioTools.js';

const RATE = 48000;
const NOOP = { channels: 'keep', normalize: false, trim: false, gainDb: 0,
               fadeInMs: 0, fadeOutMs: 0 };
const peakOf = chans => Math.max(...chans.map(c => Math.max(...c.map(Math.abs))));

test('encode → decode round-trips shape and values (16-bit)', () => {
  const N = 1000;
  const a = Float32Array.from({ length: N }, (_, i) => (i / N) * 0.5);
  const b = new Float32Array(N); b[500] = 0.25;
  const dec = decodeWavPcm(encodeWav([a, b], RATE));
  assert.equal(dec.channels.length, 2);
  assert.equal(dec.channels[0].length, N);
  assert.equal(dec.rate, RATE);
  // 16-bit quantisation: within ~1 LSB
  assert.ok(Math.abs(dec.channels[0][N - 1] - a[N - 1]) < 1 / 32768 + 1e-6);
  assert.ok(Math.abs(dec.channels[1][500] - 0.25) < 1 / 32768 + 1e-6);
});

test('decodeWavPcm rejects non-PCM / malformed input', () => {
  assert.equal(decodeWavPcm(new ArrayBuffer(10)), null);              // too short
  const wav = encodeWav([new Float32Array(8)], RATE);
  const dv = new DataView(wav);
  dv.setUint16(20, 3, true);                                          // format 3 = float
  assert.equal(decodeWavPcm(wav), null);
});

test('normalize brings the peak to -0.1 dBFS', () => {
  const src = { channels: [Float32Array.from({ length: 100 }, () => 0.5)], rate: RATE };
  const out = processBuffer(src, { ...NOOP, normalize: true });
  assert.ok(Math.abs(peakOf(out.channels) - Math.pow(10, -0.1 / 20)) < 2e-3);
});

test('gain -6 dB scales by ~0.501', () => {
  const src = { channels: [Float32Array.from({ length: 50 }, () => 0.4)], rate: RATE };
  const out = processBuffer(src, { ...NOOP, gainDb: -6 });
  assert.ok(Math.abs(out.channels[0][10] / 0.4 - 0.5012) < 1e-3);
});

test('mono downmix averages two channels into one', () => {
  const l = Float32Array.from({ length: 10 }, () => 0.8);
  const r = Float32Array.from({ length: 10 }, () => 0.2);
  const out = processBuffer({ channels: [l, r], rate: RATE }, { ...NOOP, channels: 'mono' });
  assert.equal(out.channels.length, 1);
  assert.ok(Math.abs(out.channels[0][0] - 0.5) < 1e-6);
});

test('stereo from mono duplicates the channel', () => {
  const m = Float32Array.from({ length: 10 }, (_, i) => i / 10);
  const out = processBuffer({ channels: [m], rate: RATE }, { ...NOOP, channels: 'stereo' });
  assert.equal(out.channels.length, 2);
  assert.deepEqual([...out.channels[0]], [...out.channels[1]]);
});

test('trim removes silence, de-clicks the cut edges, keeps the interior', () => {
  const M = 6000, body = new Float32Array(M);
  for (let i = 1000; i <= 5000; i++) body[i] = 0.4;
  const out = processBuffer({ channels: [body], rate: RATE }, { ...NOOP, trim: true });
  assert.equal(out.channels[0].length, 4001);
  assert.equal(out.channels[0][0], 0);              // head de-click → 0
  assert.equal(out.channels[0][4000], 0);           // tail de-click → 0
  assert.ok(Math.abs(out.channels[0][2000] - 0.4) < 1e-6);  // interior intact
});

test('trim threshold is relative to peak (keeps a quiet -54 dBFS tail)', () => {
  const q = new Float32Array(2000);
  for (let i = 0; i < 1500; i++) q[i] = 0.5;        // loud body
  for (let i = 1500; i < 1800; i++) q[i] = 0.002;   // ~ -54 dBFS (kept; a fixed
  //                                                    -48 dB gate would cut it)
  const out = processBuffer({ channels: [q], rate: RATE }, { ...NOOP, trim: true });
  assert.equal(out.channels[0].length, 1800);
});

test('fade-in ramps from zero (raised cosine)', () => {
  const a = Float32Array.from({ length: 1000 }, () => 0.5);
  const out = processBuffer({ channels: [a], rate: RATE }, { ...NOOP, fadeInMs: 1 });
  assert.equal(out.channels[0][0], 0);
  assert.ok(out.channels[0][47] > 0 && out.channels[0][47] < 0.5);  // mid-ramp
});

test('toolsActive reflects whether any tool would change the audio', () => {
  assert.equal(toolsActive(NOOP), false);
  assert.equal(toolsActive({ ...NOOP, normalize: true }), true);
  assert.equal(toolsActive({ ...NOOP, channels: 'mono' }), true);
  assert.equal(toolsActive({ ...NOOP, gainDb: -3 }), true);
  assert.equal(toolsActive({ ...NOOP, trim: true }), true);
  assert.equal(toolsActive({ ...NOOP, fadeOutMs: 10 }), true);
});

test('processBuffer does not mutate its input', () => {
  const src = { channels: [Float32Array.from({ length: 20 }, () => 0.5)], rate: RATE };
  const before = [...src.channels[0]];
  processBuffer(src, { ...NOOP, gainDb: 6, normalize: true });
  assert.deepEqual([...src.channels[0]], before);
});

test('sliceBuffer equal mode yields N contiguous segments covering the source', () => {
  const N = 4800;
  const src = { channels: [Float32Array.from({ length: N }, () => 0.5)], rate: RATE };
  const segs = sliceBuffer(src, { mode: 'equal', count: 4 });
  assert.equal(segs.length, 4);
  assert.equal(segs.reduce((s, g) => s + g.channels[0].length, 0), N);   // no gaps/overlap
  for (const g of segs) assert.equal(g.channels[0].length, N / 4);
  assert.equal(segs[0].rate, RATE);
});

test('sliceBuffer de-clicks each segment edge toward zero', () => {
  const src = { channels: [Float32Array.from({ length: 4800 }, () => 0.8)], rate: RATE };
  const [seg] = sliceBuffer(src, { mode: 'equal', count: 1 });
  const c = seg.channels[0];
  assert.ok(Math.abs(c[0]) < 0.8);                       // faded in
  assert.ok(Math.abs(c[c.length - 1]) < 0.8);            // faded out
  assert.ok(Math.abs(c[c.length >> 1]) > 0.7);           // body untouched
});

test('sliceBuffer transient mode finds the onsets in a spaced-impulse signal', () => {
  const N = RATE;                                        // 1 s
  const a = new Float32Array(N);                         // 4 bursts, 200 ms apart
  for (const at of [0, 9600, 19200, 28800])
    for (let i = 0; i < 600; i++) a[at + i] = 0.9;
  const segs = sliceBuffer({ channels: [a], rate: RATE }, { mode: 'transient', sensitivity: 0.6 });
  // best-effort: should land near 4 (the bursts), not 1 and not dozens
  assert.ok(segs.length >= 3 && segs.length <= 6, `got ${segs.length} segments`);
});

test('sliceBuffer does not mutate its input', () => {
  const src = { channels: [Float32Array.from({ length: 100 }, () => 0.7)], rate: RATE };
  const before = [...src.channels[0]];
  sliceBuffer(src, { mode: 'equal', count: 3 });
  assert.deepEqual([...src.channels[0]], before);
});

test('sliceBuffer equal mode clamps the count to at least 1', () => {
  const src = { channels: [Float32Array.from({ length: 1000 }, () => 0.5)], rate: RATE };
  assert.equal(sliceBuffer(src, { mode: 'equal', count: 0 }).length, 1);
  assert.equal(sliceBuffer(src, { mode: 'equal', count: -3 }).length, 1);
});

test('nearestZeroCrossing finds the closest sign change and prefers the nearer side', () => {
  // a sine: zero crossings at multiples of half-period
  const n = 2000, period = 100;
  const sig = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * i / period));
  // crossings near 0, 50, 100, 150 ... ; from target 60 the nearest is ~50
  const zc = nearestZeroCrossing([sig], 60, 200);
  assert.ok(Math.abs(zc - 50) <= 1, `got ${zc}`);
  // exactly on a crossing region returns that index
  assert.ok(Math.abs(nearestZeroCrossing([sig], 100, 50) - 100) <= 1);
});

test('nearestZeroCrossing returns -1 when no crossing within the window', () => {
  const flat = new Float32Array(500).fill(0.5);          // DC, never crosses
  assert.equal(nearestZeroCrossing([flat], 250, 100), -1);
});

test('nearestZeroCrossing sums channels (stereo handled together)', () => {
  // left positive, right negative → sum stays >0 except where it flips
  const L = Float32Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.8 : -0.8));
  const R = Float32Array.from({ length: 200 }, () => 0.1);
  const zc = nearestZeroCrossing([L, R], 90, 50);        // sum flips around i=100
  assert.ok(zc >= 99 && zc <= 101, `got ${zc}`);
});

test('sliceBuffer transient: higher sensitivity never finds fewer onsets', () => {
  const N = RATE;
  const a = new Float32Array(N);
  // graded bursts: the weak ones only clear the threshold at higher sensitivity
  for (const [at, amp] of [[4800, 0.9], [12000, 0.22], [19200, 0.9], [26400, 0.13]])
    for (let i = 0; i < 600; i++) a[at + i] = amp * Math.sin(2 * Math.PI * 300 * i / RATE);
  const src = { channels: [a], rate: RATE };
  const low = sliceBuffer(src, { mode: 'transient', sensitivity: 0.05 }).length;
  const high = sliceBuffer(src, { mode: 'transient', sensitivity: 0.95 }).length;
  assert.ok(high >= low, `monotonic in sensitivity: high ${high} >= low ${low}`);
  assert.ok(low >= 1, 'always at least the leading segment');
});
