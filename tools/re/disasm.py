#!/usr/bin/env python3
"""
Disassembly helper for the original microSAMPLER editor (i386 slice of the fat
Mach-O). Resolves call targets to symbol names and annotates C-string refs.

Setup (one-off):
    python3 -m venv /tmp/revenv && /tmp/revenv/bin/pip install capstone
    python3 tools/re/extract_pkg.py            # -> /tmp/pkg_extract/...

Usage:
    MSAMPLER_BIN="/tmp/pkg_extract/microSAMPLER Editor Librarian.app/Contents/MacOS/microSAMPLER Editor Librarian" \
        /tmp/revenv/bin/python tools/re/disasm.py <mangledSymbol> [<symbol> ...]

You can also `import disasm` and call dis(name, limit=) or use the parsed
tables: secs, addr2name, byname, data, base.

Key already-decoded symbols:
    __ZN12SysExCommand12getSysExDataERN4juce11MemoryBlockEb   (SysEx builder + 7-bit enc)
    __ZN12SysExCommand14m_commandDescsE                       (command table, in __TEXT,__const @0x232e40)
    __ZN11SampleWrite7processEv                               (3-phase upload)
    __ZNK10SampleData21getPackedSampleHeaderEv                (8-byte header)
    __ZNK10SampleData24getPackedSampleParameterEv             (64-byte param blob)
    __ZN19DirectUsbAccessBase11sendCommandER12SysExCommandiP17UsbAccessCallback
"""
import struct as st, sys, bisect, os

BIN = os.environ.get("MSAMPLER_BIN",
    "/tmp/pkg_extract/microSAMPLER Editor Librarian.app/Contents/MacOS/microSAMPLER Editor Librarian")
data = open(BIN, "rb").read()

# Locate the i386 (cputype 7) slice of the fat binary.
base = None
magic, nfat = st.unpack('>II', data[:8])
off = 8
for _ in range(nfat):
    cputype, cpusub, offset, size, align = st.unpack('>IIIII', data[off:off + 20])
    if cputype == 7:
        base = offset
    off += 20
assert base is not None, "no i386 slice"

ncmds = st.unpack('<I', data[base + 16:base + 20])[0]
o = 28; secs = {}; symtab = None
for _ in range(ncmds):
    cmd, cs = st.unpack('<II', data[base + o:base + o + 8])
    if cmd == 1:
        ns = st.unpack('<I', data[base + o + 48:base + o + 52])[0]; so = o + 56
        for _ in range(ns):
            sn = data[base + so:base + so + 16].rstrip(b'\0').decode()
            sg = data[base + so + 16:base + so + 32].rstrip(b'\0').decode()
            ad, sz, of = st.unpack('<III', data[base + so + 32:base + so + 44])
            secs[(sg, sn)] = (ad, of, sz); so += 68
    elif cmd == 2:
        symtab = st.unpack('<IIII', data[base + o + 8:base + o + 24])
    o += cs
symoff, nsyms, stroff, strsize = symtab

addr2name = {}; byname = {}; allsyms = []
for i in range(nsyms):
    e = base + symoff + i * 12
    strx, typ, sect, desc = st.unpack('<IBBH', data[e:e + 8]); val = st.unpack('<I', data[e + 8:e + 12])[0]
    nend = data.index(b'\0', base + stroff + strx); name = data[base + stroff + strx:nend]
    if val > 0:
        addr2name.setdefault(val, name); byname.setdefault(name, val)
        if (typ & 0x0e) == 0x0e:
            allsyms.append((val, name))
allsyms.sort(); idxs = [a for a, _ in allsyms]

taddr, toff, tsize = secs[('__TEXT', '__text')]
caddr, coff, csize = secs[('__TEXT', '__cstring')]


def flen(a):
    j = bisect.bisect_right(idxs, a)
    return (idxs[j] - a) if j < len(idxs) else 400


def cstr(addr):
    if caddr <= addr < caddr + csize:
        of = base + coff + (addr - caddr); end = data.index(b'\0', of)
        return data[of:end].decode('latin1')
    return None


def read_const(addr, n):
    """Read n bytes from whichever section contains vmaddr `addr`."""
    for (sg, sn), (ad, of, sz) in secs.items():
        if ad <= addr < ad + sz:
            o = base + of + (addr - ad)
            return data[o:o + n]
    return None


def dis(name, limit=900):
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    a = byname.get(name.encode()) if isinstance(name, str) else name
    if not a:
        print("MISSING", name); return
    L = min(flen(a), limit)
    code = data[base + toff + (a - taddr):base + toff + (a - taddr) + L]
    print(f"\n===== {name} @0x{a:x} (len {L}) =====")
    for ins in md.disasm(code, a):
        line = f"0x{ins.address:x}: {ins.mnemonic} {ins.op_str}"
        if ins.mnemonic == 'call' and ins.op_str.startswith('0x'):
            t = int(ins.op_str, 16)
            if t in addr2name:
                line += " ; -> " + addr2name[t].decode()
        for tok in ins.op_str.replace(',', ' ').split():
            if tok.startswith('0x'):
                try:
                    s = cstr(int(tok, 16))
                    if s:
                        line += f' ; "{s[:60]}"'
                except Exception:
                    pass
        print(line)


if __name__ == "__main__":
    for n in sys.argv[1:]:
        dis(n)
