// EFFECT view — bank effect = object 80. Wire ids: param 1 = FX type, 2-3 =
// the two assignable-knob targets, 16+i = effect param i. Wire VALUE =
// display value (negatives travel as signed 14-bit, like sample params);
// the bank blob stores byte = display + descriptor center.
import { VALUE_TABLES } from './valueTables.js';
import { FX_TYPES, FX_TABLES_EXTRA } from './fxData.js';
import { $, esc, api, fmtSigned } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { dec14 } from './controls.js';

export const FX_OBJ = 80;

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

export function fxFromBank(e) {
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

export function renderFx() {
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
export function onCC(evt) {
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

export function fxReflect(param, value) {
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
