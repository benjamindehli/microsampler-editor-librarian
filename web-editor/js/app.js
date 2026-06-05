import { MidiEngine } from './midi.js';
import {
  buildDeviceInquiry, buildParameterChange, buildDataDumpRequest, buildRawCommand,
  parseSysEx, hex,
} from './protocol.js';
import { VALUE_TABLES } from './valueTables.js';

const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

let _seq = 0;
function uid() { return 'p' + Date.now().toString(36) + (_seq++); }

const engine = new MidiEngine();
const state = {
  channel: 0,
  learning: false,
  params: migrate(load('msmpl.params', null)),
};

// Older saves predate the (object, param, value) discovery — tag them with the
// default object (sample 1) and drop the unconfirmed 2-value-era example.
function migrate(params) {
  if (!Array.isArray(params)) return defaultParams();
  return params
    .filter(p => !(p.name || '').includes('(example)'))
    .map(p => ({ obj: 16, ...p }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
function save() { localStorage.setItem('msmpl.params', JSON.stringify(state.params)); }

// Starter set of HARDWARE-CONFIRMED sample parameters (captured from panel
// edits 2026-06-04). `obj` = 16 + sample slot; these default to sample 1.
// Use Learn mode to capture more (it records object + param + value).
function defaultParams() {
  const sample1 = (name, num, extra) =>
    ({ id: uid(), name: `S1 ${name}`, obj: 16, num, min: 0, max: 127,
       table: '', value: 0, confirmed: true, ...extra });
  return [
    sample1('Loop',       16, { max: 1,   table: 'OnOff' }),
    sample1('BPM Sync',   17, { max: 2,   table: 'BpmSyncMode' }),
    sample1('Reverse',    18, { max: 1,   table: 'OnOff' }),
    sample1('Decay',      21, { value: 127 }),
    sample1('Release',    22, {}),
    sample1('Tune',       28, { value: 64 }),
  ];
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------
const MAX_LOG = 400;
function log(dir, bytes, note = '') {
  const mon = $('#monitor');
  const decoded = describe(bytes);
  const row = el('div', { className: `logrow ${dir}` },
    el('span', { className: 'ts', textContent: new Date().toLocaleTimeString() }),
    el('span', { className: 'dir', textContent: dir === 'in' ? '◀ IN ' : 'OUT ▶' }),
    el('span', { className: 'bytes', textContent: hex(bytes) }),
    el('span', { className: 'note', textContent: note || decoded }),
  );
  mon.prepend(row);
  while (mon.children.length > MAX_LOG) mon.lastChild.remove();
}
function describe(bytes) {
  const p = parseSysEx(bytes);
  if (!p) return bytes[0] === 0xf0 ? 'SysEx (partial)' : '';
  switch (p.type) {
    case 'inquiryRequest':
      return 'Device Inquiry request';
    case 'inquiryReply':
      return p.isMicroSampler
        ? `Device Inquiry reply — microSAMPLER ✓ (family 0x${p.family.toString(16)})`
        : `Device Inquiry reply — mfr 0x${p.manufacturer.toString(16)} family 0x${p.family.toString(16)}`;
    case 'parameterChange':
      return `Parameter Change — ${p.sample != null ? `sample ${p.sample + 1}` : `object ${p.obj}`} param #${p.paramNumber} = ${p.value}`;
    case 'korg': return `Korg ${p.funcName} (ch ${p.channel + 1})`;
    default: return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// MIDI plumbing
// ---------------------------------------------------------------------------
engine.addEventListener('portschange', renderPorts);
engine.addEventListener('selectionchange', renderPorts);
engine.addEventListener('sent', e => log('out', e.detail.data));
engine.addEventListener('message', e => onIncoming(e.detail.data));

function onIncoming(bytes) {
  if (bytes[0] !== 0xf0) return;       // only care about SysEx here
  log('in', bytes);
  const p = parseSysEx(bytes);
  if (!p) return;

  if (p.type === 'inquiryReply') {
    const box = $('#device-status');
    box.textContent = p.isMicroSampler
      ? `✓ microSAMPLER detected (family 0x${p.family.toString(16)}, member 0x${p.member.toString(16)})`
      : `Replied: manufacturer 0x${p.manufacturer.toString(16)}, family 0x${p.family.toString(16)} (not recognised as microSAMPLER)`;
    box.className = p.isMicroSampler ? 'status ok' : 'status warn';
  }

  if (p.type === 'parameterChange') {
    if (state.learning) captureLearned(p.obj, p.paramNumber, p.value);
    // Reflect device-side edits back into any matching control.
    const ctrl = state.params.find(x => x.obj === p.obj && x.num === p.paramNumber);
    if (ctrl) { ctrl.value = p.value; save(); renderParams(); }
  }
}

function send(bytes) {
  try { engine.send(bytes); }
  catch (err) { log('out', bytes, '⚠ ' + err.message); flashError(err.message); }
}

// ---------------------------------------------------------------------------
// Rendering: connection
// ---------------------------------------------------------------------------
function renderPorts() {
  const ins = $('#input-select'), outs = $('#output-select');
  const fill = (sel, ports, current) => {
    sel.innerHTML = '';
    sel.append(el('option', { value: '', textContent: '— none —' }));
    for (const p of ports) {
      sel.append(el('option', {
        value: p.id, textContent: p.name, selected: current && current.id === p.id,
      }));
    }
  };
  fill(ins, engine.inputs, engine.input);
  fill(outs, engine.outputs, engine.output);
  const ready = engine.input && engine.output;
  $('#conn-dot').className = 'dot ' + (ready ? 'on' : engine.access ? 'idle' : 'off');
}

// ---------------------------------------------------------------------------
// Rendering: parameter editor
// ---------------------------------------------------------------------------
function renderParams() {
  const wrap = $('#params');
  wrap.innerHTML = '';
  if (!state.params.length) {
    wrap.append(el('p', { className: 'empty',
      textContent: 'No parameters yet. Use “Learn from device” or “Add parameter”.' }));
    return;
  }
  for (const param of state.params) wrap.append(paramRow(param));
}

function paramRow(param) {
  const table = param.table && VALUE_TABLES[param.table];
  const valueLabel = el('span', { className: 'pval' });
  const setLabel = () => {
    valueLabel.textContent = table && table[param.value] != null
      ? `${table[param.value]}  (${param.value})` : String(param.value);
  };

  const slider = el('input', {
    type: 'range', min: param.min, max: param.max, value: param.value, className: 'slider',
  });
  slider.addEventListener('input', () => {
    param.value = +slider.value; setLabel();
  });
  slider.addEventListener('change', () => {
    save();
    send(buildParameterChange(state.channel, param.obj ?? 16, param.num, param.value));
  });

  setLabel();

  const badge = el('span', {
    className: 'badge ' + (param.confirmed ? 'ok' : 'unconfirmed'),
    title: param.confirmed ? 'Confirmed on hardware' : 'Parameter number not yet confirmed',
    textContent: param.confirmed ? '✓' : '?',
  });

  const edit = el('button', { className: 'mini', textContent: '✎', title: 'Edit' });
  edit.onclick = () => openParamDialog(param);
  const del = el('button', { className: 'mini danger', textContent: '✕', title: 'Delete' });
  del.onclick = () => { state.params = state.params.filter(x => x !== param); save(); renderParams(); };

  return el('div', { className: 'param' },
    el('div', { className: 'phead' },
      badge,
      el('span', { className: 'pname', textContent: param.name }),
      el('span', { className: 'pnum', textContent:
        (param.obj >= 16 ? `S${param.obj - 16 + 1}` : `obj${param.obj}`) + ` #${param.num}` }),
      el('span', { className: 'spacer' }),
      edit, del,
    ),
    el('div', { className: 'pbody' }, slider, valueLabel),
  );
}

// ---------------------------------------------------------------------------
// Parameter add / edit dialog
// ---------------------------------------------------------------------------
function openParamDialog(existing) {
  const p = existing || { id: uid(), name: '', obj: 16, num: 0, min: 0, max: 127, table: '', value: 0, confirmed: false };
  const dlg = $('#param-dialog');
  $('#pd-title').textContent = existing ? 'Edit parameter' : 'Add parameter';
  $('#pd-name').value = p.name;
  $('#pd-obj').value  = p.obj ?? 16;
  $('#pd-num').value  = p.num;
  $('#pd-min').value  = p.min;
  $('#pd-max').value  = p.max;
  $('#pd-confirmed').checked = !!p.confirmed;
  const tableSel = $('#pd-table');
  tableSel.innerHTML = '';
  tableSel.append(el('option', { value: '', textContent: '— none (numeric) —' }));
  for (const name of Object.keys(VALUE_TABLES)) {
    tableSel.append(el('option', {
      value: name, textContent: `${name} (${VALUE_TABLES[name].length})`, selected: p.table === name,
    }));
  }
  dlg.showModal();

  $('#pd-save').onclick = e => {
    e.preventDefault();
    p.name = $('#pd-name').value.trim() || `Param #${$('#pd-num').value}`;
    p.obj  = +$('#pd-obj').value;
    p.num  = +$('#pd-num').value;
    p.min  = +$('#pd-min').value;
    p.max  = +$('#pd-max').value;
    p.table = tableSel.value;
    p.confirmed = $('#pd-confirmed').checked;
    if (p.table) p.max = Math.max(p.max, VALUE_TABLES[p.table].length - 1);
    p.value = Math.min(Math.max(p.value, p.min), p.max);
    if (!existing) state.params.push(p);
    save(); renderParams(); dlg.close();
  };
}

// ---------------------------------------------------------------------------
// Learn mode
// ---------------------------------------------------------------------------
function setLearning(on) {
  state.learning = on;
  $('#learn-btn').classList.toggle('active', on);
  $('#learn-hint').hidden = !on;
}
function captureLearned(obj, num, value) {
  const where = obj >= 16 ? `S${obj - 16 + 1}` : `obj${obj}`;
  let p = state.params.find(x => x.obj === obj && x.num === num);
  if (!p) {
    p = { id: uid(), name: `Learned ${where} #${num}`, obj, num,
          min: 0, max: 127, table: '', value, confirmed: true };
    state.params.push(p);
  } else {
    p.value = value; p.confirmed = true;
  }
  save(); renderParams();
  flashInfo(`Captured ${where} parameter #${num} = ${value}`);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, cls) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + cls;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 2200);
}
const flashInfo = m => toast(m, 'info');
const flashError = m => toast(m, 'error');

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  $('#connect-btn').onclick = async () => {
    try {
      await engine.init();
      const picked = engine.autoSelect();
      flashInfo(picked.output ? `Auto-selected “${picked.output.name}”` : 'MIDI ready — pick your ports');
    } catch (err) { flashError(err.message); $('#device-status').textContent = err.message; }
  };
  $('#input-select').onchange  = e => engine.selectInput(e.target.value);
  $('#output-select').onchange = e => engine.selectOutput(e.target.value);

  const chan = $('#channel');
  chan.value = state.channel;
  chan.onchange = () => { state.channel = +chan.value; localStorage.setItem('msmpl.channel', chan.value); };

  $('#inquiry-btn').onclick   = () => send(buildDeviceInquiry());
  $('#dump-btn').onclick      = () => send(buildDataDumpRequest(state.channel));
  $('#learn-btn').onclick     = () => setLearning(!state.learning);
  $('#add-param-btn').onclick = () => openParamDialog(null);
  $('#clear-mon-btn').onclick = () => $('#monitor').innerHTML = '';

  $('#export-btn').onclick = () => {
    const blob = new Blob([JSON.stringify(state.params, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'microsampler-parameter-map.json' });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#import-input').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t => {
      try { const arr = JSON.parse(t); if (Array.isArray(arr)) { state.params = arr; save(); renderParams(); flashInfo('Parameter map imported'); } }
      catch { flashError('Invalid JSON'); }
    });
    e.target.value = '';
  };

  // Raw command sender
  $('#raw-send').onclick = () => {
    const func = parseInt($('#raw-func').value, 16);
    const payload = $('#raw-payload').value.trim()
      ? $('#raw-payload').value.trim().split(/[\s,]+/).map(x => parseInt(x, 16) & 0x7f) : [];
    if (Number.isNaN(func)) return flashError('Enter a function code in hex');
    send(buildRawCommand(state.channel, func, payload));
  };

  $('#pd-cancel').onclick = e => { e.preventDefault(); $('#param-dialog').close(); };

  // Show support status up front.
  if (!engine.supported) {
    $('#device-status').textContent =
      'This browser has no Web MIDI API. Use Chrome / Edge / Opera over localhost or https.';
    $('#device-status').className = 'status warn';
    $('#connect-btn').disabled = true;
  }
  const savedChan = localStorage.getItem('msmpl.channel');
  if (savedChan != null) { state.channel = +savedChan; chan.value = savedChan; }
}

wire();
renderPorts();
renderParams();

// Exposed for debugging and for driving the app from the console / tests.
window.msmpl = { engine, state, onIncoming };
