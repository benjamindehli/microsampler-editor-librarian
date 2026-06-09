// Shared sample-audio loader + format cache.
//
// A slot is "loaded" once its decoded AudioBuffer is in state.buffers — then
// audition/waveform are instant and the memory meter is exact. The matching
// device format (rate/channels/frames) is cached in state.formats, which —
// unlike the bank slot objects — PERSISTS across refreshBank(); reapplyFormats()
// re-stamps it onto the fresh bank so a focus re-sync doesn't lose load state
// or reset the meter (was bug: meter reverted + "MEASURE" reappeared on focus).
import { slotData, state } from './state.js';
import { api, wavFormat } from './util.js';

export async function loadSampleAudio(i) {
  if (state.buffers.has(i)) return state.buffers.get(i);   // already loaded
  const s = slotData(i);
  if (s.empty) return null;
  const wav = await (await api(`/api/sample/${i}.wav`)).arrayBuffer();
  const byteLen = wav.byteLength;                 // read BEFORE decode —
  const fmt = wavFormat(wav.slice(0, 44));        // decodeAudioData may detach
  state.audio = state.audio || new AudioContext();
  const buf = await state.audio.decodeAudioData(wav);
  state.buffers.set(i, buf);
  if (fmt) {
    const frames = Math.floor((byteLen - 44) / (fmt.channels * 2));
    const f = { rate_hz: fmt.rate, stereo: fmt.channels === 2,
                frames, seconds: frames / fmt.rate };
    state.formats.set(i, f);
    Object.assign(s, f);
  }
  return buf;
}

// re-stamp persisted formats onto the current (freshly fetched) bank slots
export function reapplyFormats() {
  if (!state.bank) return;
  for (const [slot, f] of state.formats) {
    const s = state.bank.slots[slot];
    if (s && !s.empty) Object.assign(s, f);
  }
}

// drop cached audio + format for a slot (its content changed: upload)
export function forgetSample(i) {
  state.buffers.delete(i);
  state.formats.delete(i);
}
