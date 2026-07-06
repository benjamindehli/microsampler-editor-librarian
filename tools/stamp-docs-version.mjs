// Sync the version in non-package files to package.json's version:
//   - docs/index.html: the "Download vX.Y.Z (ZIP)" button, the release-ZIP URL,
//     and the JSON-LD softwareVersion.
//   - native-tools/bridge.py: the VERSION constant the bridge reports via
//     /api/status (the app's "update available" check compares against it).
//
//   node tools/stamp-docs-version.mjs            # stamp in place
//   node tools/stamp-docs-version.mjs --check    # exit 1 if out of sync (CI guard)
//
// Runs automatically from the npm `version` lifecycle (see package.json), so
// `npm version <new>` rewrites these and folds them into the version commit.
// No build step, no placeholder tokens — the files stay valid; this just keeps
// the real version in sync. Zero dependencies (node built-ins).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REPO = 'microsampler-editor-librarian';
const V = '[\\w.+-]+';                                 // semver incl. -beta.1 etc.

const targets = [
  { file: 'docs/index.html', patterns: [
      // release ZIP URL — version appears in BOTH the tag path and the filename
      [new RegExp(`releases/download/v${V}/${REPO}-v${V}\\.zip`, 'g'),
        `releases/download/v${version}/${REPO}-v${version}.zip`],
      // the download button label
      [new RegExp(`Download&nbsp;v${V} \\(ZIP\\)`, 'g'),
        `Download&nbsp;v${version} (ZIP)`],
      // JSON-LD softwareVersion (no leading "v")
      [new RegExp(`"softwareVersion":\\s*"${V}"`, 'g'),
        `"softwareVersion": "${version}"`],
  ] },
  { file: 'native-tools/bridge.py', patterns: [
      // VERSION = '...'  (value the bridge reports via /api/status)
      [new RegExp(`VERSION = '${V}'`), `VERSION = '${version}'`],
  ] },
];

const check = process.argv.includes('--check');
let stale = false, broken = false;
for (const { file, patterns } of targets) {
  const path = join(root, file);
  const src = readFileSync(path, 'utf8');
  let out = src;
  for (const [re, sub] of patterns) {
    // every pattern must MATCH — if a rewrite made one vanish (e.g. the button
    // was reworded), a silent no-op would leave the guard blind to that target
    if (!src.match(re)) {
      broken = true;
      console.error(`${file}: stamped pattern not found: ${re} — update tools/stamp-docs-version.mjs`);
      continue;
    }
    out = out.replace(re, sub);
  }
  if (out === src) continue;
  stale = true;
  if (check) {
    console.error(`${file} is out of sync with package.json (v${version}) — run: npm run stamp-version`);
  } else {
    writeFileSync(path, out);
    console.log(`stamped ${file} → v${version}`);
  }
}
if (broken) process.exit(1);
if (check && stale) process.exit(1);
if (!stale) console.log(`already at v${version}`);
