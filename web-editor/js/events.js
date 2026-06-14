// SSE feed from the bridge: routes device events to the right component.
import { BIPOLAR, cacheParam, dec14, PARAM, reflect, tuneDisplay }
  from './controls.js';
import { FX_OBJ, fxReflect, onCC } from './effect.js';
import { onPatternsProgress } from './patterns.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { $, fmtSigned } from './util.js';
import { onOpEvent } from './utility.js';
import { followSelect } from './waveform.js';

export function subscribeEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    const evt = JSON.parse(e.data);
    if (evt.type === 'op' || evt.type === 'op_done') return onOpEvent(evt);
    if (evt.type === 'progress')
      return evt.op === 'patterns' && onPatternsProgress(evt.done, evt.total);
    if (evt.type === 'cc') return onCC(evt);
    if (evt.type === 'note') return state.follow && followSelect(evt.slot);
    if (evt.type !== 'parameter_change') return;
    const isFx = evt.obj === FX_OBJ;
    const who = evt.sample != null ? `S${evt.sample + 1}`
      : isFx ? 'FX' : evt.obj === 0 ? 'BANK' : `obj${evt.obj}`;
    if (evt.obj === 0 && state.bank) {        // bank panel edits (obj 0)
      if (evt.param === 16) {                 // BPM × 10
        state.bank.bpm = evt.value / 10;
        $('#bank-bpm').textContent = state.bank.bpm.toFixed(1);
      } else if (evt.param < 8) {             // name chars
        const n = (state.bank.name || '').padEnd(8).split('');
        n[evt.param] = String.fromCharCode(evt.value);
        state.bank.name = n.join('').trimEnd();
        $('#bank-name').textContent = n.join('');
      }
    }
    const shown = isFx ? fmtSigned(dec14(evt.value))
      : BIPOLAR.has(evt.param) ? fmtSigned(dec14(evt.value))
      : evt.param === PARAM.TUNE ? tuneDisplay(evt.value)
      : evt.value;
    tick(`← ${who} #${evt.param} = ${shown}`);
    if (evt.sample != null)                  // panel edits update the cache
      cacheParam(evt.sample, evt.param,      // for EVERY slot, selected or not
                 BIPOLAR.has(evt.param) ? dec14(evt.value) : evt.value);
    if (evt.sample === state.sel) reflect(evt.param, evt.value);
    if (isFx) fxReflect(evt.param, evt.value);
  };
  es.onerror = () => { /* EventSource retries on its own */ };
}
