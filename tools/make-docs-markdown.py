#!/usr/bin/env python3
"""Write a Markdown copy of every docs page, for AI tools that read Markdown.

    python3 tools/make-docs-markdown.py            # write the copies
    python3 tools/make-docs-markdown.py --check    # exit 1 if a copy is missing or stale

Each page in docs/sitemap.xml gets a Markdown copy beside it: docs/guide.html
gets docs/guide.md, and the home page gets docs/index.html.md. That is the
llms.txt convention: the page's URL with .md added, or index.html.md for a URL
that ends in a slash. The copy holds everything in the page's <main>. Coding assistants and agents fetch
documentation as they work and do better with Markdown than with a page full of
layout. Search engines read the HTML, and nothing about the HTML changes here.

The copies are generated, so the HTML stays the only thing anyone edits. --check
writes nothing and exits 1 when a copy is missing or out of date, which is what
CI runs. The npm version script runs this after stamping, because the home page
names the version in its download link.

Links become absolute URLs on the published site, because a Markdown file is
often read somewhere other than where it is served. Images keep their alt text.

Every page has to carry a <link rel="alternate" type="text/markdown"> to its
copy, which is how a tool that has the HTML finds the Markdown. A page without
one stops the run, so a new page cannot quietly be left out.

docs/.nojekyll must exist. Without it GitHub Pages runs Jekyll, which turns
every .md file into an HTML page and would put guide.md in the place of
guide.html.

Standard library only, and Python 3.8 like the rest of the tools. The pages use
a small, fixed set of elements, and an element outside that set stops the run
rather than being dropped, so a page that grows a new kind of markup fails here
instead of losing content.
"""

import argparse
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
SITEMAP = DOCS / "sitemap.xml"
BASE_URL = "https://benjamindehli.github.io/microsampler-editor-librarian/"
TOOL = "tools/make-docs-markdown.py"

# Elements that hold other blocks and add nothing of their own.
CONTAINERS = {"main", "section", "div", "picture", "figure"}
# Elements read as running text.
INLINE = {"a", "strong", "b", "em", "code", "kbd", "span"}
# Elements a reader of the Markdown does not need: icons, the media sources
# (the poster or <img> stands in for them) and the footer, which repeats the
# top menu. The "On this page" list (nav.toc) and the social buttons
# (div.social) are skipped by class below.
SKIPPED = {"source", "track", "svg", "path", "button", "footer"}
VOID = {"img", "source", "track", "br", "hr", "meta", "link", "input"}
KNOWN = (
    CONTAINERS
    | INLINE
    | SKIPPED
    | {"h1", "h2", "h3", "p", "ul", "ol", "li", "pre", "table", "tr", "th", "td"}
    | {"img", "nav", "video", "figcaption"}
)


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = dict(attrs)
        self.parent = parent
        self.children = []

    def classes(self):
        return (self.attrs.get("class") or "").split()

    def find_all(self, tag):
        for child in self.children:
            if isinstance(child, Node):
                if child.tag == tag:
                    yield child
                yield from child.find_all(tag)

    def has_block(self):
        return any(isinstance(c, Node) and c.tag not in INLINE for c in self.children)


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {}, None)
        self.current = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.current.children.append(Node(tag, attrs, self.current))

    def handle_endtag(self, tag):
        node = self.current
        while node is not None and node.tag != tag:
            node = node.parent
        if node is not None and node.parent is not None:
            self.current = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def plain(node):
    """Every piece of text inside a node, with no markup."""
    for child in node.children:
        if isinstance(child, str):
            yield child
        else:
            yield from plain(child)


def escape(text):
    # An underscore inside a word, as in bank_01, is literal in Markdown already.
    text = re.sub(r"([\\`*\[\]<])", r"\\\1", text)
    return re.sub(r"(?<!\w)_|_(?!\w)", r"\\_", text)


class Renderer:
    def __init__(self, page_url, source):
        self.page_url = page_url
        self.source = source

    def fail(self, message):
        sys.exit(f"{self.source}: {message}")

    def url(self, href):
        return urljoin(self.page_url, href)

    def inline(self, node, raw=False):
        out = []
        for child in node.children:
            if isinstance(child, str):
                out.append(child if raw else escape(child))
                continue
            tag = child.tag
            if tag not in KNOWN:
                self.fail(f"<{tag}> is not handled, add it to {TOOL}")
            if tag in SKIPPED:
                continue
            if tag in ("code", "kbd"):
                out.append("`" + self.inline(child, raw=True) + "`")
            elif tag in ("strong", "b"):
                out.append("**" + self.inline(child).strip() + "**")
            elif tag == "em":
                out.append("*" + self.inline(child).strip() + "*")
            elif tag == "a":
                text = re.sub(r"\s+", " ", self.inline(child)).strip()
                out.append(f"[{text}]({self.url(child.attrs['href'])})")
            elif tag == "span":
                out.append(self.inline(child))
            else:
                self.fail(f"<{tag}> inside running text is not handled")
        return "".join(out)

    def text(self, node):
        # A non-breaking space in the HTML is only there to keep words together
        # on screen, so it becomes a plain space.
        return re.sub(r"\s+", " ", self.inline(node).replace("\u00a0", " ")).strip()

    def image(self, img):
        alt = escape(img.attrs.get("alt", ""))
        return f"![{alt}]({self.url(img.attrs['src'])})"

    def blocks(self, node):
        out = []
        pending = Node("p", {}, node)

        def flush():
            if any(isinstance(c, Node) or c.strip() for c in pending.children):
                out.append(self.text(pending))
            pending.children.clear()

        for child in node.children:
            if isinstance(child, str) or (child.tag in INLINE and not child.has_block()):
                pending.children.append(child)
                continue
            flush()
            out.extend(self.block(child))
        flush()
        return out

    def block(self, node):
        tag = node.tag
        classes = node.classes()
        if tag not in KNOWN:
            self.fail(f"<{tag}> is not handled, add it to {TOOL}")
        if tag in SKIPPED or (tag == "nav" and "toc" in classes) or "social" in classes:
            return []
        if tag == "div" and "note" in classes:
            # A note box: a label and a paragraph or two, kept together as a quote.
            inner = self.blocks(node)
            return ["\n>\n".join("> " + b.replace("\n", "\n> ") for b in inner)]
        if tag == "a":
            # A card: a link wrapped round a heading and a line of text.
            parts = self.blocks(node)
            href = self.url(node.attrs["href"])
            if parts and parts[0].startswith("### "):
                parts[0] = f"### [{parts[0][4:]}]({href})"
                return parts
            self.fail("a link round blocks must start with an <h3>")
        if tag in CONTAINERS:
            return self.blocks(node)
        if tag in ("h1", "h2", "h3"):
            # Bold in a heading is only styling (micro<b>SAMPLER</b>). Literal
            # asterisks are escaped by then, so removing ** is safe.
            return ["#" * int(tag[1]) + " " + self.text(node).replace("**", "")]
        if tag in ("p", "figcaption", "b", "strong"):
            return [self.text(node)]
        if tag == "img":
            return [self.image(node)]
        if tag == "video":
            # The poster stands in for the video, described by its own label.
            alt = escape(node.attrs.get("aria-label", ""))
            return [f"![{alt}]({self.url(node.attrs['poster'])})"]
        if tag in ("ul", "ol"):
            items = [c for c in node.children if isinstance(c, Node)]
            lines = []
            for n, item in enumerate(items, 1):
                if item.tag != "li":
                    self.fail(f"<{item.tag}> directly inside <{tag}>")
                if item.has_block():
                    self.fail("a list item holding blocks is not handled")
                marker = f"{n}." if tag == "ol" else "-"
                lines.append(f"{marker} {self.text(item)}")
            return ["\n".join(lines)]
        if tag == "pre":
            # Plain text only. The <code> inside a <pre> must not add backticks
            # inside the fence.
            code = "".join(plain(node)).strip("\n")
            return ["```\n" + code + "\n```"]
        if tag == "table":
            rows = []
            for tr in node.find_all("tr"):
                cells = [self.text(c).replace("|", "\\|") for c in tr.children if isinstance(c, Node)]
                rows.append("| " + " | ".join(cells) + " |")
                if len(rows) == 1:
                    rows.append("|" + " --- |" * len(cells))
            return ["\n".join(rows)]
        self.fail(f"<{tag}> outside running text is not handled")


def pages():
    """(page URL, HTML path, Markdown path) for every page in the sitemap."""
    text = SITEMAP.read_text(encoding="utf-8")
    result = []
    for loc in re.findall(r"<loc>([^<]+)</loc>", text):
        if not loc.startswith(BASE_URL):
            sys.exit(f"sitemap.xml has a page outside {BASE_URL}: {loc}")
        name = loc[len(BASE_URL) :]
        if name:
            result.append((loc, DOCS / f"{name}.html", DOCS / f"{name}.md"))
        else:
            result.append((loc, DOCS / "index.html", DOCS / "index.html.md"))
    return result


def convert(url, html_path, md_path):
    source = html_path.relative_to(ROOT).as_posix()
    html = html_path.read_text(encoding="utf-8")
    link = f'<link rel="alternate" type="text/markdown" href="{md_path.name}" />'
    if link not in html:
        sys.exit(f"{source} has no {link}")

    builder = TreeBuilder()
    builder.feed(html)
    main = next(builder.root.find_all("main"), None)
    if main is None or next(main.find_all("h1"), None) is None:
        sys.exit(f"{source} needs a <main> with an <h1> in it")

    renderer = Renderer(url, source)
    parts = [f"<!-- Generated from {source} by {TOOL}. Edit the HTML, then run npm run docs-markdown. -->"]
    body = renderer.blocks(main)
    # The page's own heading comes first, then where the page lives.
    parts.append(body[0])
    parts.append(f"Web page: {url}")
    parts.extend(body[1:])
    return "\n\n".join(p for p in parts if p) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report missing or stale copies, write nothing")
    args = ap.parse_args()

    if not (DOCS / ".nojekyll").exists():
        sys.exit("docs/.nojekyll is missing, so GitHub Pages would turn the copies into HTML pages")

    stale = []
    for url, html_path, md_path in pages():
        text = convert(url, html_path, md_path)
        if md_path.exists() and md_path.read_text(encoding="utf-8") == text:
            continue
        stale.append(md_path.relative_to(ROOT).as_posix())
        if not args.check:
            md_path.write_text(text, encoding="utf-8")

    if not stale:
        print("Markdown copies are up to date")
        return 0
    if args.check:
        print(f"stale: {', '.join(stale)}")
        print("run npm run docs-markdown and commit the result")
        return 1
    print(f"wrote {', '.join(stale)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
