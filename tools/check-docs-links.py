#!/usr/bin/env python3
"""Check that every link to this repository's own files and docs site resolves.

    python3 tools/check-docs-links.py

Walks the docs site (HTML, CSS, llms.txt, sitemap.xml, robots.txt) and the
Markdown in the repository, collects every link, and resolves each one to a
file. Exits 1 listing anything that does not exist.

Three kinds of link are checked:

- Relative links, resolved against the file they appear in. The site uses
  extensionless page URLs (guide, not guide.html), which GitHub Pages serves
  from guide.html, and ./ for the home page.
- Root-absolute links such as /microsampler-editor-librarian/assets/logo.svg,
  which 404.html is written in on purpose.
- Full URLs on the published site, https://benjamindehli.github.io/
  microsampler-editor-librarian/..., found anywhere in a file. That covers the
  canonical links, the Open Graph images, the JSON-LD, the sitemap, llms.txt,
  the README and the generated Markdown copies of the pages.

Other external URLs are not fetched, so this stays fast and offline. It catches
a renamed page, section or screenshot, not link rot elsewhere on the web.

Fragments are checked whenever a link lands on an HTML page: a link to
guide#utility has to find an element with id="utility" in guide.html. That
keeps the "On this page" lists and the many cross-page links honest when a
section id is renamed. Fragments into Markdown are left alone, because heading
anchors there are made by whoever renders the file rather than written in it.

Standard library only, and Python 3.8 like the rest of the tools.
"""

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

SITE_URL = "https://benjamindehli.github.io/microsampler-editor-librarian/"
# GitHub Pages publishes docs/ at this path, so a root-absolute URL resolves
# against it rather than against the file it sits in.
SITE_PREFIX = "/microsampler-editor-librarian/"

# Directories with nothing of ours to check: installed tooling, build output,
# vendored code and local working folders.
SKIP_DIRS = {
    "node_modules",
    "build",
    "dist",
    "release",
    "temp",
    "original-backup-files",
    "vendor",
    ".git",
}

# href/src on any element, plus every candidate inside a srcset.
ATTR = re.compile(r'(?:href|src|poster)="([^"]+)"')
SRCSET = re.compile(r'srcset="([^"]+)"')
CSS_URL = re.compile(r'url\("?([^")]+)"?\)')
# [text](target) and ![alt](target), with an optional "title" after the target.
MD_LINK = re.compile(r'!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)')
# A full URL on the published site, wherever it appears.
SITE_LINK = re.compile(re.escape(SITE_URL) + r'[^\s"\'<>)\]]*')
# A JSON-LD "@id" names a thing in the structured data, such as #website. It
# looks like a URL but is not a link, so it is removed before searching.
JSONLD_ID = re.compile(r'"@id"\s*:\s*"[^"]*"')
# An element's id. The lookbehind keeps this off data-id and the like, and
# JSON-LD's "@id" does not match because a quote follows the name, not "=".
ID = re.compile(r'(?<![-\w])id="([^"]+)"')


def is_external(url):
    return url.startswith(("http://", "https://", "//", "mailto:", "data:", "tel:"))


def references(path):
    """Every link in a file that points at something of ours, fragments intact."""
    text = path.read_text(encoding="utf-8")
    found = set()
    if path.suffix in (".md", ".txt"):
        found |= set(MD_LINK.findall(text))
    elif path.suffix in (".html", ".css"):
        found |= set(ATTR.findall(text)) | set(CSS_URL.findall(text))
        for group in SRCSET.findall(text):
            for candidate in group.split(","):
                parts = candidate.split()
                if parts:
                    found.add(parts[0])
    found = {u for u in found if u and not is_external(u)}
    # A full site URL is ours however it is written, so it is checked too.
    found |= set(SITE_LINK.findall(JSONLD_ID.sub("", text)))
    return found


def resolve(source, url):
    """The file a URL points at, or None if it leaves the published site."""
    if url.startswith(SITE_URL):
        return DOCS / url[len(SITE_URL) :]
    if url.startswith("/"):
        if not url.startswith(SITE_PREFIX):
            return None
        return DOCS / url[len(SITE_PREFIX) :]
    return source.parent / unquote(url)


def served(target, from_site):
    """The file GitHub Pages serves for a path, or None if there is none.

    A directory is served by its index.html, and an extensionless page URL by
    the .html file of that name. A Markdown file outside the site links to
    files and folders in the repository as GitHub shows them, so there a
    directory stands alone and nothing gets .html added.
    """
    if target.is_dir():
        if not from_site:
            return target
        target = target / "index.html"
    if target.exists():
        return target
    if from_site and not target.suffix:
        page = target.with_name(target.name + ".html")
        if page.exists():
            return page
    return None


def in_site(path):
    try:
        path.resolve().relative_to(DOCS.resolve())
        return True
    except ValueError:
        return False


def in_repo(path):
    try:
        path.resolve().relative_to(ROOT)
        return True
    except ValueError:
        return False


def sources():
    site = [p for p in sorted(DOCS.rglob("*")) if p.suffix in (".html", ".css", ".md", ".txt", ".xml")]
    markdown = [
        p
        for p in sorted(ROOT.rglob("*.md"))
        if not SKIP_DIRS & set(p.relative_to(ROOT).parts) and not in_site(p)
    ]
    return site + markdown


def main():
    files = sources()
    if not files:
        sys.exit(f"nothing to check under {ROOT}")

    ids = {}

    def ids_of(html_file):
        if html_file not in ids:
            ids[html_file] = set(ID.findall(html_file.read_text(encoding="utf-8")))
        return ids[html_file]

    broken = []
    checked = 0
    fragments = 0
    for f in files:
        source = f.relative_to(ROOT)
        for url in sorted(references(f)):
            base, _, fragment = url.partition("#")
            from_site = in_site(f) or url.startswith(SITE_URL)
            if base:
                checked += 1
                found = resolve(f, base)
                if found is None:
                    broken.append((source, url, "leaves the published site"))
                    continue
                if not from_site and not in_repo(found):
                    # From Markdown, GitHub resolves a path that climbs out of
                    # the repository to its own pages, as ../../releases/latest
                    # in SECURITY.md does. Those are not files to check.
                    continue
                target = served(found.resolve(), from_site)
                if target is None:
                    broken.append((source, url, "no such file"))
                    continue
            elif f.suffix == ".html":
                target = f  # a bare #fragment, so the page links into itself
            else:
                continue
            if fragment and target.suffix == ".html":
                fragments += 1
                if fragment not in ids_of(target):
                    where = "this page" if target == f else target.name
                    broken.append((source, url, f'no id="{fragment}" in {where}'))

    for source, url, why in broken:
        print(f"broken: {url}  ({why}, in {source})")
    if broken:
        print(f"\n{len(broken)} broken of {checked} links and {fragments} fragments")
        return 1
    print(f"all {checked} links and {fragments} fragments resolve, across {len(files)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
