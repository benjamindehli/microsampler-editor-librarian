#!/usr/bin/env python3
"""
Extract the complete EFFECT parameter tables from the original editor binary
and emit web-editor/js/fxData.js.

The tables live in BSS (EffectParameterTable::m_fxTypes @0x39f420, 22 x 68B;
::m_fxParameters @0x399120, 22 x 32 x 36B) and are populated by static-init
code, so this script INTERPRETS the initializer (plain `mov [abs], imm` +
juce::String(const char*) calls) instead of reading data sections.

Field maps (from EffectParameterAccessor disassembly):
  FxParamDescriptor (36B): +0 String name, +4 visible, +8 min, +0xc max,
    +0x10 center, +0x14 knobAssignable, +0x18 controlType (1 knob / 3 select
    / 4 switch), +0x1c default, +0x20 String valueTableKey.
  FxTypeDescriptor (68B): +0 String name, +8/+0xc default knob assigns,
    +0x14.. two conditional-pair groups (tempo-sync alternates),
    +0x3c/+0x40 follow rule (param i40+1 enabled iff val(i40) != 0).
Value semantics (EditEffectParameterAction::perform + set/getParameterDirect):
  wire value = DISPLAY value (signed; negatives are 14-bit two's-complement),
  stored/blob byte = display + center.

Usage:  /tmp/revenv/bin/python tools/re/extract_fx.py   (needs capstone venv +
        extracted pkg; see disasm.py header)
"""
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import disasm as D            # noqa: E402
import capstone               # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
XML = os.path.join(os.path.dirname(D.BIN), '..', 'Resources', 'ParameterStrings.xml')
OUT = os.path.join(REPO, 'web-editor', 'js', 'fxData.js')

PARAMS_BASE, TYPES_BASE = 0x399120, 0x39f420
INIT_START, INIT_END = 0x24d17a, 0x259244
MEMSET, STRING_C1 = 0x3a0606, 0xa4614


def cstr(addr):
    for (seg, sec), (a, o, s) in D.secs.items():
        if sec == '__cstring' and a <= addr < a + s:
            raw = D.data[D.base + o + (addr - a):D.base + o + (addr - a) + 96]
            return raw.split(b'\0')[0].decode('latin1')
    return None


def interpret_init():
    """Run the static initializer symbolically; collect memory + strings."""
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    ad, of, _ = D.secs[('__TEXT', '__StaticInit')]
    code = D.data[D.base + of + (INIT_START - ad):D.base + of + (INIT_END - ad)]
    mem, strs, esp = {}, {}, {}
    lo, hi = PARAMS_BASE, TYPES_BASE + 22 * 68
    re_esp = re.compile(r'(dword|byte) ptr \[esp(?: \+ (0x[0-9a-f]+|\d+))?\], (0x[0-9a-f]+|\d+)$')
    re_abs = re.compile(r'(dword|byte) ptr \[(0x[0-9a-f]+)\], (0x[0-9a-f]+|\d+)$')
    for ins in md.disasm(code, INIT_START):
        if ins.mnemonic == 'mov':
            m = re_esp.match(ins.op_str)
            if m:
                esp[int(m.group(2) or '0', 0)] = int(m.group(3), 0)
                continue
            m = re_abs.match(ins.op_str)
            if m:
                a, v = int(m.group(2), 0), int(m.group(3), 0)
                if lo <= a < hi:
                    if m.group(1) == 'dword':
                        for i in range(4):
                            mem[a + i] = (v >> (8 * i)) & 0xff
                    else:
                        mem[a] = v & 0xff
        elif ins.mnemonic == 'call':
            try:
                tgt = int(ins.op_str, 0)
            except ValueError:
                esp = {}
                continue
            dst, a1, a2 = esp.get(0), esp.get(4), esp.get(8)
            if tgt == MEMSET and dst is not None and lo <= dst < hi:
                for i in range(a2 or 0):
                    mem[dst + i] = 0
            elif tgt == STRING_C1 and dst is not None and lo <= dst < hi:
                strs[dst] = cstr(a1) or ''
            esp = {}
    return mem, strs


def extract(mem, strs):
    def rd32(a):
        v = mem.get(a, 0) | mem.get(a + 1, 0) << 8 | mem.get(a + 2, 0) << 16 | mem.get(a + 3, 0) << 24
        return v - (1 << 32) if v >= 1 << 31 else v

    def rd8(a):
        return mem.get(a, 0)

    # per-fx enable ranges from the isEnable jump table @0x236800 (fx 7..19)
    RANGES = {7: ((3, 5), (6, 8)), 8: ((2, 5), (6, 9)),
              9: ((2, 4), (5, 7)), 10: ((2, 4), (5, 7)), 11: ((2, 4), (5, 7)),
              18: ((2, 3), (4, 5)), 19: ((4, 5), (6, 7))}
    # hardcoded isEnable special cases (fx, param, cond-param, predicate)
    HARD = {3: [(4, 2, 'eq0'), (14, 12, 'eq0')],
            6: [(2, 1, 'le3'), (3, 1, 'gt3')],
            17: [(2, 1, 'eq0'), (3, 1, 'ne0'), (4, 1, 'ne0')]}
    # hardcoded setKnobAssign swap pairs (fx -> (off-param, on-param, cond,
    # predicate-for-ON)) — Reverb time long/short, RingMod fixed-freq/note
    HARD_SWAP = {6: (2, 3, 1, 'gt3'), 17: (2, 3, 1, 'ne0')}

    fxs = []
    for t in range(22):
        tb = TYPES_BASE + t * 68
        rules, swaps = [], []
        if rd8(tb + 0x24):                       # pair group (tempo-sync swap)
            cond, off_p, on_p = rd32(tb + 0x28), rd32(tb + 0x2c), rd32(tb + 0x30)
            rules += [{'p': off_p, 'cond': cond, 'when': 'eq0'},
                      {'p': on_p, 'cond': cond, 'when': 'ne0'}]
            swaps.append({'off': off_p, 'on': on_p, 'cond': cond, 'when': 'ne0'})
        if rd8(tb + 0x14):                       # g1 pair (knob-assign swap)
            cond = rd32(tb + 0x20)
            off_p, on_p = rd32(tb + 0x18), rd32(tb + 0x1c)
            swaps.append({'off': off_p, 'on': on_p, 'cond': cond, 'when': 'ne0'})
            if t in RANGES:                      # range group (delay types)
                (olo, ohi), (nlo, nhi) = RANGES[t]
                rules += [{'p': p, 'cond': cond, 'when': 'eq0'} for p in range(olo, ohi + 1)]
                rules += [{'p': p, 'cond': cond, 'when': 'ne0'} for p in range(nlo, nhi + 1)]
        if rd8(tb + 0x3c):                       # follow rule
            cond = rd32(tb + 0x40)
            rules.append({'p': cond + 1, 'cond': cond, 'when': 'ne0'})
        for (p, c, w) in HARD.get(t, []):
            rules.append({'p': p, 'cond': c, 'when': w})
        if t in HARD_SWAP:
            off_p, on_p, c, w = HARD_SWAP[t]
            swaps.append({'off': off_p, 'on': on_p, 'cond': c, 'when': w})

        params = []
        for p in range(32):
            pb = PARAMS_BASE + (t * 32 + p) * 36
            name = strs.get(pb, '')
            if not name or not rd8(pb + 4):      # invisible / unused slot
                continue
            params.append({
                'idx': p, 'name': name,
                'min': rd32(pb + 8), 'max': rd32(pb + 0xc),
                'center': rd32(pb + 0x10), 'def': rd32(pb + 0x1c),
                'type': rd32(pb + 0x18),         # 1 knob / 3 select / 4 switch
                'knob': rd8(pb + 0x14),
                'table': strs.get(pb + 0x20, 'Value'),
            })
        fxs.append({'name': strs.get(tb, '?').strip(),
                    'knobs': [rd32(tb + 8), rd32(tb + 0xc)],
                    'params': params, 'rules': rules, 'swaps': swaps})
    return fxs


def xml_tables():
    """The ms/Hz tables valueTables.js never included."""
    raw = open(XML, encoding='utf-8', errors='replace').read()
    out = {}
    for tbl in ['FxDelay_0_30', 'FxDelay_0_50', 'FxDelay_0_350',
                'FxDelay_0_500', 'FxDelay_0_1400', 'FxFreq_0_12000']:
        m = re.search(r'<%s>(.*?)</%s>' % (tbl, tbl), raw, re.S)
        out[tbl] = re.findall(r'Text="([^"]*)"', m.group(1)) if m else []
    return out


def main():
    mem, strs = interpret_init()
    fxs = extract(mem, strs)
    assert len(fxs) == 22 and fxs[1]['name'] == 'Compressor'
    assert fxs[21]['name'] == 'Looper' and fxs[0]['params'] == []
    assert any(p['name'] == 'B1 Gain' and p['min'] == -36 and p['center'] == 64
               for p in fxs[3]['params'])
    tables = xml_tables()
    assert len(tables['FxFreq_0_12000']) == 128

    with open(OUT, 'w') as f:
        f.write('// GENERATED by tools/re/extract_fx.py — DO NOT EDIT BY HAND.\n')
        f.write('// Effect descriptors from EffectParameterTable (static-init\n')
        f.write('// interpretation) + ms/Hz tables from ParameterStrings.xml.\n')
        f.write('// Wire: object 80; param 1 = FX type, 2-3 = knob assigns,\n')
        f.write('// 16+i = param i. Wire value = display value (signed-14 for\n')
        f.write('// negatives); bank-blob byte = display + center.\n')
        f.write('export const FX_TYPES = ')
        f.write(json.dumps(fxs, separators=(',', ':')))
        f.write(';\n\nexport const FX_TABLES_EXTRA = ')
        f.write(json.dumps(tables, separators=(',', ':')))
        f.write(';\n')
    n = sum(len(f_['params']) for f_ in fxs)
    print('extract_fx: %d fx types, %d params -> %s' % (len(fxs), n, OUT))


if __name__ == '__main__':
    main()
