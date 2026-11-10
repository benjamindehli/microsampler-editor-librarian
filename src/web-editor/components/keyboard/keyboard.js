// On-screen keyboard + QWERTY pad-play. A piano under the editor mirrors the 36
// pads (C3..B5 = exactly three octaves); clicking a key plays it through the
// device (POST /api/note — real envelope/FX/pitch). Ticking "TYPE TO PLAY"
// arms the computer keyboard as a one-octave piano (home row = white keys, top
// row = black keys; Z / X or the ◀ ▶ buttons shift the octave). The piano always
// shows which computer key maps to which note, lit brighter while armed. Off by
// default so the letter keys stay free for the normal shortcuts (ux.js).
import { handleExternalCC, hasCcBinding, isMidiLearnActive, PITCH_BEND_CC, setMidiLearn, syncCcBadges } from "components/controls/controls.js";
import { followSelect } from "components/sample-editor/waveform.js";
import { noteName, QWERTY_KEYMAP, QWERTY_OCTAVES, qwertySlot } from "functions/notes.js";
import { state } from "functions/state.js";
import { tick } from "functions/ticker.js";
import { $, $$, api, closestEl, jsonBody, lsGet, lsSet, setSegActive } from "functions/util.js";

// the on-screen caption for a mapped computer key (see QWERTY_KEYMAP)
const keyLabel = (code) => (code === "Semicolon" ? ";" : code.slice(3)); // "KeyA" → "A"
const WHITE = [0, 2, 4, 5, 7, 9, 11]; // white-key semitones within an octave
const BLACK_AFTER = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 }; // white-index → black-key semitone

let enabled = false;
let loopHold = false;
let octave = 1; // index into QWERTY_OCTAVES (default C4, the middle)
let mode = "sample"; // 'sample' = one sample per key; 'kbd' = selected sample, pitched
const held = new Map(); // e.code → slot currently sounding (keyboard)
const latched = new Map(); // "s:<slot>" or "k:<note>" → { slot, note, kbd } held by LOOP HOLD
let clickSlot = null; // slot currently held by the mouse on the piano

export const isLoopHold = () => loopHold;
export const isSlotLatched = (slot) => latched.has("s:" + slot);
const isPianoSlotLatched = (slot) => latched.has("s:" + slot) || latched.has("k:" + (48 + slot));

// ── device note + visual paint ───────────────────────────────────────────────
// SAMPLE mode plays note 48+slot on the global channel (triggers that pad);
// KEYBOARD mode sends the same note one channel up, so the device plays its
// currently selected sample pitched (its keyboard-mode track) — the bridge maps
// the `keyboard` flag onto the channel. `body` carries slot OR a raw note (the
// latter for a real MIDI keyboard's full pitch range in keyboard mode).
function send(body) {
    api("/api/note", jsonBody({ velocity: 100, keyboard: mode === "kbd", ...body })).catch((err) => {
        if (body.on) tick(`⚠ note failed: ${err.message}`);
    });
}
function note(slot, on) {
    send({ slot, on });
} // on-screen/qwerty keys play at the send() default velocity
// a resolved note target {slot, note, kbd}: KEYBOARD routing sends the raw note
// (pitched, one channel up), SAMPLE routing triggers the slot's pad
const targetBody = (t) => (t.kbd ? { note: t.note, keyboard: true } : { slot: t.slot, keyboard: false });
const sendOn = (t, velocity) => send({ ...targetBody(t), on: true, velocity });
const sendOff = (t) => send({ ...targetBody(t), on: false });

const pianoKey = (slot) => document.querySelector(`#piano .pkey[data-slot="${slot}"]`);
const padEl = (slot) => document.querySelector(`#pad-grid .pad[data-slot="${slot}"]`);
function paint(slot, sounding) {
    // always light the piano key; in KEYBOARD mode the pad isn't what's triggered
    // (the selected sample plays pitched), so don't light the pad grid there
    pianoKey(slot)?.classList.toggle("sounding", sounding || isPianoSlotLatched(slot));
    if (mode !== "kbd") padEl(slot)?.classList.toggle("sounding", sounding || isSlotLatched(slot));
}
function toggleLatch(target, velocity = 100) {
    const id = target.kbd ? "k:" + target.note : "s:" + target.slot;
    if (latched.has(id)) {
        const entry = latched.get(id);
        latched.delete(id);
        sendOff(entry);
        if (entry.slot != null) {
            // stays lit only if another latch still holds this slot
            pianoKey(entry.slot)?.classList.toggle("sounding", isPianoSlotLatched(entry.slot));
            padEl(entry.slot)?.classList.toggle("sounding", isSlotLatched(entry.slot));
        }
        return false;
    }
    const entry = { slot: target.slot, note: target.note ?? 48 + target.slot, kbd: !!target.kbd };
    latched.set(id, entry);
    sendOn(entry, velocity);
    if (entry.slot != null) {
        pianoKey(entry.slot)?.classList.add("sounding");
        if (!entry.kbd) padEl(entry.slot)?.classList.add("sounding");
    }
    return true;
}
export function togglePadHold(slot, velocity = 100) {
    return toggleLatch({ slot, note: 48 + slot, kbd: false }, velocity);
}
export function releaseLatched(sendOffNotes = true) {
    for (const entry of latched.values()) {
        if (sendOffNotes) sendOff(entry);
        if (entry.slot != null) {
            pianoKey(entry.slot)?.classList.remove("sounding");
            padEl(entry.slot)?.classList.remove("sounding");
        }
    }
    latched.clear();
}
function releaseKeys() {
    for (const slot of held.values()) {
        note(slot, false);
        paint(slot, false);
    }
    held.clear();
}

// ── the on-screen piano ──────────────────────────────────────────────────────
function buildPiano() {
    const piano = $("#piano");
    piano.innerHTML = "";
    const whites = [];
    for (let o = 0; o < 3; o++) for (let w = 0; w < 7; w++) whites.push(o * 12 + WHITE[w]);
    const nW = whites.length; // 21

    whites.forEach((slot, idx) => {
        const k = document.createElement("button");
        k.className = "pkey white";
        k.dataset.slot = String(slot);
        k.tabIndex = -1;
        k.style.left = (idx / nW) * 100 + "%";
        k.style.width = 100 / nW + "%";
        // mark each octave's C with its name; the rest stay clean
        k.innerHTML = `<span class="pk-note">${slot % 12 === 0 ? noteName(slot) : ""}</span>` + '<span class="pk-q"></span>';
        piano.append(k);
    });
    for (let o = 0; o < 3; o++) {
        for (const wStr in BLACK_AFTER) {
            const w = +wStr;
            const slot = o * 12 + BLACK_AFTER[w];
            const k = document.createElement("button");
            k.className = "pkey black";
            k.dataset.slot = String(slot);
            k.tabIndex = -1;
            k.style.left = ((o * 7 + w + 1) / nW) * 100 + "%"; // CSS centres it (translateX -50%)
            k.innerHTML = '<span class="pk-q"></span>';
            piano.append(k);
        }
    }
}

// reflect octave, the per-key QWERTY labels, and used/loaded/selected state
export function syncKeybed() {
    const piano = $("#piano");
    if (!piano.children.length) return;
    $("#kb-oct-val").textContent = QWERTY_OCTAVES[octave];
    $("#keybed").classList.toggle("armed", enabled);
    $("#keybed").classList.toggle("loop-hold", loopHold);
    // SAMPLE mode dims keys with no sample; KEYBOARD mode plays the selected
    // sample across all keys (so the per-key sample state is irrelevant)
    $("#keybed").classList.toggle("mode-sample", mode === "sample");
    $("#keybed").classList.toggle("mode-kbd", mode === "kbd");

    const labelBySlot = {};
    for (const code in QWERTY_KEYMAP) {
        const slot = qwertySlot(code, octave);
        if (slot != null) labelBySlot[slot] = keyLabel(code);
    }
    const slots = state.bank && state.bank.slots;
    for (const el of piano.children) {
        const key = /** @type {HTMLElement} */ (el);
        const slot = +key.dataset.slot;
        key.querySelector(".pk-q").textContent = labelBySlot[slot] || "";
        key.classList.toggle("mapped", slot in labelBySlot);
        const s = slots && slots[slot];
        key.classList.toggle("used", !!(s && !s.empty));
        key.classList.toggle("loaded", state.buffers.has(slot));
        key.classList.toggle("sel", state.sel === slot);
        key.classList.toggle("sounding", isPianoSlotLatched(slot));
    }
}

function setOctave(next) {
    next = Math.max(0, Math.min(QWERTY_OCTAVES.length - 1, next));
    if (next === octave) return;
    octave = next;
    lsSet("msmpl.qwerty.oct", String(octave));
    tick(`octave: ${QWERTY_OCTAVES[octave]}`);
    syncKeybed();
}

function setMode(next) {
    if (next === mode) return;
    releaseLatched();
    releaseAllHeld(); // release held notes on the OLD channel first
    mode = next;
    setSegActive([
        [$("#kb-mode-sample"), mode === "sample"],
        [$("#kb-mode-kbd"), mode === "kbd"]
    ]);
    lsSet("msmpl.qwerty.mode", mode);
    syncKeybed();
    tick(mode === "kbd" ? "keyboard: KEYBOARD mode (selected sample, pitched)" : "keyboard: SAMPLE mode (one sample per key)");
}

function setLoopHold(on) {
    loopHold = on;
    if (!on) releaseLatched();
    syncKeybed();
    lsSet("msmpl.loophold", on ? "1" : "0");
    tick(`loop hold: ${on ? "ON (click or press keys/pads to latch loops)" : "OFF"}`);
}

function setEnabled(on) {
    enabled = on;
    if (!on) releaseKeys();
    syncKeybed();
    lsSet("msmpl.qwerty", on ? "1" : "0");
    tick(`type to play: ${on ? `ON (${QWERTY_OCTAVES[octave]})` : "OFF"}`);
}

// ── computer-keyboard input ───────────────────────────────────────────────────
const onSamples = () => !$("#view-samples").hidden;
function blocked() {
    // typing in a text field / select, or a dialog is open
    if (document.querySelector("dialog[open]")) return true;
    const e = document.activeElement;
    if (!e) return false;
    if (e.tagName === "TEXTAREA" || e.tagName === "SELECT") return true;
    if (e.tagName === "INPUT") return !["checkbox", "radio", "range", "button"].includes(/** @type {HTMLInputElement} */ (e).type);
    return false;
}

// capture phase: consume a handled key BEFORE ux.js's shortcut handler sees it
addEventListener(
    "keydown",
    (e) => {
        if (!enabled || e.metaKey || e.ctrlKey || e.altKey || !onSamples() || blocked()) return;
        if (e.code === "KeyZ" || e.code === "KeyX") {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) setOctave(octave + (e.code === "KeyX" ? 1 : -1));
            return;
        }
        if (QWERTY_KEYMAP[e.code] == null) return; // not a piano key → leave for shortcuts
        e.preventDefault();
        e.stopPropagation(); // a piano key is ours, even if out of range
        if (e.repeat || held.has(e.code)) return;
        const slot = qwertySlot(e.code, octave);
        if (slot == null) return; // mapped but above B5 → consumed, silent
        if (loopHold) {
            toggleLatch({ slot, note: 48 + slot, kbd: mode === "kbd" });
            return;
        }
        held.set(e.code, slot);
        paint(slot, true);
        note(slot, true);
    },
    true
);

addEventListener(
    "keyup",
    (e) => {
        const slot = held.get(e.code);
        if (slot == null) return;
        e.preventDefault();
        held.delete(e.code);
        paint(slot, false);
        note(slot, false);
    },
    true
);

// never leave a note stuck if focus or tab visibility changes mid-hold
function releaseAllHeld() {
    releaseKeys();
    clickRelease();
    releaseMidi();
}
addEventListener("blur", releaseAllHeld);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAllHeld();
});

// ── real MIDI keyboard input (Web MIDI) ───────────────────────────────────────
// Forward a connected MIDI controller's notes to the device, honoring the current
// SAMPLE / KEYBOARD mode. The browser only READS the controller; the bridge still
// solely owns the device's USB, so this never contends for the port.
const MIDI_OK = !!navigator.requestMIDIAccess;
let midiAccess = null;
const midiHeld = new Map(); // controller note physically down → on-screen slot (null = out of range)
const sustainedOff = new Map(); // note whose key is UP but held sounding by the pedal → slot
let sustainOn = false; // CC#64 damper pedal state

// Optional per-channel routing (SMP CH / KBD CH fields, 0-based, null = "—"):
// a controller message on the KBD channel always plays the selected sample
// pitched, one on the SMP channel always triggers pads; any other channel (or
// both fields "—", the default) follows the SAMPLE / KEYBOARD toggle. Lets a
// split/zoned controller play pads and the pitched sample at the same time.
const MIDI_CH_KEYS = { sample: "msmpl.midi.ch.sample", kbd: "msmpl.midi.ch.kbd" };
const loadCh = (key) => {
    const v = lsGet(key);
    return v != null && /^([1-9]|1[0-6])$/.test(v) ? +v - 1 : null;
};
const midiCh = { sample: loadCh(MIDI_CH_KEYS.sample), kbd: loadCh(MIDI_CH_KEYS.kbd) };
function midiKbd(ch) {
    if (midiCh.kbd != null && ch === midiCh.kbd) return true;
    if (midiCh.sample != null && ch === midiCh.sample) return false;
    return mode === "kbd";
}

// resolve a controller note: KEYBOARD routing = raw pitch (full range), SAMPLE
// routing = a pad (note−48, ignoring notes outside C3..B5). null = not playable.
function midiTarget(m, ch = 0) {
    const slot = m - 48,
        inRange = slot >= 0 && slot <= 35,
        kbd = midiKbd(ch);
    if (kbd) return { slot: inRange ? slot : null, note: m, kbd: true };
    return inRange ? { slot, note: m, kbd: false } : null;
}
// send note-offs for every held entry in `map` (controller note → target) and unlight them
function flushOffs(map) {
    for (const entry of map.values()) {
        sendOff(entry);
        if (entry.slot != null) paint(entry.slot, false);
    }
    map.clear();
}

function midiNoteOn(m, vel, ch = 0) {
    const t = midiTarget(m, ch);
    if (!t) return;
    if (loopHold) {
        const nowOn = toggleLatch(t, vel);
        if (nowOn && !t.kbd && state.follow && t.slot != null) followSelect(t.slot);
        return;
    }
    if (sustainedOff.has(m)) {
        sendOff(sustainedOff.get(m));
        sustainedOff.delete(m);
    } // clean re-attack
    if (!t.kbd && state.follow && t.slot != null) followSelect(t.slot);
    sendOn(t, vel);
    if (t.slot != null) paint(t.slot, true);
    midiHeld.set(m, t);
}
function midiNoteOff(m) {
    if (!midiHeld.has(m)) return;
    const entry = midiHeld.get(m);
    midiHeld.delete(m);
    if (sustainOn) {
        // pedal down: keep it sounding (and lit) until the pedal lifts
        sustainedOff.set(m, entry);
    } else {
        sendOff(entry);
        if (entry.slot != null) paint(entry.slot, false);
    }
}
function midiSustain(on) {
    // CC#64 — app-side (the device may not honor the CC itself)
    sustainOn = on;
    if (!on) {
        flushOffs(sustainedOff); // pedal up: release everything it was holding
    }
}
let bentKbd = false; // a non-centre bend is currently applied (keyboard channel)
function midiPitchBend(lsb, msb, ch = 0) {
    if (!midiKbd(ch)) return; // the device pitch-bends only the keyboard-mode voice
    const value = (msb << 7) | lsb; // 14-bit, centre 8192
    bentKbd = value !== 8192;
    sendBend(value);
}
function resetBend() {
    // return the wheel to centre (on release / mode switch / blur)
    if (!bentKbd) return;
    bentKbd = false;
    sendBend(8192);
}
function sendBend(value) {
    api("/api/pitch-bend", jsonBody({ value, keyboard: true })).catch(() => {
        /* best-effort: a dropped bend is corrected by the next wheel move */
    });
}
function releaseMidi() {
    flushOffs(midiHeld);
    flushOffs(sustainedOff);
    sustainOn = false;
    resetBend();
}
function onMidiMessage(e) {
    const [status, d1 = 0, d2 = 0] = e.data;
    const cmd = status & 0xf0;
    const ch = status & 0x0f;
    if (cmd === 0x90 && d2 > 0) midiNoteOn(d1, d2, ch);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) midiNoteOff(d1);
    else if (cmd === 0xe0) {
        // pitch bend wheel: learnable/mappable as pseudo-CC 128 (PITCH_BEND_CC)
        if (isMidiLearnActive() || hasCcBinding(PITCH_BEND_CC)) handleExternalCC(PITCH_BEND_CC, d2);
        else midiPitchBend(d1, d2, ch);
    } else if (cmd === 0xb0 && d1 === 64 && !isMidiLearnActive() && !hasCcBinding(64)) {
        midiSustain(d2 >= 64); // sustain pedal (CC#64)
    } else if (cmd === 0xb0) {
        handleExternalCC(d1, d2); // assignable CC sliders/knobs (0..127)
    } // clock / SysEx / other messages ignored
}
function midiInputNames() {
    return midiAccess ? [...midiAccess.inputs.values()].map((i) => i.name).filter(Boolean) : [];
}
function bindMidiInputs() {
    // (re)attach to every input — also the hotplug handler
    if (!midiAccess) return;
    for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidiMessage;
    const names = midiInputNames();
    $("#midi-toggle").title = names.length
        ? "MIDI input: " + names.join(", ")
        : "No MIDI device detected yet — connect one and it is picked up automatically";
}
async function setMidi(on) {
    if (on) {
        try {
            midiAccess = midiAccess || (await navigator.requestMIDIAccess());
        } catch {
            tick("⚠ MIDI access was blocked");
            $("#midi-in").checked = false;
            return;
        }
        midiAccess.onstatechange = bindMidiInputs;
        bindMidiInputs();
        syncCcBadges();
        const names = midiInputNames();
        tick(names.length ? `MIDI input: ON (${names.join(", ")})` : "MIDI input: ON (waiting for a device)");
    } else {
        if (isMidiLearnActive()) setMidiLearn(false);
        if (midiAccess) {
            // also drop the hotplug handler — left bound, any device state change
            // would re-attach the inputs and silently re-enable MIDI while OFF
            midiAccess.onstatechange = null;
            for (const input of midiAccess.inputs.values()) input.onmidimessage = null;
        }
        releaseMidi();
        tick("MIDI input: OFF");
    }
    $("#keybed").classList.toggle("midi-on", on);
    for (const sel of $$("#midi-ch select")) sel.disabled = !on; // routing only applies while MIDI IN is on
    lsSet("msmpl.midi", on ? "1" : "0");
}

// arm MIDI Learn (optionally targeting a param), switching MIDI IN on first —
// a controller CC can't arrive otherwise. Used by LEARN and right-click on a control.
export async function armMidiLearn(param = null) {
    if (!MIDI_OK) return false;
    const mi = $("#midi-in");
    if (!mi.checked) {
        mi.checked = true;
        await setMidi(true);
        if (!mi.checked) return false; // permission denied
    }
    setMidiLearn(true, param);
    return true;
}

// ── mouse/touch on the on-screen piano (works even when not armed) ────────────
function clickRelease() {
    if (clickSlot == null) return;
    const s = clickSlot;
    clickSlot = null;
    paint(s, false);
    note(s, false);
}
{
    const piano = $("#piano");
    piano.addEventListener("pointerdown", (e) => {
        const key = closestEl(e.target, ".pkey");
        if (!key) return;
        e.preventDefault();
        const slot = +key.dataset.slot;
        if (loopHold) {
            toggleLatch({ slot, note: 48 + slot, kbd: mode === "kbd" });
            return;
        }
        clickSlot = slot;
        paint(clickSlot, true);
        note(clickSlot, true);
    });
    for (const ev of ["pointerup", "pointercancel"]) window.addEventListener(ev, clickRelease);
}

// ── controls (octave buttons + arm toggle), persisted ─────────────────────────
$("#kb-oct-down").onclick = () => setOctave(octave - 1);
$("#kb-oct-up").onclick = () => setOctave(octave + 1);
$("#kb-mode-sample").onclick = () => setMode("sample");
$("#kb-mode-kbd").onclick = () => setMode("kbd");
{
    const raw = lsGet("msmpl.qwerty.oct");
    const n = raw == null ? 1 : +raw;
    octave = Number.isInteger(n) && n >= 0 && n < QWERTY_OCTAVES.length ? n : 1;
    if (lsGet("msmpl.qwerty.mode") === "kbd") mode = "kbd";
    setSegActive([
        [$("#kb-mode-sample"), mode === "sample"],
        [$("#kb-mode-kbd"), mode === "kbd"]
    ]);
    const lh = $("#kb-loop-hold");
    lh.checked = lsGet("msmpl.loophold") === "1";
    loopHold = lh.checked;
    lh.addEventListener("change", () => setLoopHold(lh.checked));
    const t = $("#qwerty-play");
    t.checked = lsGet("msmpl.qwerty") === "1";
    enabled = t.checked;
    t.addEventListener("change", () => setEnabled(t.checked));

    // MIDI input: only offer it where Web MIDI exists (Chrome/Edge/Firefox; not Safari)
    if (MIDI_OK) {
        $("#midi-toggle").hidden = false;
        $("#midi-ch").hidden = false;
        const mi = $("#midi-in");
        mi.addEventListener("change", () => setMidi(mi.checked));
        // SMP CH / KBD CH routing fields ("—" = follow the toggle)
        for (const [which, other] of [
            ["sample", "kbd"],
            ["kbd", "sample"]
        ]) {
            const sel = $(`#midi-ch-${which}`);
            sel.innerHTML =
                '<option value="">—</option>' + Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
            sel.value = midiCh[which] == null ? "" : String(midiCh[which] + 1);
            sel.disabled = true;
            sel.addEventListener("change", () => {
                releaseMidi(); // held notes were routed under the old mapping
                midiCh[which] = sel.value ? +sel.value - 1 : null;
                lsSet(MIDI_CH_KEYS[which], sel.value);
                // one channel can't route both ways: clear the other field on a clash
                if (midiCh[which] != null && midiCh[other] === midiCh[which]) {
                    midiCh[other] = null;
                    lsSet(MIDI_CH_KEYS[other], "");
                    $(`#midi-ch-${other}`).value = "";
                }
                const desc = (c) => (c == null ? "—" : `ch ${c + 1}`);
                tick(`MIDI IN routing: SAMPLE ${desc(midiCh.sample)} · KEYBOARD ${desc(midiCh.kbd)} (— = follow the toggle)`);
            });
        }
        const ml = $("#midi-learn");
        ml.hidden = false;
        ml.onclick = () => (isMidiLearnActive() ? setMidiLearn(false) : armMidiLearn());
        // re-enable only if it was on before — avoids a surprise permission prompt on every load
        if (lsGet("msmpl.midi") === "1") {
            mi.checked = true;
            setMidi(true);
        }
    }
}

buildPiano();
syncKeybed();
