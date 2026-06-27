// "Update available" check: compare the running bridge version (from
// /api/status) against the latest GitHub release, and show a dismissible toast
// when a newer one exists. Polite (caches the API result for a day — the
// unauthenticated rate limit is 60/hr) and quiet on any failure (offline,
// rate-limited, CORS): the editor works fine without it.
import { $ } from 'functions/util.js';

const REPO = 'benjamindehli/microsampler-editor-librarian';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE = 'msmpl.update';        // {t, tag, url}
const SEEN = 'msmpl.update.seen';    // tag the user dismissed
const DAY = 86400e3;

const parts = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
// is release tag `a` newer than current version `b`? (major.minor.patch)
function isNewer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function latestRelease() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (c && Date.now() - c.t < DAY) return c;            // fresh enough
  } catch { /* ignore */ }
  const r = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('releases ' + r.status);
  const j = await r.json();
  const rec = { t: Date.now(), tag: j.tag_name || '', url: j.html_url || '' };
  try { localStorage.setItem(CACHE, JSON.stringify(rec)); } catch { /* ignore */ }
  return rec;
}

export async function checkForUpdate(current) {
  if (!current) return;
  let rel;
  try { rel = await latestRelease(); } catch { return; }   // offline / limited → quiet
  if (!rel.tag || !isNewer(rel.tag, current)) return;
  try { if (localStorage.getItem(SEEN) === rel.tag) return; } catch { /* ignore */ }  // dismissed
  const el = $('#update-toast');
  $('#update-text').textContent =
    `v${rel.tag.replace(/^v/, '')} available — you have v${current}`;
  $('#update-link').href = rel.url || `https://github.com/${REPO}/releases`;
  $('#update-dismiss').onclick = () => {
    el.hidden = true;
    try { localStorage.setItem(SEEN, rel.tag); } catch { /* ignore */ }
  };
  el.hidden = false;
}
