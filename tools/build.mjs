// Build a lean, minified distribution into dist/ — for publishing a release.
// The repo itself stays no-build (clone & run from src/web-editor/); this only
// produces an optional artifact.
//
//   node tools/build.mjs           (or: npm run build)
//
// Frontend: JS is bundled (all ES modules → one file) + minified, CSS is
// concatenated in cascade order + minified, HTML comments/indentation are
// stripped and the stylesheet <link>s collapse to one. Python runtime is copied
// verbatim minus the test suite (it's the GPL source — not minified, by
// design; readable source must accompany distributed object code anyway).
// Dev/RE-only files (tools/re, .pkg, tests, .github) are left out.
//
// Only dependency: esbuild (MIT), dev-only — never shipped or imported at
// runtime (imported from node_modules; `npm install` once).
import { build, transform } from "esbuild";
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "src/web-editor");
const DIST = join(ROOT, "dist");
const r = (...p) => join(ROOT, ...p);
const d = (...p) => join(DIST, ...p);
const kb = (n) => (n / 1024).toFixed(1) + "kB";

rmSync(DIST, { recursive: true, force: true });
mkdirSync(d("web-editor"), { recursive: true });
mkdirSync(d("web-editor/css"), { recursive: true });
mkdirSync(d("native-tools"), { recursive: true });
mkdirSync(d("tools"), { recursive: true });

const html = readFileSync(join(WEB, "app.html"), "utf8");

// ── JS: bundle every module reachable from app.js, minify ────────────────
const js = await build({
    entryPoints: [join(WEB, "app.js")],
    bundle: true,
    minify: true,
    format: "esm",
    legalComments: "none",
    write: false,
    target: "es2020",
    // mirror app.html's import map so the bare component/function aliases resolve
    alias: {
        functions: join(WEB, "functions"),
        components: join(WEB, "components"),
        "app.js": join(WEB, "app.js")
    }
});
writeFileSync(d("web-editor/app.js"), js.outputFiles[0].text);

// ── CSS: concat the linked sheets in document order, minify as one ───────
// a stylesheet link (styles/*.css or components/<name>/<name>.css), with or
// without the self-closing slash Prettier writes
const CSS_LINK = /<link rel="stylesheet" href="([^"]+\.css)"\s*\/?>/g;
const cssLinks = [...html.matchAll(CSS_LINK)].map((m) => m[1]);
if (!cssLinks.length) throw new Error("build: no stylesheet <link>s found in app.html — the dist would ship unstyled");
const cssSrc = cssLinks.map((p) => readFileSync(join(WEB, p), "utf8")).join("\n");
const cssMin = (await transform(cssSrc, { loader: "css", minify: true })).code;
writeFileSync(d("web-editor/css/app.css"), cssMin);

// ── HTML: strip comments + indentation, collapse the CSS links to one ────
// Strip comments to a fixpoint: one pass can re-expose a `<!--` delimiter
// (e.g. `<!--<!---->`), so repeat until the string stops changing. A single
// pass trips CodeQL's incomplete-multi-character-sanitization rule.
const stripComments = (s) => {
    let prev;
    do {
        prev = s;
        s = s.replace(/<!--[\s\S]*?-->/g, "");
    } while (s !== prev);
    return s;
};
let outHtml =
    stripComments(html)
        // the bundle has no bare imports, so the dev import map isn't needed in dist
        .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, "")
        .replace(/(<link rel="stylesheet" href="[^"]+\.css"\s*\/?>\s*)+/, '<link rel="stylesheet" href="css/app.css">\n')
        .replace(/^[ \t]+/gm, "") // drop indentation
        .replace(/\n{2,}/g, "\n") // collapse blank lines
        .trim() + "\n";
// the dist must link exactly the merged sheet (any other link points at a file dist doesn't ship)
const outLinks = [...outHtml.matchAll(CSS_LINK)].map((m) => m[1]);
if (outLinks.length !== 1 || outLinks[0] !== "css/app.css")
    throw new Error(`build: dist app.html links ${JSON.stringify(outLinks)}, expected ["css/app.css"]`);
writeFileSync(d("web-editor/app.html"), outHtml);

// ── static assets (svg logo/icon, vendored fonts + their OFL licenses) ───
cpSync(join(WEB, "assets"), d("web-editor/assets"), { recursive: true });

// ── Python runtime (no tests), launcher, icon tooling, docs ──────────────
for (const f of ["msusb.py", "protocol.py", "download.py", "upload.py", "bank.py", "msmpl_bank.py", "bridge.py"])
    cpSync(r("src/native-tools", f), d("native-tools", f));
// vendored deps (pyusb + per-platform libusb binaries) — so the release runs
// on just Python 3, no pip/brew
cpSync(r("src/native-tools/vendor"), d("native-tools/vendor"), { recursive: true });
cpSync(r("tools/make_app_icon.sh"), d("tools/make_app_icon.sh"));
// launchers, grouped by OS folder (each: device Editor + no-hardware Library).
// Source lives in src/launchers/<OS>/ but ships flat at the ZIP root (<OS>/).
for (const osdir of ["macOS", "Linux", "Windows"]) mkdirSync(d(osdir), { recursive: true });
for (const launcher of [
    "macOS/microSAMPLER Editor Librarian.command",
    "macOS/microSAMPLER Library.command",
    "Linux/microSAMPLER Editor Librarian.sh",
    "Linux/microSAMPLER Library.sh",
    "Windows/microSAMPLER Editor Librarian.bat",
    "Windows/microSAMPLER Library.bat"
])
    cpSync(r("src/launchers", launcher), d(launcher));
for (const f of ["README.md", "LICENSE"]) cpSync(r(f), d(f));

// ── report ───────────────────────────────────────────────────────────────
const sheetCount = cssLinks.length;
const sz = (p) => statSync(p).size;
console.log("built dist/:");
console.log(`  app.js      ${kb(sz(d("web-editor/app.js")))}  (bundled+minified)`);
console.log(`  css/app.css ${kb(sz(d("web-editor/css/app.css")))}  (${sheetCount} sheets merged)`);
console.log(`  app.html    ${kb(sz(d("web-editor/app.html")))}`);
console.log("  + assets/, native-tools/*.py (no tests), launcher, README, LICENSE");
console.log("\nrun it:  sudo python3 dist/native-tools/bridge.py");
