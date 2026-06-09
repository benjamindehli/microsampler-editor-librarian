// UTILITY view: backup list, restore dialog, background-op console.
import { $, esc, apiJson, jsonBody } from './util.js';
import { state } from './state.js';
import { tick } from './ticker.js';
import { refreshBank } from './app.js';

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
    zip.innerHTML = '<span class="hw-btn-cap">⇩ ZIP</span>';
    const btn = document.createElement('button');
    btn.className = 'hw-btn';
    btn.innerHTML = '<span class="hw-btn-cap">RESTORE…</span>';
    btn.onclick = () => openRestore(b);
    row.append(zip, btn);
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
