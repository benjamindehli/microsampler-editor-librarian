// Package the built dist/ into a release ZIP named to match the docs download link
// and the GitHub release asset: release/<name>-v<version>.zip, containing a single
// top-level folder <name>-v<version>/ so it unzips tidily.
//
// Run AFTER `npm run build` (the `pack` npm script chains them). Pure Node: a tiny
// ZIP writer (deflate via zlib + a CRC32 table), so there's no dependency on a
// `zip` binary and it behaves the same on macOS/Linux/Windows. Unix file modes are
// carried into the archive's external attributes, so the launchers stay executable
// after unzip.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const { name, version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const base = `${name}-v${version}`;                 // matches the docs download filename
const REL = join(ROOT, 'release');
const zipPath = join(REL, `${base}.zip`);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

function walk(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const abs = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(abs, r));
    else out.push({ abs, rel: r });
  }
  return out;
}

function buildZip(files) {
  const now = new Date();
  const dosT = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosD = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(f.abs);
    const crc = crc32(data);
    const comp = deflateRawSync(data, { level: 9 });
    const store = comp.length >= data.length;       // never inflate tiny/incompressible files
    const method = store ? 0 : 8;
    const payload = store ? data : comp;
    const nameBuf = Buffer.from(`${base}/${f.rel}`, 'utf8');
    const mode = statSync(f.abs).mode & 0xFFFF;      // carry the unix mode (keeps +x launchers)

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dosT, 10); lh.writeUInt16LE(dosD, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4);   // made by: unix, v3.0
    ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosT, 12); ch.writeUInt16LE(dosD, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38);        // external attrs = unix mode (unsigned)
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

try {
  statSync(join(DIST, 'web-editor', 'app.html'));
} catch {
  console.error('pack: dist/ not built — run `npm run build` first.');
  process.exit(1);
}
rmSync(REL, { recursive: true, force: true });
mkdirSync(REL, { recursive: true });
const files = walk(DIST);
writeFileSync(zipPath, buildZip(files));
const kb = (execFileSync('wc', ['-c', zipPath]).toString().trim().split(/\s+/)[0] | 0) / 1024;
console.log(`packaged → release/${base}.zip  (${files.length} files, ${kb.toFixed(0)} kB)`);
