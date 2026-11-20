#!/usr/bin/env python3
"""Tell the search engines that take IndexNow which docs pages just changed.

Run from anywhere:  python3 tools/indexnow.py [--since WHEN] [--every-page] [--dry-run]

IndexNow is how Bing, and through it the answer engines that read Bing's
index, plus Yandex, Seznam and Naver, hear that a page changed, so they fetch
it again now rather than whenever their crawler next comes round.

A page counts as changed when its <lastmod> in docs/sitemap.xml differs from
what the sitemap said at --since, or when the page is new. The dates are
stamped from git history by npm version (tools/stamp-docs-dates.mjs), so a
page's date is when its content last changed, often well before the stamp.
Asking "which dates changed lately" catches that, where "which pages are dated
today" would miss it.

The Pages workflow runs this with --every-page once it has published the
site, since the pages a release changed may be dated days before it. The
default window of 26 hours is for a run by hand.

The key file is the one at the root of benjamindehli.github.io, which another
site on the same host already serves. A key at the root of a host covers every
address on it, /microsampler-editor-librarian/ included. The key is public by
design: anyone can read it from that file.

Standard library only, and Python 3.8 like the rest of the tools.
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITEMAP = "docs/sitemap.xml"
HOST = "benjamindehli.github.io"
KEY = "a842ed43022d4f0db0527dbde835b9ad"
ENDPOINT = "https://api.indexnow.org/indexnow"

URL_ENTRY = re.compile(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>")


def git(*args):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=False
    )


def dated(sitemap):
    """{page URL: lastmod} for every page in a sitemap's text."""
    return dict(URL_ENTRY.findall(sitemap))


def sitemap_at(since):
    """The sitemap as it was at a point in time, or "" if there was none."""
    base = git("rev-list", "-1", f"--before={since}", "HEAD").stdout.strip()
    if not base:
        return ""
    shown = git("show", f"{base}:{SITEMAP}")
    return shown.stdout if shown.returncode == 0 else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--since", default="26 hours ago", help="compare with the sitemap as it was then"
    )
    ap.add_argument("--every-page", action="store_true", help="send every page in the sitemap")
    ap.add_argument("--dry-run", action="store_true", help="list the pages, send nothing")
    args = ap.parse_args()

    if git("rev-parse", "--is-shallow-repository").stdout.strip() == "true":
        sys.exit("this needs the full history, so check out with fetch-depth: 0")

    now = dated((ROOT / SITEMAP).read_text(encoding="utf-8"))
    if args.every_page:
        urls = sorted(now)
    else:
        before = dated(sitemap_at(args.since))
        urls = sorted(url for url, day in now.items() if before.get(url) != day)

    if not urls:
        print(f"no page's date changed since {args.since}, nothing to send")
        return 0

    for url in urls:
        print(f"  {url}")
    if args.dry_run:
        print(f"dry run: {len(urls)} page(s) would be sent")
        return 0

    body = json.dumps(
        {
            "host": HOST,
            "key": KEY,
            "keyLocation": f"https://{HOST}/{KEY}.txt",
            "urlList": urls,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT, data=body, headers={"Content-Type": "application/json; charset=utf-8"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(f"IndexNow answered {response.status} for {len(urls)} page(s)")
    except urllib.error.HTTPError as e:
        # 403 is a key the file does not match, 422 an address outside the
        # key's host. Both are a setup fault worth failing on.
        print(f"IndexNow answered {e.code}: {e.read().decode(errors='replace')}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
