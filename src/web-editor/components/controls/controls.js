// Sample parameter controls: live-edit ids, value encodings, the control
// strip wiring, and panel-edit reflection.
import { state } from "functions/state.js";
import { tick } from "functions/ticker.js";
import { $, api, fmtSigned, jsonBody } from "functions/util.js";
import { VALUE_TABLES } from "functions/valueTables.js";

// Live-edit param ids — HARDWARE-CONFIRMED 2026-06-06 by panel-knob capture
// (the editor binary's converter table did NOT match the device's actual
// panel id scheme for the level/pan/semitone/tune/velo cluster — the device
// is authoritative). START/END are NOT live params (u32 frames > 14 bits);
// they're set via the param blob — see the waveform marker dragging.
export const PARAM = {
    LOOP: 16,
    BPM_SYNC: 17,
    REVERSE: 18,
    DECAY: 21,
    RELEASE: 22,
    LEVEL: 24,
    PAN: 25,
    FX_SW: 26,
    SEMITONE: 27,
    TUNE: 28,
    VELO_INT: 29
};
const AMP_LEVEL = VALUE_TABLES.AmpLevel || [];
export const fmtPan = (v) => (v === 64 ? "CNT" : v < 64 ? `L${64 - v}` : `R${v - 64}`);
export const fmtLevel = (v) => AMP_LEVEL[v] || String(v);

// Semitone/Velo Int travel as two's-complement 14-bit (signed model space on
// the slider; only RECEIVE needs decoding — pack14 handles the send side).
export const BIPOLAR = new Set([PARAM.SEMITONE, PARAM.VELO_INT]);
export const dec14 = (v) => (v >= 8192 ? v - 16384 : v);

// TUNE: 0..127 wire → −99..+99 cents, fully decoded from hardware (2026-06-06,
// exact at 35 measured points). The fine region is two linear halves around a
// centre detent — negative HW = wire−62, positive HW = wire−66, with wire
// 62..66 all reading 0 — and the panel's coarse settings step by 5 out to ±99.
export function tuneCents(w) {
    if (w <= 2) return -99;
    if (w < 12) return -50 - (12 - w) * 5; // wire 3..11   → −95..−55
    if (w < 62) return w - 62; // wire 12..61  → −50..−1
    if (w <= 66) return 0; // centre detent
    if (w <= 116) return w - 66; // wire 67..116 → +1..+50
    if (w >= 126) return 99;
    return 50 + (w - 116) * 5; // wire 117..125 → +55..+95
}
export const tuneDisplay = (wire) => fmtSigned(tuneCents(wire));
export const OBJ_BASE = 16;

// One descriptor per live-edit param — the single source of truth that drives
// caching, model readback, the control-strip wiring, setControl, and showSlot's
// init (this replaced five parallel switch/call blocks that each had to be kept
// in sync). kind: switch | fader | seg; key = the state.bank.slots[n] property;
// bool = stored as a boolean; fmt = display formatter for faders; def = the
// value shown for an empty slot.
const SPEC = {
    [PARAM.LOOP]: { kind: "switch", ctl: "#ctl-loop", val: "#val-loop", key: "loop", bool: true, def: 0 },
    [PARAM.REVERSE]: { kind: "switch", ctl: "#ctl-reverse", val: "#val-reverse", key: "reverse", bool: true, def: 0 },
    [PARAM.FX_SW]: { kind: "switch", ctl: "#ctl-fx", val: "#val-fx", key: "fx_sw", bool: true, def: 0 },
    [PARAM.BPM_SYNC]: { kind: "seg", ctl: "#ctl-sync", key: "bpm_sync", def: 0 },
    [PARAM.DECAY]: { kind: "fader", ctl: "#ctl-decay", val: "#val-decay", key: "decay", def: 127 },
    [PARAM.RELEASE]: { kind: "fader", ctl: "#ctl-release", val: "#val-release", key: "release", def: 0 },
    [PARAM.TUNE]: { kind: "fader", ctl: "#ctl-tune", val: "#val-tune", key: "tune", fmt: tuneDisplay, def: 64 },
    [PARAM.LEVEL]: { kind: "fader", ctl: "#ctl-level", val: "#val-level", key: "level", fmt: fmtLevel, def: 101 },
    [PARAM.PAN]: { kind: "fader", ctl: "#ctl-pan", val: "#val-pan", key: "pan", fmt: fmtPan, def: 64 },
    [PARAM.SEMITONE]: { kind: "fader", ctl: "#ctl-semitone", val: "#val-semitone", key: "semitone", fmt: fmtSigned, def: 0 },
    [PARAM.VELO_INT]: { kind: "fader", ctl: "#ctl-velo", val: "#val-velo", key: "velo_int", fmt: fmtSigned, def: 0 }
};

// keep the bank cache in sync with every edit — controls initialise from it
// on pad selection, so without this, re-selecting a pad showed the state as
// of the last RECEIVE. `v` is display/model space (signed for bipolar).
export function cacheParam(slot, param, v) {
    const s = state.bank?.slots?.[slot];
    if (!s || s.empty) return;
    const spec = SPEC[param];
    if (spec) s[spec.key] = spec.bool ? !!v : v;
}

// read a param's current MODEL value from the cache (inverse of cacheParam;
// same space the control setters + the wire `value` use)
function readModel(slot, param) {
    const s = state.bank?.slots?.[slot];
    if (!s || s.empty) return null;
    const spec = SPEC[param];
    if (!spec) return null;
    const v = s[spec.key];
    return spec.bool ? (v ? 1 : 0) : v;
}

// send a param to a SPECIFIC slot (model-space value): cache it, mirror the
// control if that slot is showing, POST it. Used by edits + undo/redo.
async function sendParamTo(slot, param, value) {
    cacheParam(slot, param, value);
    if (slot === state.sel) {
        flash(param);
        setControl(param, value);
    }
    try {
        await api("/api/param", jsonBody({ obj: OBJ_BASE + slot, param, value }));
        tick(`→ S${slot + 1} #${param} = ${value}`);
    } catch (e) {
        tick(`⚠ send failed: ${e.message}`);
    }
}

// ── undo / redo of sample param edits ────────────────────────────────────
const undoStack = [],
    redoStack = [];
async function sendParam(param, value) {
    if (state.sel == null) return;
    const before = readModel(state.sel, param);
    if (before !== value) {
        undoStack.push({ slot: state.sel, param, before, after: value });
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
    }
    await sendParamTo(state.sel, param, value);
}

async function step(stack, other, key, label) {
    const e = stack.pop();
    if (!e) return;
    other.push(e);
    const { selectSlot } = await import("components/pads/pads.js");
    if (e.slot !== state.sel) selectSlot(e.slot);
    await sendParamTo(e.slot, e.param, e[key]);
    tick(`${label} S${e.slot + 1} #${e.param}`);
}
export const undo = () => step(undoStack, redoStack, "before", "↶ undo");
export const redo = () => step(redoStack, undoStack, "after", "↷ redo");

export function flash(param) {
    const el = /** @type {HTMLElement} */ (document.querySelector(`[data-flash="${param}"]`));
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth; // restart transition
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 600);
}

// toggle switches
function wireSwitch(btnSel, valSel, param) {
    const btn = $(btnSel);
    btn.onclick = () => {
        const on = btn.getAttribute("aria-checked") !== "true";
        setSwitch(btnSel, valSel, on);
        sendParam(param, on ? 1 : 0);
    };
}
export function setSwitch(btnSel, valSel, on) {
    $(btnSel).setAttribute("aria-checked", String(on));
    $(valSel).textContent = on ? "ON" : "OFF";
}
// BPM Sync segmented switch (device rule: Pitch Change locks Tune)
function wireSeg(sel, param) {
    $(sel)
        .querySelectorAll("button")
        .forEach((b) => {
            b.onclick = () => {
                setSeg(+b.dataset.v);
                sendParam(param, +b.dataset.v);
            };
        });
}
export function setSeg(v) {
    $("#ctl-sync")
        .querySelectorAll("button")
        .forEach((b) => {
            b.classList.toggle("on", +b.dataset.v === v);
            b.setAttribute("aria-pressed", String(+b.dataset.v === v));
        });
    // device rule: Pitch Change disables Tune AND Semitone
    $("#tune-block").classList.toggle("locked", v === 2);
    $("#semitone-block").classList.toggle("locked", v === 2);
}

// faders — `fmt` (optional) maps the 0..127 byte to a display string
function wireFader(inSel, valSel, param, fmt) {
    const input = $(inSel);
    input.oninput = () => setFader(inSel, valSel, +input.value, fmt);
    input.onchange = () => sendParam(param, +input.value);
}
export function setFader(inSel, valSel, v, fmt) {
    $(inSel).value = v;
    $(valSel).textContent = fmt ? fmt(v) : String(v);
}

// wire every control from the descriptor table (each param exactly once)
for (const [k, spec] of Object.entries(SPEC)) {
    const param = +k;
    if (spec.kind === "switch") wireSwitch(spec.ctl, spec.val, param);
    else if (spec.kind === "fader") wireFader(spec.ctl, spec.val, param, spec.fmt);
    else if (spec.kind === "seg") wireSeg(spec.ctl, param);
}

// set a control from a MODEL-space value (no dec14 — that's the wire form)
function setControl(param, value) {
    const spec = SPEC[param];
    if (!spec) return;
    if (spec.kind === "switch") setSwitch(spec.ctl, spec.val, !!value);
    else if (spec.kind === "seg") setSeg(value);
    else setFader(spec.ctl, spec.val, value, spec.fmt);
}

// initialise the whole control strip from a slot's cached model values (or the
// device defaults when the slot is empty). Drives showSlot in slot.js.
export function applySlotControls(s) {
    for (const spec of Object.values(SPEC)) {
        if (spec.kind === "switch") {
            setSwitch(spec.ctl, spec.val, !s.empty && !!s[spec.key]);
        } else {
            const value = s.empty ? spec.def : (s[spec.key] ?? spec.def);
            if (spec.kind === "seg") setSeg(value);
            else setFader(spec.ctl, spec.val, value, spec.fmt);
        }
    }
}

export function reflect(param, value) {
    // from a device (wire) event
    flash(param);
    setControl(param, BIPOLAR.has(param) ? dec14(value) : value);
}
