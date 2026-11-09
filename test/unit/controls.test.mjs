// Unit tests for the hardware-verified value encoders in controls.js
// (tune cents curve, pan/level formatters, signed-14-bit decode).
//
// controls.js wires DOM handlers at import time, so we install a minimal
// `document` stub first, then DYNAMICALLY import it (static imports are hoisted
// and would run before the stub is set). Only the pure exports are exercised.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.document = { querySelector: () => ({ querySelectorAll: () => [] }) };
const {
    tuneCents,
    tuneDisplay,
    fmtPan,
    fmtLevel,
    dec14,
    BIPOLAR,
    PARAM,
    OBJ_BASE,
    DEFAULT_CC_MAP,
    ccToParamValue,
    getCcForParam,
    assignParamCC,
    unassignParamCC
} = await import("../../src/web-editor/components/controls/controls.js");

test("tuneCents: 0..127 wire → −99..+99 cents (hardware-measured curve)", () => {
    // edges clamp to ±99
    assert.equal(tuneCents(0), -99);
    assert.equal(tuneCents(2), -99);
    assert.equal(tuneCents(127), 99);
    assert.equal(tuneCents(126), 99);
    // coarse steps of 5 near the edges
    assert.equal(tuneCents(3), -95);
    assert.equal(tuneCents(11), -55);
    assert.equal(tuneCents(117), 55);
    assert.equal(tuneCents(125), 95);
    // fine linear halves around the centre detent
    assert.equal(tuneCents(12), -50);
    assert.equal(tuneCents(61), -1);
    assert.equal(tuneCents(67), 1);
    assert.equal(tuneCents(116), 50);
    // 4-wire centre detent reads 0
    for (const w of [62, 63, 64, 65, 66]) assert.equal(tuneCents(w), 0);
});

test("tuneDisplay formats with a sign", () => {
    assert.equal(tuneDisplay(12), "-50");
    assert.equal(tuneDisplay(64), "0");
    assert.equal(tuneDisplay(116), "+50");
});

test("fmtPan: 64 = centre, below = Lx, above = Rx", () => {
    assert.equal(fmtPan(64), "CNT");
    assert.equal(fmtPan(0), "L64");
    assert.equal(fmtPan(32), "L32");
    assert.equal(fmtPan(96), "R32");
    assert.equal(fmtPan(127), "R63");
});

test("dec14: signed 14-bit two's-complement decode", () => {
    assert.equal(dec14(0), 0);
    assert.equal(dec14(24), 24);
    assert.equal(dec14(8191), 8191);
    assert.equal(dec14(8192), -8192);
    assert.equal(dec14(16383), -1);
    assert.equal(dec14(16360), -24); // SEMITONE −24 = raw 0x3FE8 (hardware fact)
});

test("fmtLevel returns a display string", () => {
    assert.equal(typeof fmtLevel(101), "string");
    assert.ok(fmtLevel(101).length > 0);
    // out-of-table index falls back to the raw number
    assert.equal(fmtLevel(99999), "99999");
});

test("param-id constants and bipolar set are as hardware-confirmed", () => {
    assert.equal(OBJ_BASE, 16);
    assert.equal(PARAM.LEVEL, 24);
    assert.equal(PARAM.TUNE, 28);
    assert.equal(PARAM.SEMITONE, 27);
    assert.ok(BIPOLAR.has(PARAM.SEMITONE));
    assert.ok(BIPOLAR.has(PARAM.VELO_INT));
    assert.ok(!BIPOLAR.has(PARAM.LEVEL));
});

test("ccToParamValue scales 7-bit CC (0..127) to each parameter's model range", () => {
    // 0..127 faders pass through directly
    assert.equal(ccToParamValue(PARAM.LEVEL, 0), 0);
    assert.equal(ccToParamValue(PARAM.LEVEL, 101), 101);
    assert.equal(ccToParamValue(PARAM.LEVEL, 127), 127);
    assert.equal(ccToParamValue(PARAM.PAN, 64), 64);

    // bipolar SEMITONE (-24..+24) with centre detent at CC=64
    assert.equal(ccToParamValue(PARAM.SEMITONE, 0), -24);
    assert.equal(ccToParamValue(PARAM.SEMITONE, 64), 0);
    assert.equal(ccToParamValue(PARAM.SEMITONE, 127), 24);

    // bipolar VELO_INT (-63..+63) with centre at CC=64
    assert.equal(ccToParamValue(PARAM.VELO_INT, 0), -63);
    assert.equal(ccToParamValue(PARAM.VELO_INT, 64), 0);
    assert.equal(ccToParamValue(PARAM.VELO_INT, 127), 63);

    // switches: <64 -> 0, >=64 -> 1
    assert.equal(ccToParamValue(PARAM.LOOP, 0), 0);
    assert.equal(ccToParamValue(PARAM.LOOP, 63), 0);
    assert.equal(ccToParamValue(PARAM.LOOP, 64), 1);
    assert.equal(ccToParamValue(PARAM.LOOP, 127), 1);

    // 3-way BPM_SYNC segmented switch: 0, 1, 2
    assert.equal(ccToParamValue(PARAM.BPM_SYNC, 0), 0);
    assert.equal(ccToParamValue(PARAM.BPM_SYNC, 64), 1);
    assert.equal(ccToParamValue(PARAM.BPM_SYNC, 127), 2);
});

test("per-slot MIDI CC mapping isolates bindings per sample slot", () => {
    assert.equal(DEFAULT_CC_MAP[7], PARAM.LEVEL);
    // Pin CC#7 to slot 2 (SMPL 03) LEVEL and CC#14 to slot 0 (SMPL 01) LEVEL
    assignParamCC(PARAM.LEVEL, 7, 2);
    assignParamCC(PARAM.LEVEL, 14, 0);
    assert.equal(getCcForParam(PARAM.LEVEL, 2), 7);
    assert.equal(getCcForParam(PARAM.LEVEL, 0), 14);
    assert.equal(getCcForParam(PARAM.LEVEL, 1), null);

    // Rebinding CC#7 to slot 0 replaces slot 2's binding for CC#7
    assignParamCC(PARAM.PAN, 7, 0);
    assert.equal(getCcForParam(PARAM.LEVEL, 2), null);
    assert.equal(getCcForParam(PARAM.PAN, 0), 7);

    // Unassigning clears only that slot's parameter binding
    assert.equal(unassignParamCC(PARAM.PAN, 0), 7);
    assert.equal(getCcForParam(PARAM.PAN, 0), null);
    assert.equal(unassignParamCC(PARAM.LEVEL, 0), 14);
});
