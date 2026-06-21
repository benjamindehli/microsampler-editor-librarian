// LIBRARY mode (bridge --library): a hardware-free sample librarian. Import an
// original Korg .msmpl_bank (or this app's .zip backup), browse a bank's 36
// pads, play each sample in the browser, and download it (or the whole bank as
// a ZIP of WAVs). No device involved — purely the backup files on disk.
import { noteName } from './notes.js';
import { tick } from './ticker.js';
import { $, apiJson, esc } from './util.js';

let banks = [];
let selDir = null;
const audio = new Audio();          // single shared player
let playing = null;                 // `${dir}:${slot}` currently sounding

async function refresh(selectDir) {
  banks = (await apiJson('/api/backups')).backups;
  selDir = selectDir || (banks.some(b => b.dir === selDir) ? selDir
    : (banks[0] && banks[0].dir)) || null;
  renderBanks();
  await renderDetail();
}

function renderBanks() {
  const list = $('#lib-banks');
  if (!banks.length) {
    list.innerHTML = '<p class="backup-empty">NO BANKS YET — OPEN A FILE ↑</p>';
    return;
  }
  list.innerHTML = '';
  for (const b of banks) {
    const row = document.createElement('button');
    row.className = 'lib-bank' + (b.dir === selDir ? ' sel' : '');
    row.innerHTML =
      `<span class="lib-bank-name">${esc(b.name || b.dir)}</span>
       <span class="lib-bank-meta">${b.samples} samples${b.dir !== (b.name || '') ? ' · ' + esc(b.dir) : ''}</span>`;
    row.onclick = () => { selDir = b.dir; stop(); renderBanks(); renderDetail(); };
    list.append(row);
  }
}

async function renderDetail() {
  const el = $('#lib-detail');
  if (!selDir) { el.innerHTML = ''; return; }
  let samples;
  try { samples = (await apiJson(`/api/backup/${encodeURIComponent(selDir)}/samples`)).samples; }
  catch (e) { el.innerHTML = `<p class="backup-empty">${esc(e.message)}</p>`; return; }
  const bySlot = {};
  for (const s of samples) bySlot[s.slot] = s;
  const zip = `/api/backup/${encodeURIComponent(selDir)}.zip`;
  el.innerHTML =
    `<div class="lib-detail-head">
       <span>${samples.length} sample${samples.length !== 1 ? 's' : ''} — click a pad to play</span>
       <a class="hw-btn" href="${zip}" download="${encodeURIComponent(selDir)}.zip"><span class="hw-btn-cap">⇩ ALL (ZIP)</span></a>
     </div>
     <div class="lib-grid" id="lib-grid"></div>
     <div id="lib-patterns"></div>`;
  const grid = $('#lib-grid');
  for (let i = 0; i < 36; i++) {
    const s = bySlot[i];
    const pad = document.createElement('div');
    pad.className = 'pad lib-pad ' + (s ? 'used' : 'empty');
    pad.innerHTML =
      `<span class="pad-num">${String(i + 1).padStart(2, '0')} · ${noteName(i)}</span>
       <span class="pad-name">${s ? esc(s.name) : '· · · ·'}</span>`;
    if (s) {
      pad.dataset.slot = i;
      const dl = document.createElement('a');
      dl.className = 'lib-dl';
      dl.href = `/api/backup/${encodeURIComponent(selDir)}/sample/${i}.wav`;
      dl.download = `${(s.name || ('s' + i)).replace(/[^\w.-]/g, '_')}.wav`;
      dl.title = 'Download WAV';
      dl.textContent = '⇩';
      dl.onclick = e => e.stopPropagation();      // don't trigger play
      pad.append(dl);
      pad.onclick = () => toggle(i, s);
    }
    grid.append(pad);
  }
  renderPatterns();
}

// patterns (sequences) are recovered as MIDI — list the non-empty ones with a
// per-pattern .mid download + an "all patterns" ZIP. Hidden if the bank has none.
async function renderPatterns() {
  const dir = selDir, box = $('#lib-patterns');
  let pats;
  try { pats = (await apiJson(`/api/backup/${encodeURIComponent(dir)}/patterns`)).patterns; }
  catch { return; }
  if (dir !== selDir || !pats.length) return;          // bank changed, or none
  const zip = `/api/backup/${encodeURIComponent(dir)}/patterns.zip`;
  box.innerHTML =
    `<div class="lib-detail-head" style="margin-top:1.1rem">
       <span>${pats.length} pattern${pats.length !== 1 ? 's' : ''} — download as MIDI</span>
       <a class="hw-btn" href="${zip}" download="${encodeURIComponent(dir)}-patterns.zip"><span class="hw-btn-cap">⇩ ALL (.mid ZIP)</span></a>
     </div>
     <div class="lib-pats">` +
    pats.map(p => {
      const f = `${String(p.pattern + 1).padStart(2, '0')}_${(p.name || 'pattern').replace(/[^\w.-]/g, '_')}.mid`;
      return `<a class="lib-pat" download="${f}" href="/api/backup/${encodeURIComponent(dir)}/pattern/${p.pattern}.mid">
                <span class="lib-pat-name">P${String(p.pattern + 1).padStart(2, '0')} · ${esc(p.name || '—')}</span>
                <span class="lib-pat-meta">${p.note_count} notes ⇩</span>
              </a>`;
    }).join('') + '</div>';
}

function paint() {
  for (const p of document.querySelectorAll('.lib-pad'))
    p.classList.toggle('sounding', playing === `${selDir}:${p.dataset.slot}`);
}
function stop() { audio.pause(); playing = null; paint(); }

function toggle(slot, s) {
  const key = `${selDir}:${slot}`;
  if (playing === key) { stop(); return; }
  audio.src = `/api/backup/${encodeURIComponent(selDir)}/sample/${slot}.wav`;
  audio.play().then(() => { playing = key; paint(); tick(`▶ ${s.name}`); })
    .catch(err => tick(`⚠ play: ${err.message}`));
}
audio.addEventListener('ended', stop);

// ── import (.msmpl_bank → convert; .zip → our backup) ───────────────────────
$('#lib-import').onclick = () => $('#lib-file').click();
$('#lib-file').onchange = async ev => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const msmpl = /\.msmpl_bank$/i.test(f.name);
  const route = msmpl ? '/api/backup/import-msmpl' : '/api/backup/import';
  tick(`⇧ importing ${f.name}…`);
  try {
    const { dir } = await apiJson(route, { method: 'POST', body: await f.arrayBuffer() });
    tick(`✓ imported "${dir}"`);
    await refresh(dir);
  } catch (e) { tick(`⚠ import failed: ${e.message}`); }
};

export function initLibrary() { refresh().catch(() => { }); }    // called once on boot
export function renderLibrary() { if (!banks.length) refresh().catch(() => { }); }
