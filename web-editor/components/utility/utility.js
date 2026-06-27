// UTILITY view: backup list, restore dialog, background-op console.
import { refreshBank } from 'app.js';
import { loadAllSamples } from 'components/meter/meter.js';
import { forgetSample } from 'components/sample-editor/sampleLoad.js';
import { noteName } from 'functions/notes.js';
import { state } from 'functions/state.js';
import { tick } from 'functions/ticker.js';
import { $, apiJson, esc, jsonBody } from 'functions/util.js';

export async function loadBackups() {
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
    const zip = document.createElement('a');
    zip.className = 'hw-btn';
    zip.href = `/api/backup/${encodeURIComponent(b.dir)}.zip`;
    zip.download = `${b.dir}.zip`;
    zip.innerHTML = '<span class="hw-btn-cap"><span class="ico ico-dn"></span>ZIP</span>';
    const btn = document.createElement('button');
    btn.className = 'hw-btn';
    btn.innerHTML = '<span class="hw-btn-cap">RESTORE…</span>';
    btn.onclick = () => openRestore(b);
    row.append(zip);
    if (b.samples) {                               // cherry-pick a single sample
      const pick = document.createElement('button');
      pick.className = 'hw-btn';
      pick.innerHTML = '<span class="hw-btn-cap">SAMPLES…</span>';
      pick.onclick = () => openCherryPick(b);
      row.append(pick);
    }
    row.append(btn);
    list.append(row);
  }
}

// import a backup .zip (shareable between machines / other owners)
$('#import-btn').onclick = () => $('#import-file').click();
$('#import-file').onchange = async ev => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  opPrint(`importing ${f.name}…`, { reset: true });
  try {
    const r = await apiJson('/api/backup/import',
      { method: 'POST', body: await f.arrayBuffer() });
    opPrint(`✓ imported as "${r.dir}"`);
    tick(`⇧ imported backup ${r.dir}`);
    await loadBackups();
  } catch (e) {
    opPrint('ERROR: ' + e.message, { err: true });
    tick('⚠ import failed: ' + e.message);
  }
};

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
      await apiJson('/api/restore', jsonBody({ dir: b.dir, bank }));
    } catch (err2) {
      opPrint('ERROR: ' + err2.message, { err: true });
      setOpRunning(false);
    }
  };
}

// ── cherry-pick: copy ONE sample out of a backup into the current bank ──────
let cpDir = null;

async function openCherryPick(b) {
  let samples;
  try {
    samples = (await apiJson(`/api/backup/${encodeURIComponent(b.dir)}/samples`)).samples;
  } catch (e) { tick(`⚠ ${e.message}`); return; }
  if (!samples.length) { tick('backup has no samples'); return; }
  cpDir = b.dir;
  $('#cp-bk').textContent = `${b.name} (${b.dir})`;
  $('#cp-src').innerHTML = samples.map(s =>
    `<option value="${s.slot}">${String(s.slot + 1).padStart(2, '0')} · ${esc(s.name)}</option>`).join('');
  buildCpDst();
  $('#cp-info').textContent = '';
  $('#cherry-dialog').showModal();
}

// destination = any of the 36 current-bank pads (showing what each holds now)
function buildCpDst() {
  const sel = $('#cp-dst'), prev = sel.value;
  const slots = (state.bank && state.bank.slots) || [];
  sel.innerHTML = slots.map((s, i) =>
    `<option value="${i}">${String(i + 1).padStart(2, '0')} · ${noteName(i)} · ${s.empty ? '— empty —' : esc(s.name)}</option>`).join('');
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
  else { const e = slots.findIndex(s => s.empty); if (e >= 0) sel.value = e; }
}

$('#cp-copy').onclick = async () => {
  if (cpDir == null) return;
  const from = +$('#cp-src').value, to = +$('#cp-dst').value;
  const btn = $('#cp-copy'); btn.disabled = true;
  try {
    await apiJson(`/api/backup/${encodeURIComponent(cpDir)}/restore-sample`,
                  jsonBody({ from, to }));
    forgetSample(to);
    tick(`⇧ copied backup S${from + 1} → PAD ${to + 1}`);
    $('#cp-info').textContent = `✓ copied → PAD ${to + 1}`;
    await refreshBank();                            // reflect the new slot
    loadAllSamples().catch(() => { });              // eager-load it (not lazy)
    buildCpDst();                                   // …in the destination list
  } catch (e) {
    tick(`⚠ copy failed: ${e.message}`);
    $('#cp-info').textContent = '✕ ' + e.message;
  }
  btn.disabled = false;
};

export function onOpEvent(evt) {
  if (evt.type === 'op') opPrint(evt.line);
  if (evt.type === 'op_done') {
    opPrint(evt.ok ? `✓ ${evt.name} finished` : `✗ ${evt.name} FAILED`,
            { err: !evt.ok });
    setOpRunning(false);
    loadBackups().catch(() => { });
    if (evt.name === 'restore' && evt.ok) {
      state.buffers.clear(); state.formats.clear();   // bank contents replaced
      refreshBank().catch(() => { });
    }
    tick(`${evt.ok ? '✓' : '✗'} ${evt.name} ${evt.ok ? 'complete' : 'failed'}`);
  }
}

// ── remote sampling ([INPUT SELECT] + [SAMPLING] over NRPN) ──────────────
{
  const seg = $('#smp-input');
  seg.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      apiJson('/api/sampling/input', jsonBody({ resample: b.dataset.resample === '1' }))
        .then(() => tick(`input → ${b.textContent.trim()}`)).catch(() => { });
    };
  });
  $('#smp-button').onclick = () =>
    apiJson('/api/sampling/button', { method: 'POST' })
      .then(() => tick('● [SAMPLING] pressed — check the device screen'))
      .catch(e => tick(`⚠ sampling: ${e.message}`));
}
