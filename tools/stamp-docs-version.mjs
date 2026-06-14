// Sync the docs download link + structured data to package.json's version, so
// the "Download vX.Y.Z (ZIP)" button, the release-ZIP URL, and the JSON-LD
// softwareVersion always match the version being released.
//
//   node tools/stamp-docs-version.mjs            # stamp docs/index.html in place
//   node tools/stamp-docs-version.mjs --check    # exit 1 if out of sync (CI guard)
//
// Runs automatically from the npm `version` lifecycle (see package.json), so a
// `npm version <new>` rewrites the link and folds it into the version commit.
// No build step, no placeholder tokens — docs/index.html is always valid HTML;
// this just keeps the real version in sync. Zero dependencies (node built-ins).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const docsPath = join(root, 'docs', 'index.html');
const src = readFileSync(docsPath, 'utf8');

const REPO = 'microsampler-editor-librarian';
const V = '[\\w.+-]+';                               // semver incl. -beta.1 etc.
const out = src
  // release ZIP URL — version appears in BOTH the tag path and the filename
  .replace(new RegExp(`releases/download/v${V}/${REPO}-v${V}\\.zip`, 'g'),
    `releases/download/v${version}/${REPO}-v${version}.zip`)
  // the download button label
  .replace(new RegExp(`Download&nbsp;v${V} \\(ZIP\\)`, 'g'),
    `Download&nbsp;v${version} (ZIP)`)
  // JSON-LD softwareVersion (no leading "v")
  .replace(new RegExp(`"softwareVersion":\\s*"${V}"`, 'g'),
    `"softwareVersion": "${version}"`);

if (out === src) {
  console.log(`docs/index.html already at v${version}`);
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.error(`docs/index.html is out of sync with package.json (v${version}) — run: npm run stamp-version`);
  process.exit(1);
}
writeFileSync(docsPath, out);
console.log(`stamped docs/index.html → v${version}`);
