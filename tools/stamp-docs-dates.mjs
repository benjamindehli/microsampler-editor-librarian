// Keep the docs' freshness dates honest from git history - no manual upkeep:
//   - docs/*.html: the JSON-LD "dateModified" of each doc page.
//   - docs/sitemap.xml: each URL's <lastmod>.
//
//   node tools/stamp-docs-dates.mjs            # stamp in place
//   node tools/stamp-docs-dates.mjs --check    # exit 1 if a date is stale
//
// Each page's date is the committer date of the newest commit that changed the
// file's CONTENT - commits that only rewrote a date line (i.e. this script's own
// commits) are skipped, so re-running is a no-op and --check is stable (a plain
// `git log -1` would loop: the stamp commit becomes the newest change, bumping
// the date, forever). datePublished is never touched. Zero deps (git + node
// built-ins). Runs from the npm `version` lifecycle; also run it after editing a
// doc page. Needs full history - on a shallow clone --check no-ops with a notice.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// loc = the sitemap URL path for the page; file = its source; marker matches a
// date-only diff line for that file (so content changes can be told apart).
const SITE = "https://benjamindehli.github.io/microsampler-editor-librarian";
const PAGES = [
    { url: `${SITE}/`, file: "docs/index.html", html: false },
    { url: `${SITE}/getting-started`, file: "docs/getting-started.html", html: true },
    { url: `${SITE}/guide`, file: "docs/guide.html", html: true },
    { url: `${SITE}/concepts`, file: "docs/concepts.html", html: true },
    { url: `${SITE}/troubleshooting`, file: "docs/troubleshooting.html", html: true }
];
const DATE_RE = /"dateModified":\s*"\d{4}-\d{2}-\d{2}"/; // in HTML JSON-LD
const LASTMOD_RE = /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/; // in sitemap.xml
// a diff line (already stripped of its +/-) that is ONLY a date rewrite
const DATE_ONLY_LINE = /^\s*("dateModified":|<lastmod>)/;

// committer date (YYYY-MM-DD) of the newest commit that changed real content -
// skipping commits whose only change to the file was a date line.
function contentDate(file) {
    const log = git(["log", "--format=%H %cs", "--", file]).trim();
    if (!log) return null; // untracked / no history
    const rows = log.split("\n").map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]);
    for (const [hash, date] of rows) {
        const diff = git(["show", "--format=", "--unified=0", hash, "--", file]);
        const changed = diff
            .split("\n")
            .filter((l) => (l[0] === "+" || l[0] === "-") && !l.startsWith("+++") && !l.startsWith("---"))
            .map((l) => l.slice(1));
        if (changed.some((l) => !DATE_ONLY_LINE.test(l))) return date; // real content → this is the date
    }
    return rows[rows.length - 1][1]; // date-only history (shouldn't happen) → oldest
}

const check = process.argv.includes("--check");
if (check && git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.log("shallow clone - skipping docs date --check (needs full history)");
    process.exit(0);
}

const dates = {}; // file → content date
for (const p of PAGES) dates[p.file] = contentDate(p.file);

let stale = false;
function apply(file, re, next, label) {
    const path = join(root, file);
    const src = readFileSync(path, "utf8");
    const out = src.replace(re, next);
    if (out === src) return;
    stale = true;
    if (check) console.error(`${file}: ${label} is stale - run: npm run stamp-dates`);
    else {
        writeFileSync(path, out);
        console.log(`stamped ${label} in ${file}`);
    }
}

// per-page dateModified in the HTML
for (const p of PAGES) {
    if (!p.html || !dates[p.file]) continue;
    apply(p.file, DATE_RE, `"dateModified": "${dates[p.file]}"`, "dateModified");
}

// per-URL <lastmod> in the sitemap: rewrite inside each matching <url> block
{
    const file = "docs/sitemap.xml";
    const path = join(root, file);
    let src = readFileSync(path, "utf8");
    const before = src;
    src = src.replace(/<url>[\s\S]*?<\/url>/g, (block) => {
        const loc = (block.match(/<loc>(.*?)<\/loc>/) || [])[1];
        const page = PAGES.find((p) => p.url === loc);
        const date = page && dates[page.file];
        return date ? block.replace(LASTMOD_RE, `<lastmod>${date}</lastmod>`) : block;
    });
    if (src !== before) {
        stale = true;
        if (check) console.error(`${file}: a <lastmod> is stale - run: npm run stamp-dates`);
        else {
            writeFileSync(path, src);
            console.log(`stamped <lastmod> in ${file}`);
        }
    }
}

if (check && stale) process.exit(1);
if (!stale) console.log("docs dates already current");
