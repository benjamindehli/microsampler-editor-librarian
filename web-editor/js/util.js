// Shared helpers: DOM lookup, escaping, formatting, bridge API access.
export const $ = s => document.querySelector(s);

export const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtSigned = v => (v > 0 ? '+' : '') + v;

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch { /* binary/none */ }
    throw new Error(msg);
  }
  return r;
}
export const apiJson = async (path, opts) => (await api(path, opts)).json();

export function wavFormat(arrayBuf) {
  // minimal RIFF/WAVE fmt reader (LE): channels @22, rate @24
  const dv = new DataView(arrayBuf);
  if (dv.getUint32(0, false) !== 0x52494646) return null;     // 'RIFF'
  return { channels: dv.getUint16(22, true), rate: dv.getUint32(24, true) };
}
