#!/usr/bin/env python3
"""
Extract the original 'microSAMPLER Editor.pkg' payload so we can inspect/
disassemble the app binary. The payload is a gzip'd cpio (ODC, magic 070707).

Usage:
    python3 tools/re/extract_pkg.py [out_dir]
Default out_dir: /tmp/pkg_extract
The app binary then lives at:
    <out_dir>/microSAMPLER Editor Librarian.app/Contents/MacOS/microSAMPLER Editor Librarian
"""
import gzip, os, sys

PKG = os.path.join(os.path.dirname(__file__), "..", "..",
                   "microSAMPLER Editor.pkg", "Contents", "Archive.pax.gz")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pkg_extract"
    os.makedirs(out, exist_ok=True)
    data = gzip.open(os.path.abspath(PKG), "rb").read()
    pos = 0

    def field(n):
        nonlocal pos
        v = int(data[pos:pos + n], 8); pos += n
        return v

    count = 0
    while True:
        if data[pos:pos + 6] != b'070707':
            print("bad magic at", pos); break
        pos += 6
        for _ in range(6):  # dev, ino, mode... read mode at index 2
            pass
        # ODC fields: dev(6) ino(6) mode(6) uid(6) gid(6) nlink(6) rdev(6)
        # mtime(11) namesize(6) filesize(11)
        _dev = field(6); _ino = field(6); mode = field(6); _uid = field(6)
        _gid = field(6); _nlink = field(6); _rdev = field(6); _mtime = field(11)
        namesize = field(6); filesize = field(11)
        name = data[pos:pos + namesize - 1].decode('utf-8', 'replace'); pos += namesize
        fdata = data[pos:pos + filesize]; pos += filesize
        if name == "TRAILER!!!":
            break
        ftype = mode & 0o170000
        outp = os.path.join(out, name)
        if ftype == 0o040000:
            os.makedirs(outp, exist_ok=True)
        elif ftype == 0o120000:
            os.makedirs(os.path.dirname(outp), exist_ok=True)
            target = fdata.decode('utf-8', 'replace')
            if os.path.lexists(outp):
                os.remove(outp)
            os.symlink(target, outp)
        else:
            os.makedirs(os.path.dirname(outp), exist_ok=True)
            with open(outp, 'wb') as f:
                f.write(fdata)
        count += 1
    print(f"Extracted {count} entries to {out}")


if __name__ == "__main__":
    main()
