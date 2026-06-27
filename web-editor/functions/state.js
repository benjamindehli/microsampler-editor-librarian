// Single shared app state (mutated across components).
export const state = {
  bank: null,            // /api/bank payload
  sel: null,             // selected slot index
  buffers: new Map(),    // slot -> AudioBuffer (decoded; "loaded")
  formats: new Map(),    // slot -> {rate_hz,stereo,frames,seconds} (persists)
  audio: null,           // AudioContext
  playing: null,         // current source node
  online: false,
  fx: null,              // {type, knobs:[a,b], vals:[..32]} — effect view
  follow: true,          // FOLLOW toggle: selection tracks the last device note
};

export function slotData(i) { return state.bank.slots[i]; }
