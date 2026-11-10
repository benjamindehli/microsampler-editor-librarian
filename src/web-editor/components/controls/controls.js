// Sample parameter controls: live-edit ids, value encodings, the control
// strip wiring, panel-edit reflection, and external MIDI CC learn/control.
import { state } from "functions/state.js";
import { tick } from "functions/ticker.js";
import { $, api, closestEl, fmtSigned, jsonBody, lsGet, lsSet, setSegActive } from "functions/util.js";
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
    [PARAM.LOOP]: { kind: "switch", ctl: "#ctl-loop", val: "#val-loop", key: "loop", label: "LOOP", bool: true, def: 0 },
    [PARAM.REVERSE]: { kind: "switch", ctl: "#ctl-reverse", val: "#val-reverse", key: "reverse", label: "REVERSE", bool: true, def: 0 },
    [PARAM.FX_SW]: { kind: "switch", ctl: "#ctl-fx", val: "#val-fx", key: "fx_sw", label: "FX SW", bool: true, def: 0 },
    [PARAM.BPM_SYNC]: { kind: "seg", ctl: "#ctl-sync", key: "bpm_sync", label: "BPM SYNC", def: 0 },
    [PARAM.DECAY]: { kind: "fader", ctl: "#ctl-decay", val: "#val-decay", key: "decay", label: "DECAY", def: 127 },
    [PARAM.RELEASE]: { kind: "fader", ctl: "#ctl-release", val: "#val-release", key: "release", label: "RELEASE", def: 0 },
    [PARAM.TUNE]: { kind: "fader", ctl: "#ctl-tune", val: "#val-tune", key: "tune", label: "TUNE", fmt: tuneDisplay, def: 64 },
    [PARAM.LEVEL]: { kind: "fader", ctl: "#ctl-level", val: "#val-level", key: "level", label: "LEVEL", fmt: fmtLevel, def: 101 },
    [PARAM.PAN]: { kind: "fader", ctl: "#ctl-pan", val: "#val-pan", key: "pan", label: "PAN", fmt: fmtPan, def: 64 },
    [PARAM.SEMITONE]: { kind: "fader", ctl: "#ctl-semitone", val: "#val-semitone", key: "semitone", label: "SEMITONE", fmt: fmtSigned, def: 0 },
    [PARAM.VELO_INT]: { kind: "fader", ctl: "#ctl-velo", val: "#val-velo", key: "velo_int", label: "VELO INT", fmt: fmtSigned, def: 0 }
};

// Map a 7-bit MIDI CC value (0..127) into the target sample parameter's model space.
export function ccToParamValue(param, ccVal) {
    const v = Math.max(0, Math.min(127, Math.round(ccVal)));
    const spec = SPEC[param];
    if (!spec) return v;
    if (spec.kind === "switch") return v >= 64 ? 1 : 0;
    if (spec.kind === "seg") return Math.min(2, Math.floor((v * 3) / 128));
    if (param === PARAM.SEMITONE) return v === 64 ? 0 : Math.round((v / 127) * 48 - 24);
    if (param === PARAM.VELO_INT) return Math.max(-63, Math.min(63, v - 64));
    return v;
}

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
// cache a model value for `slot` and mirror it on the controls if that slot is showing
function applyLocal(slot, param, value) {
    cacheParam(slot, param, value);
    if (slot === state.sel) {
        flash(param);
        setControl(param, value);
    }
}
async function sendParamTo(slot, param, value) {
    applyLocal(slot, param, value);
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
function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0; // a new edit invalidates the redo history
}
async function sendParam(param, value) {
    if (state.sel == null) return;
    const before = readModel(state.sel, param);
    if (before !== value) {
        pushUndo({ slot: state.sel, param, before, after: value });
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

function flash(param) {
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
function setSwitch(btnSel, valSel, on) {
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
function setSeg(v) {
    setSegActive([...$("#ctl-sync").querySelectorAll("button")].map((b) => [b, +b.dataset.v === v]));
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
function setFader(inSel, valSel, v, fmt) {
    const text = fmt ? fmt(v) : String(v);
    $(inSel).value = v;
    $(inSel).setAttribute("aria-valuetext", text); // screen readers speak "+0.0dB", not "101"
    $(valSel).textContent = text;
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
    syncCcBadges();
}

export function reflect(param, value) {
    // from a device (wire) event
    flash(param);
    setControl(param, BIPOLAR.has(param) ? dec14(value) : value);
}

// ── external MIDI CC mapping + MIDI Learn (per-sample-slot) ──────────────
const CC_STORAGE_KEY = "msmpl.midi.cc.v2";
// bindable sources: real CCs 0..127 plus the pitch-bend wheel as pseudo-CC 128
export const PITCH_BEND_CC = 128;
/** @typedef {{ slot: number, param: number }} CcBinding */
/** @type {Record<number, CcBinding>} */
let ccMap = loadCcMap();
let learnMode = false;
let learnParam = PARAM.LEVEL;

function loadCcMap() {
    const raw = lsGet(CC_STORAGE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        /** @type {Record<number, CcBinding>} */
        const clean = {};
        for (const [k, v] of Object.entries(parsed)) {
            const cc = +k;
            if (!Number.isInteger(cc) || cc < 0 || cc > PITCH_BEND_CC || !v || typeof v !== "object") continue;
            const slot = +v.slot,
                param = +v.param;
            if (Number.isInteger(slot) && slot >= 0 && slot <= 35 && SPEC[param]) {
                clean[cc] = { slot, param };
            }
        }
        return clean;
    } catch {
        return {};
    }
}

function saveCcMap() {
    lsSet(CC_STORAGE_KEY, JSON.stringify(ccMap));
}

export function getCcForParam(param, slot = state.sel) {
    if (slot == null) return null;
    for (const [cc, b] of Object.entries(ccMap)) {
        if (b.slot === slot && b.param === param) return +cc;
    }
    return null;
}

export const hasCcBinding = (cc) => !!ccMap[cc];

export function assignParamCC(param, cc, slot = state.sel) {
    if (!SPEC[param] || cc < 0 || cc > PITCH_BEND_CC || slot == null || slot < 0 || slot > 35) return;
    for (const [k, b] of Object.entries(ccMap)) {
        if ((b.slot === slot && b.param === param) || +k === cc) delete ccMap[+k];
    }
    ccMap[cc] = { slot, param };
    saveCcMap();
    syncCcBadges();
}

export function unassignParamCC(param, slot = state.sel) {
    if (slot == null) return null;
    let removed = null;
    for (const [k, b] of Object.entries(ccMap)) {
        if (b.slot === slot && b.param === param) {
            removed = +k;
            delete ccMap[+k];
        }
    }
    if (removed != null) {
        saveCcMap();
        syncCcBadges();
    }
    return removed;
}

const paramLabel = (param) => SPEC[param]?.label || "#" + param;
const whoTag = () => (state.sel != null ? `S${state.sel + 1} ` : ""); // "S3 " prefix for ticker lines
const fmtCc = (cc) => (cc === PITCH_BEND_CC ? "PB" : `CC${String(cc).padStart(2, "0")}`);

export function syncCcBadges() {
    if (!document.querySelectorAll) return;
    const strip = $(".strip");
    if (strip?.classList) strip.classList.toggle("midi-learn", learnMode);
    const btn = $("#midi-learn");
    if (btn?.classList) {
        btn.classList.toggle("on", learnMode);
        btn.setAttribute("aria-pressed", String(learnMode));
    }
    const slot = state.sel;
    const slotTag = slot != null ? `S${String(slot + 1).padStart(2, "0")}` : "";
    for (const [k, spec] of Object.entries(SPEC)) {
        const param = +k;
        const el = /** @type {HTMLElement} */ (document.querySelector(`[data-flash="${param}"]`));
        if (!el || !el.classList) continue;
        const isTarget = learnMode && learnParam === param;
        el.classList.toggle("midi-target", isTarget);
        const cc = getCcForParam(param, slot);
        let badge = /** @type {HTMLElement} */ (el.querySelector(".ctl-cc"));
        if (cc != null || isTarget) {
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "ctl-cc";
                el.append(badge); // corner-pinned (absolute), so it never resizes the control
            }
            badge.textContent = isTarget && cc == null ? "LEARN" : fmtCc(cc);
        } else if (badge) {
            badge.remove();
        }
        el.title =
            cc != null
                ? `${slotTag} ${spec.label} - pinned to MIDI ${fmtCc(cc)} (click LEARN or right-click to reassign/clear)`
                : `${slotTag} ${spec.label} - right-click or use LEARN to pin a MIDI CC slider/knob to this sample`;
    }
}

export const isMidiLearnActive = () => learnMode;

export function setMidiLearn(on, targetParam = null) {
    learnMode = !!on;
    if (targetParam != null && SPEC[targetParam]) learnParam = targetParam;
    else if (learnMode && !SPEC[learnParam]) learnParam = PARAM.LEVEL;
    syncCcBadges();
    if (learnMode) {
        const label = SPEC[learnParam]?.label || `#${learnParam}`;
        const who = whoTag();
        tick(`MIDI learn: move a slider/knob to pin to ${who}${label} (click any control to switch, right-click to clear, Esc to exit)`);
    } else {
        tick("MIDI learn: OFF");
    }
}

// Coalesce rapid CC fader sweeps so at most one HTTP POST is in flight per
// (slot, param), always flushing the latest value when the current request completes.
const ccInFlight = new Set();
const ccPending = new Map();

function sendParamCoalesced(slot, param, value) {
    const key = `${slot}:${param}`;
    if (ccInFlight.has(key)) {
        ccPending.set(key, { slot, param, value });
        return;
    }
    ccInFlight.add(key);
    api("/api/param", jsonBody({ obj: OBJ_BASE + slot, param, value }))
        .then(() => {
            if (!ccPending.has(key)) tick(`-> S${slot + 1} ${paramLabel(param)} = ${value}`);
        })
        .catch((e) => tick(`! send failed: ${e.message}`))
        .finally(() => {
            ccInFlight.delete(key);
            const next = ccPending.get(key);
            if (next) {
                ccPending.delete(key);
                sendParamCoalesced(next.slot, next.param, next.value);
            }
        });
}

const CC_SWEEP_GAP_MS = 1500;

export function handleExternalCC(cc, ccVal) {
    if (learnMode && state.sel != null) {
        const param = learnParam;
        const slot = state.sel;
        assignParamCC(param, cc, slot);
        learnMode = false;
        syncCcBadges();
        tick(`MIDI learn: pinned ${fmtCc(cc)} -> S${slot + 1} ${paramLabel(param)}`);
    }
    const binding = ccMap[cc];
    if (!binding) return false; // unmapped: ignore silently (a wheel sweep would flood the ticker)
    const { slot, param } = binding;
    const s = state.bank?.slots?.[slot];
    // Respect hardware rule: Pitch Change (bpm_sync === 2) locks Tune and Semitone
    if ((param === PARAM.TUNE || param === PARAM.SEMITONE) && s?.bpm_sync === 2) return true;
    const value = ccToParamValue(param, ccVal);
    const before = readModel(slot, param);
    if (before === value) {
        if (slot === state.sel) setControl(param, value);
        return true;
    }
    if (before != null) {
        // one knob sweep = one undo step: fold into the top entry while the same
        // CC keeps moving; a pause longer than CC_SWEEP_GAP_MS starts a new step
        const top = undoStack[undoStack.length - 1],
            now = Date.now();
        if (top && top.slot === slot && top.param === param && top.ccSweep && now - top.ccAt < CC_SWEEP_GAP_MS) {
            top.after = value;
            top.ccAt = now;
        } else {
            pushUndo({ slot, param, before, after: value, ccSweep: true, ccAt: now });
        }
    }
    applyLocal(slot, param, value);
    sendParamCoalesced(slot, param, value);
    return true;
}

{
    const strip = $(".strip");
    if (strip?.addEventListener) {
        strip.addEventListener(
            "click",
            (e) => {
                if (!learnMode) return;
                const ctl = closestEl(e.target, ".ctl[data-flash]");
                if (!ctl) return;
                const param = +ctl.dataset.flash;
                if (!SPEC[param]) return;
                e.preventDefault();
                e.stopPropagation();
                learnParam = param;
                syncCcBadges();
                const who = whoTag();
                tick(`MIDI learn: move a slider/knob to pin to ${who}${SPEC[param].label}`);
            },
            true
        );
        strip.addEventListener("contextmenu", (e) => {
            const ctl = closestEl(e.target, ".ctl[data-flash]");
            if (!ctl) return;
            const param = +ctl.dataset.flash;
            if (!SPEC[param]) return;
            // no Web MIDI → nothing to learn from: keep the normal browser menu
            if (!learnMode && !navigator.requestMIDIAccess) return;
            e.preventDefault();
            if (learnMode) {
                const oldCc = unassignParamCC(param, state.sel);
                const who = whoTag();
                tick(
                    oldCc != null
                        ? `MIDI learn: cleared ${fmtCc(oldCc)} from ${who}${SPEC[param].label}`
                        : `${who}${SPEC[param].label} has no CC assigned`
                );
            } else {
                // arming also switches MIDI IN on (a CC can't arrive otherwise)
                import("components/keyboard/keyboard.js").then((k) => k.armMidiLearn(param));
            }
        });
        addEventListener("keydown", (e) => {
            if (learnMode && e.key === "Escape") {
                e.preventDefault();
                setMidiLearn(false);
            }
        });
        syncCcBadges();
    }
}
