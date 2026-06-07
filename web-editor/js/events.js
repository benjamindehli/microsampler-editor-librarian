// SSE feed from the bridge: routes device events to the right component.
import { fmtSigned } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { PARAM, BIPOLAR, dec14, tuneDisplay, reflect } from './controls.js';
import { FX_OBJ, fxReflect, onCC } from './effect.js';
import { onOpEvent } from './utility.js';

export function subscribeEvents() {
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
