// Pattern editor: an in-app piano-roll for the device's two pattern tracks —
// sample-mode (note number triggers a pad) and keyboard-mode (one assigned
// sample played chromatically). Edits a copy of the read-model note list, then
// saves by writing an SMF (smfWrite) to the existing, hardware-proven
// POST /api/pattern/N → smf_to_pattern → pattern_write path. No SEQP is built in
// the browser. Supports multi-select, copy/paste (clipboard persists across
// sessions, so it doubles as duplicate-to-another-slot) and undo/redo.
import { isBlackKey, noteName } from "functions/notes.js";
import { notesToSmf } from "functions/smfWrite.js";
import { state } from "functions/state.js";
import { tick } from "functions/ticker.js";
import { $, $$, api, apiJson, clampBpm, closestEl, esc, jsonBody, setSegActive, sweepPlayhead } from "functions/util.js";

const TPB = 384; // ticks per 4/4 bar (96/quarter)
const LO = 36,
    HI = 96; // visible MIDI-note range (rows, high note on top)
const ROWS = HI - LO + 1;
const ROWH = 18; // px per note row
const PAD_LO = 48,
    PAD_HI = 83; // sample-mode notes map to pads 0..35 (note−48)

let cur = null; // { pattern, notes:[{start,dur,note,vel,track}], bars, sample, name, track, sel:Set, primary, origSmf, deviceDirty }
let drag = null; // { mode:'move'|'resize', idx, grabTick, origNote, orig:Map }
let pePlaying = false; // previewing on the device (transport running)
let clipboard = []; // copied notes (relative to earliest start); persists across opens
let history = [],
    hpos = -1; // undo/redo: a stack of full-state snapshots

const total = () => cur.bars * TPB;
// focus the note element with this index, if it is still in the roll
const focusNote = (i) => /** @type {HTMLElement} */ ($("#pe-roll").querySelector(`.pe-note[data-i="${i}"]`))?.focus();
const snap = () => +$("#pe-grid").value; // grid step in ticks; 0 = OFF (free placement)
const step = () => snap() || 1; // snapping granularity (1 tick ⇒ effectively free)
const midiLabel = (n) => noteName(n - 48); // MIDI note → 'C4' etc.
const rowTop = (n) => (HI - n) * ROWH;
const noteAtY = (y) => Math.max(LO, Math.min(HI, HI - Math.floor(y / ROWH)));
const trackRange = (t) => (t === 0 ? [PAD_LO, PAD_HI] : [LO, HI]);
const clampNote = (n, t) => {
    const [a, b] = trackRange(t);
    return Math.max(a, Math.min(b, n));
};
const selArr = () => [...cur.sel].filter((i) => cur.notes[i]).sort((a, b) => a - b);

function tickAtX(roll, clientX) {
    const r = roll.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const s = step();
    return Math.max(0, Math.min(total() - s, Math.round((frac * total()) / s) * s));
}

// ── render ───────────────────────────────────────────────────────────────────
function buildGutter() {
    const g = $("#pe-gutter");
    g.style.height = ROWS * ROWH + "px";
    g.innerHTML = "";
    for (let n = HI; n >= LO; n--) {
        const d = document.createElement("div");
        d.className = "pe-key" + (isBlackKey(n) ? " black" : "") + (n >= PAD_LO && n <= PAD_HI ? " pe-pad" : ""); // not ".pad" — collides with the pad-grid rule
        d.style.top = rowTop(n) + "px"; // absolute, same formula as the roll
        d.style.height = ROWH + "px";
        d.textContent = midiLabel(n);
        g.append(d);
    }
}

// screen-reader label for a note
const noteLabel = (nt) => `${nt.track ? "Keyboard" : "Sample"} ${midiLabel(nt.note)}, bar ${Math.floor(nt.start / TPB) + 1}, velocity ${nt.vel}`;

const noteFill = (nt) => `rgba(${nt.track ? "255,233,201" : "var(--amber-rgb)"},${(0.4 + (nt.vel / 127) * 0.6).toFixed(3)})`;

// bar lines + black-key row shading depend ONLY on cur.bars — rebuild this
// static layer just when bars changes (or if it's missing), not on every
// renderRoll. Sits at the front so notes + playhead paint over it.
let bgBars = -1;
function buildBackground(roll) {
    for (const el of roll.querySelectorAll(".pe-bar, .pe-rowbg")) el.remove();
    // numeric-only markup, safe as an HTML string
    let html = "";
    for (let b = 0; b <= cur.bars; b++) html += `<div class="pe-bar" style="left:${(b / cur.bars) * 100}%"></div>`;
    for (let n = LO; n <= HI; n++) if (isBlackKey(n)) html += `<div class="pe-rowbg" style="top:${rowTop(n)}px;height:${ROWH}px"></div>`;
    roll.insertAdjacentHTML("afterbegin", html);
    bgBars = cur.bars;
}

// full note-layer rebuild (note SET changed: add/remove/reorder/geometry). For
// selection- or velocity-only changes use paintNotes() — a cheap in-place patch.
function renderRoll() {
    const roll = $("#pe-roll");
    // the rebuild below replaces every note element, which would drop keyboard
    // focus — remember which note was focused and restore it afterwards
    const af = /** @type {HTMLElement} */ (document.activeElement);
    const refocus = af && af.classList && af.classList.contains("pe-note") ? af.dataset.i : null;
    const ph = roll.querySelector("#pe-playhead"); // preserve the moving playhead across the rebuild
    roll.style.height = ROWS * ROWH + "px";
    if (bgBars !== cur.bars || !roll.querySelector(".pe-bar")) buildBackground(roll);
    for (const el of roll.querySelectorAll(".pe-note")) el.remove(); // keep bars/rowbg/playhead
    const tot = total();
    // notes carry text (aria-label/title) — build them with DOM APIs so the text
    // is set as data, never parsed as HTML (avoids any text-to-HTML injection path)
    cur.notes.forEach((nt, i) => {
        if (nt.start >= tot) return;
        const w = (nt.dur / tot) * 100; // actual length — independent of the grid setting
        const d = document.createElement("div");
        d.className = `pe-note ${nt.track ? "kbd" : "smp"}${cur.sel.has(i) ? " sel" : ""}`;
        d.dataset.i = i;
        d.tabIndex = 0;
        d.setAttribute("role", "button");
        d.setAttribute("aria-label", noteLabel(nt));
        d.title = `${midiLabel(nt.note)} · vel ${nt.vel}`;
        d.style.cssText = `left:${(nt.start / tot) * 100}%;width:${w}%;top:${rowTop(nt.note) + 1}px;height:${ROWH - 2}px;background:${noteFill(nt)}`;
        const grip = document.createElement("span");
        grip.className = "pe-resize";
        d.append(grip);
        roll.append(d);
    });
    if (ph) roll.append(ph); // re-attach the preview playhead (keep it on top)
    if (refocus != null) focusNote(refocus);
}

// Patch existing note elements' selection outline + velocity fill in place —
// used when the note SET (count + indices) is unchanged, so rebuilding every
// div (bars, ~25 row shades, up to 199 notes) is unnecessary. The velocity
// slider dragged over a big selection hit renderRoll per input event; a click
// rebuilt the whole roll just to move one .sel outline.
function paintNotes() {
    for (const el of $$(".pe-note", $("#pe-roll"))) {
        const i = +el.dataset.i;
        const nt = cur.notes[i];
        if (!nt) continue;
        el.classList.toggle("sel", cur.sel.has(i));
        el.style.background = noteFill(nt);
        el.setAttribute("aria-label", noteLabel(nt)); // velocity is in the label
        el.title = `${midiLabel(nt.note)} · vel ${nt.vel}`;
    }
}

function setVelUI() {
    const nt = cur.primary != null && cur.notes[cur.primary] ? cur.notes[cur.primary] : null;
    const v = nt ? nt.vel : +$("#pe-vel").value;
    $("#pe-vel").value = v;
    $("#pe-vel-val").textContent = v;
}

// ── undo / redo (full-state snapshots; dedups no-ops like a click without a move) ──
const stateStr = () => JSON.stringify({ notes: cur.notes, bars: cur.bars, sample: cur.sample, name: cur.name });
function pushHistory() {
    const s = stateStr();
    if (s === history[hpos]) return;
    history = history.slice(0, hpos + 1);
    history.push(s);
    if (history.length > 120) history.shift();
    hpos = history.length - 1;
}
function restoreState(s) {
    const o = JSON.parse(s);
    cur.notes = o.notes;
    cur.bars = o.bars;
    cur.sample = o.sample;
    cur.name = o.name;
    cur.sel = new Set();
    cur.primary = null;
    $("#pe-bars").value = cur.bars;
    $("#pe-name").value = cur.name;
    $("#pe-sample").value = cur.sample == null ? "" : String(cur.sample);
    renderRoll();
    setVelUI();
}
function undo() {
    if (hpos > 0) {
        hpos--;
        restoreState(history[hpos]);
        tick("undo");
    }
}
function redo() {
    if (hpos < history.length - 1) {
        hpos++;
        restoreState(history[hpos]);
        tick("redo");
    }
}

// ── selection / clipboard ──────────────────────────────────────────────────────
function selectAll() {
    cur.sel = new Set(cur.notes.map((_, i) => i));
    cur.primary = cur.notes.length ? cur.notes.length - 1 : null;
    setVelUI();
    paintNotes(); // selection-only — note set unchanged
}
function copySel() {
    const idxs = selArr();
    if (!idxs.length) return;
    const base = Math.min(...idxs.map((i) => cur.notes[i].start));
    clipboard = idxs.map((i) => {
        const n = cur.notes[i];
        return { start: n.start - base, dur: n.dur, note: n.note, vel: n.vel, track: n.track };
    });
    tick(`copied ${clipboard.length} note${clipboard.length !== 1 ? "s" : ""}`);
}
function paste() {
    if (!clipboard.length) return;
    const tot = total();
    const first = cur.notes.length; // pastes keep their relative timing, from tick 0
    for (const c of clipboard) {
        if (c.start >= tot) continue;
        cur.notes.push({ start: c.start, dur: Math.min(c.dur, tot - c.start), note: clampNote(c.note, c.track), vel: c.vel, track: c.track });
    }
    cur.sel = new Set(cur.notes.map((_, i) => i).filter((i) => i >= first));
    cur.primary = cur.notes.length - 1;
    setVelUI();
    renderRoll();
    pushHistory();
    tick(`pasted ${cur.sel.size} note${cur.sel.size !== 1 ? "s" : ""}`);
}

// ── interactions ──────────────────────────────────────────────────────────────
function eraseNote(i) {
    if (cur.notes[i] == null) return;
    cur.notes.splice(i, 1);
    cur.sel = new Set();
    cur.primary = null;
    renderRoll();
}

function onPointerDown(e) {
    const roll = $("#pe-roll");
    const noteEl = e.target.closest(".pe-note");

    if (cur.tool === "eraser") {
        // click/drag over notes to remove
        drag = { mode: "erase", erased: false };
        roll.setPointerCapture(e.pointerId);
        if (noteEl) {
            drag.erased = true;
            eraseNote(+noteEl.dataset.i);
        }
        e.preventDefault();
        return;
    }

    if (noteEl) {
        // select + move/resize (pencil & select)
        const i = +noteEl.dataset.i;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            if (cur.sel.has(i)) cur.sel.delete(i);
            else cur.sel.add(i);
        } else if (!cur.sel.has(i)) {
            cur.sel = new Set([i]);
        }
        cur.primary = i;
        if (e.target.classList.contains("pe-resize")) {
            drag = { mode: "resize", idx: i };
        } else {
            drag = {
                mode: "move",
                idx: i,
                grabTick: tickAtX(roll, e.clientX),
                origNote: cur.notes[i].note,
                orig: new Map(selArr().map((j) => [j, { start: cur.notes[j].start, note: cur.notes[j].note }]))
            };
        }
        roll.setPointerCapture(e.pointerId);
        setVelUI();
        paintNotes(); // selection change only — the note set is unchanged
        focusNote(cur.primary); // so arrow keys work after a click
        return;
    }

    // empty grid
    if (cur.tool === "select") {
        // rubber-band marquee
        const r = roll.getBoundingClientRect();
        const m = document.createElement("div");
        m.className = "pe-marquee";
        roll.append(m);
        drag = { mode: "marquee", x0: e.clientX - r.left, y0: e.clientY - r.top, add: e.shiftKey, el: m };
        roll.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
    }
    // pencil → add a note and drag it
    const r = roll.getBoundingClientRect();
    cur.notes.push({
        start: tickAtX(roll, e.clientX),
        dur: snap() || 24,
        note: clampNote(noteAtY(e.clientY - r.top), cur.track),
        vel: +$("#pe-vel").value,
        track: cur.track
    });
    const i = cur.notes.length - 1;
    cur.sel = new Set([i]);
    cur.primary = i;
    drag = {
        mode: "move",
        idx: i,
        grabTick: cur.notes[i].start,
        origNote: cur.notes[i].note,
        orig: new Map([[i, { start: cur.notes[i].start, note: cur.notes[i].note }]])
    };
    roll.setPointerCapture(e.pointerId);
    setVelUI();
    renderRoll();
    focusNote(i);
}

function onPointerMove(e) {
    if (!drag) return;
    const roll = $("#pe-roll");
    if (drag.mode === "erase") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const ne = el && closestEl(el, ".pe-note");
        if (ne) {
            drag.erased = true;
            eraseNote(+ne.dataset.i);
        }
        return;
    }
    if (drag.mode === "marquee") {
        const r = roll.getBoundingClientRect();
        const x = e.clientX - r.left,
            y = e.clientY - r.top;
        Object.assign(drag.el.style, {
            left: Math.min(drag.x0, x) + "px",
            top: Math.min(drag.y0, y) + "px",
            width: Math.abs(x - drag.x0) + "px",
            height: Math.abs(y - drag.y0) + "px"
        });
        return;
    }
    const t = tickAtX(roll, e.clientX);
    const s = step();
    if (drag.mode === "resize") {
        const nt = cur.notes[drag.idx];
        nt.dur = Math.max(s, Math.round((t - nt.start) / s) * s);
        syncNoteEls([drag.idx]); // geometry-only — full renderRoll on release
        return;
    } else {
        const r = roll.getBoundingClientRect();
        let dStart = t - drag.grabTick;
        let dNote = clampNote(noteAtY(e.clientY - r.top), cur.notes[drag.idx].track) - drag.origNote;
        const tot = total();
        let loS = -1e9,
            hiS = 1e9,
            loN = -1e9,
            hiN = 1e9;
        for (const [j, o] of drag.orig) {
            loS = Math.max(loS, -o.start);
            hiS = Math.min(hiS, tot - s - o.start);
            const [a, b] = trackRange(cur.notes[j].track);
            loN = Math.max(loN, a - o.note);
            hiN = Math.min(hiN, b - o.note);
        }
        dStart = Math.max(loS, Math.min(hiS, dStart));
        dNote = Math.max(loN, Math.min(hiN, dNote));
        for (const [j, o] of drag.orig) {
            cur.notes[j].start = o.start + dStart;
            cur.notes[j].note = o.note + dNote;
        }
        syncNoteEls([...drag.orig.keys()]); // geometry-only — full renderRoll on release
    }
}

// During a move/resize drag only the DRAGGED notes' geometry changes — patch
// their inline styles in place. renderRoll() (bars + ~25 row shades + up to
// 199 note divs rebuilt) ran on EVERY pointermove; the full rebuild now waits
// for pointerup.
function syncNoteEls(idxs) {
    const roll = $("#pe-roll"),
        tot = total();
    for (const i of idxs) {
        const nt = cur.notes[i];
        const el = /** @type {HTMLElement} */ (roll.querySelector(`.pe-note[data-i="${i}"]`));
        if (!el || !nt) continue;
        el.style.left = (nt.start / tot) * 100 + "%";
        el.style.width = (nt.dur / tot) * 100 + "%";
        el.style.top = rowTop(nt.note) + 1 + "px";
        el.setAttribute("aria-label", noteLabel(nt)); // keep AT + tooltip current
        el.title = `${midiLabel(nt.note)} · vel ${nt.vel}`;
    }
}

// select all notes intersecting the dragged box (content-px → tick/row ranges)
function finishMarquee() {
    const roll = $("#pe-roll"),
        W = roll.clientWidth,
        tot = total(),
        st = drag.el.style;
    const L = parseFloat(st.left) || 0,
        T = parseFloat(st.top) || 0;
    const w = parseFloat(st.width) || 0,
        h = parseFloat(st.height) || 0;
    drag.el.remove();
    if (w < 3 && h < 3) {
        // a click, not a drag → clear (unless shift)
        if (!drag.add) {
            cur.sel = new Set();
            cur.primary = null;
            setVelUI();
            paintNotes(); // selection-only
        }
        return;
    }
    const tickLo = (L / W) * tot,
        tickHi = ((L + w) / W) * tot;
    const noteHi = HI - Math.floor(T / ROWH),
        noteLo = HI - Math.floor((T + h) / ROWH);
    const sel = drag.add ? new Set(cur.sel) : new Set();
    cur.notes.forEach((n, i) => {
        if (n.start < tickHi && n.start + n.dur > tickLo && n.note >= noteLo && n.note <= noteHi) sel.add(i);
    });
    cur.sel = sel;
    cur.primary = sel.size ? Math.max(...sel) : null;
    setVelUI();
    paintNotes(); // selection-only — marquee doesn't change the note set
}

function onPointerUp() {
    if (!drag) return;
    if (drag.mode === "marquee") finishMarquee();
    else if (drag.mode === "erase") {
        if (drag.erased) pushHistory();
    } else {
        renderRoll();
        pushHistory();
    } // move / resize / pencil-add:
    drag = null; // the deferred full rebuild
}

function onWheel(e) {
    // scroll over a note → velocity
    const noteEl = e.target.closest(".pe-note");
    if (!noteEl) return;
    e.preventDefault();
    const i = +noteEl.dataset.i;
    cur.notes[i].vel = Math.max(1, Math.min(127, cur.notes[i].vel + (e.deltaY < 0 ? 4 : -4)));
    if (!cur.sel.has(i)) cur.sel = new Set([i]);
    cur.primary = i;
    setVelUI();
    paintNotes(); // velocity + selection change — note set unchanged
    pushHistory();
}

// a note receiving focus (Tab or click) becomes the primary + selection
function onFocusIn(e) {
    const el = e.target.closest && e.target.closest(".pe-note");
    if (!el) return;
    const idx = +el.dataset.i;
    cur.primary = idx;
    if (!cur.sel.has(idx)) {
        cur.sel = new Set([idx]);
        paintNotes(); // selection-only
    }
    setVelUI();
}

const inField = (el) =>
    el &&
    ((el.tagName === "INPUT" && ["text", "number", "search", "range"].includes(el.type)) || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
// a real text-entry field — where Space must type a space (so it can't be a shortcut)
const isText = (el) =>
    el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "search", "email", "url", "tel", "password"].includes(el.type)));

function onKey(e) {
    if (!$("#pattern-editor").open) return; // editor closed → ignore (document-level listener)
    const ae = /** @type {HTMLElement} */ (document.activeElement);
    // Spacebar = play/stop anywhere in the editor (even on a button/select/slider),
    // except an actual text field so the NAME can still take a space
    if (e.key === " " && !isText(ae)) {
        e.preventDefault();
        preview();
        return;
    }
    if (inField(ae)) return; // other keys: keep native in inputs/selects/range
    // edit shortcuts (work anywhere in the editor that isn't a text field)
    if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "z") {
            e.preventDefault();
            e.shiftKey ? redo() : undo();
            return;
        }
        if (k === "y") {
            e.preventDefault();
            redo();
            return;
        }
        if (k === "a") {
            e.preventDefault();
            selectAll();
            return;
        }
        if (k === "c") {
            e.preventDefault();
            copySel();
            return;
        }
        if (k === "v") {
            e.preventDefault();
            paste();
            return;
        }
    }
    // Delete removes the whole selection (plus a focused note, if any)
    if (e.key === "Delete" || e.key === "Backspace") {
        const kill = new Set(cur.sel);
        if (ae && ae.classList && ae.classList.contains("pe-note")) kill.add(+ae.dataset.i);
        if (!kill.size) return;
        e.preventDefault();
        cur.notes = cur.notes.filter((_, i) => !kill.has(i));
        cur.sel = new Set();
        cur.primary = null;
        renderRoll();
        setVelUI();
        pushHistory();
        /** @type {HTMLElement} */ ($("#pe-roll").querySelector(".pe-note") || $("#pe-roll")).focus();
        return;
    }
    // arrows nudge the FOCUSED note (single)
    if (!ae || !ae.classList || !ae.classList.contains("pe-note")) return;
    const idx = +ae.dataset.i;
    const nt = cur.notes[idx];
    if (!nt) return;
    const s = step();
    if (e.key === "ArrowLeft") nt[e.shiftKey ? "dur" : "start"] = e.shiftKey ? Math.max(s, nt.dur - s) : Math.max(0, nt.start - s);
    else if (e.key === "ArrowRight")
        nt[e.shiftKey ? "dur" : "start"] = e.shiftKey ? Math.min(total() - nt.start, nt.dur + s) : Math.min(total() - s, nt.start + s);
    else if (e.key === "ArrowUp") nt.note = clampNote(nt.note + 1, nt.track);
    else if (e.key === "ArrowDown") nt.note = clampNote(nt.note - 1, nt.track);
    else return;
    e.preventDefault();
    setVelUI();
    renderRoll();
    pushHistory(); // renderRoll restores focus to this note
}

function setTool(t) {
    cur.tool = t;
    setSegActive(["pencil", "eraser", "select"].map((x) => [$("#pe-tool-" + x), x === t]));
    const roll = $("#pe-roll");
    roll.classList.toggle("erasing", t === "eraser");
    roll.classList.toggle("selecting", t === "select");
}

// ── open / save ────────────────────────────────────────────────────────────────
function fillSampleSelect() {
    const sel = $("#pe-sample");
    const opts = ['<option value="">— none —</option>'];
    const slots = (state.bank && state.bank.slots) || [];
    for (let i = 0; i < 36; i++) {
        const s = slots[i];
        const label = s && !s.empty ? esc(s.name) : "· · · ·"; // device name → innerHTML: escape (cf. the S&H bug)
        opts.push(`<option value="${i}">${String(i + 1).padStart(2, "0")} · ${midiLabel(48 + i)} · ${label}</option>`);
    }
    sel.innerHTML = opts.join("");
}

export function openPatternEditor(p) {
    cur = {
        pattern: p.pattern,
        notes: (p.notes || []).map(([start, track, note, vel, dur]) => ({ start, track: track ? 1 : 0, note, vel, dur: Math.max(1, dur) })),
        bars: Math.max(1, Math.min(99, p.bars || 1)),
        sample: p.sample == null ? null : p.sample,
        name: p.name || "PATTERN",
        track: 0,
        tool: "pencil",
        sel: new Set(),
        primary: null,
        origSmf: null, // filled in below, once the initial state can be built
        deviceDirty: false // true only once a PREVIEW writes the device
    };
    $("#pe-title").textContent = `EDIT P${String(p.pattern + 1).padStart(2, "0")}`;
    $("#pe-name").value = cur.name;
    $("#pe-bars").value = String(cur.bars);
    fillSampleSelect();
    $("#pe-sample").value = cur.sample == null ? "" : String(cur.sample);
    setTrack(0);
    setTool("pencil");
    buildGutter();
    renderRoll();
    setVelUI();
    cur.origSmf = buildSmf(); // pristine slot, for restore-on-cancel
    history = [stateStr()];
    hpos = 0;
    pePlaying = false;
    setPlayBtn();
    $("#pattern-editor").showModal();
    // start scrolled to the pad range (around C4)
    $("#pe-roll-wrap").scrollTop = rowTop(PAD_HI) - 40;
    $("#pe-roll").focus(); // start in the roll so the edit shortcuts work (not a text field)
}

function setTrack(t) {
    cur.track = t;
    setSegActive([
        [$("#pe-track-smp"), t === 0],
        [$("#pe-track-kbd"), t === 1]
    ]);
}

const pNum = () => `P${String(cur.pattern + 1).padStart(2, "0")}`;

// serialise the current edit to an SMF (the proven save format)
function buildSmf() {
    const tot = total();
    const notes = cur.notes.filter((n) => n.start < tot).map((n) => ({ ...n, dur: Math.min(n.dur, tot - n.start) }));
    return notesToSmf(notes, { bars: cur.bars, sample: cur.sample, name: cur.name });
}
// returns the updated pattern JSON (bridge pattern_write → _pattern_json), which
// the PATTERNS view uses to refresh just this card — no full 16-pattern re-receive
const writePattern = (smf) => apiJson(`/api/pattern/${cur.pattern}`, { method: "POST", body: smf });
const announce = (p) => dispatchEvent(new CustomEvent("msmpl-pattern-changed", { detail: p }));

function setPlayBtn() {
    $("#pe-play").classList.toggle("playing", pePlaying);
    $("#pe-play-cap").textContent = pePlaying ? "■ STOP" : "▶ PLAY";
}

// APPROXIMATE preview playhead (the app can't read the device's true position):
// a rAF line sweeps the roll over the pattern's duration (bars × 4 beats at the
// bank BPM) and loops, the way the device loops the pattern.
let peStop = null;
function stopPlayhead() {
    if (peStop) peStop();
    peStop = null;
    const ph = /** @type {HTMLElement} */ ($("#pe-roll").querySelector("#pe-playhead"));
    if (ph) ph.hidden = true;
}
function startPlayhead(bpm) {
    stopPlayhead();
    const roll = $("#pe-roll");
    let ph = /** @type {HTMLElement} */ (roll.querySelector("#pe-playhead"));
    if (!ph) {
        ph = document.createElement("div");
        ph.id = "pe-playhead";
        ph.className = "pe-playhead";
        roll.append(ph);
    }
    ph.hidden = false;
    const durMs = cur.bars * 4 * (60000 / clampBpm(bpm)); // 4/4 at the bank BPM
    peStop = sweepPlayhead(ph, durMs, roll.clientWidth, () => pePlaying);
}

async function stopPreview() {
    if (!pePlaying) return;
    pePlaying = false;
    setPlayBtn();
    stopPlayhead();
    try {
        await api("/api/transport/stop", { method: "POST" });
    } catch {
        /* ignore */
    }
}

// PLAY: the device can only play patterns it holds, so previewing writes the edit
// to its (RAM) slot first, then plays it. CANCEL restores the slot — so this stays
// non-destructive until you SAVE.
async function preview() {
    if (pePlaying) {
        stopPreview();
        return;
    }
    try {
        await writePattern(buildSmf());
        cur.deviceDirty = true; // the device slot now holds the edit
        const bpm = (state.bank && state.bank.bpm) || 120;
        await api(`/api/pattern/${cur.pattern}/play`, jsonBody({ bpm }));
        pePlaying = true;
        setPlayBtn();
        startPlayhead(bpm);
        tick(`▶ preview ${pNum()}`);
    } catch (err) {
        pePlaying = false;
        setPlayBtn();
        stopPlayhead();
        tick(`⚠ preview: ${err.message}`);
    }
}

async function closeEditor() {
    await stopPreview();
    $("#pattern-editor").close();
}

async function save() {
    const btn = $("#pe-save");
    btn.disabled = true;
    try {
        announce(await writePattern(buildSmf())); // refresh just this card
        cur.deviceDirty = false;
        tick(`✓ pattern ${pNum()} saved`);
        await closeEditor();
    } catch (err) {
        tick(`⚠ pattern save failed: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
}

// discard edits; if a preview wrote to the device, restore the slot to how it
// was (edits WITHOUT a preview never touched the device — nothing to restore,
// and a needless write here would stop the sequencer for no reason)
async function cancel() {
    if (cur.deviceDirty) {
        try {
            announce(await writePattern(cur.origSmf));
        } catch {
            /* ignore */
        }
    }
    await closeEditor();
}

// ── wiring ──────────────────────────────────────────────────────────────────
{
    const roll = $("#pe-roll");
    roll.addEventListener("pointerdown", onPointerDown);
    roll.addEventListener("pointermove", onPointerMove);
    for (const ev of ["pointerup", "pointercancel"]) roll.addEventListener(ev, onPointerUp);
    roll.addEventListener("wheel", onWheel, { passive: false });
    roll.addEventListener("focusin", onFocusIn);
    // document-level so the edit shortcuts work wherever focus is inside the open
    // editor (a click can land focus outside the note that was clicked)
    document.addEventListener("keydown", onKey);
    $("#pe-tool-pencil").onclick = () => setTool("pencil");
    $("#pe-tool-eraser").onclick = () => setTool("eraser");
    $("#pe-tool-select").onclick = () => setTool("select");
    $("#pe-track-smp").onclick = () => setTrack(0);
    $("#pe-track-kbd").onclick = () => setTrack(1);
    $("#pe-grid").onchange = renderRoll;
    $("#pe-bars").onchange = () => {
        cur.bars = Math.max(1, Math.min(99, +$("#pe-bars").value || 1));
        $("#pe-bars").value = cur.bars;
        renderRoll();
        pushHistory();
    };
    $("#pe-name").oninput = () => {
        cur.name = $("#pe-name").value.slice(0, 8);
    };
    $("#pe-name").onchange = () => pushHistory();
    $("#pe-sample").onchange = () => {
        cur.sample = $("#pe-sample").value === "" ? null : +$("#pe-sample").value;
        pushHistory();
    };
    $("#pe-vel").oninput = () => {
        const v = +$("#pe-vel").value;
        $("#pe-vel-val").textContent = String(v);
        const idxs = selArr();
        if (idxs.length) {
            for (const i of idxs) cur.notes[i].vel = v;
            paintNotes(); // velocity-only — note set unchanged, no full rebuild per tick
        }
    };
    $("#pe-vel").onchange = () => {
        if (selArr().length) pushHistory();
    };
    $("#pe-play").onclick = () => {
        preview();
    };
    $("#pe-save").onclick = () => {
        save();
    };
    // Esc → discard (stop preview + restore the slot if a preview wrote to it)
    $("#pattern-editor").addEventListener("cancel", (e) => {
        e.preventDefault();
        cancel();
    });
    // click outside the dialog (on the backdrop) → save and close
    $("#pattern-editor").addEventListener("click", (e) => {
        if (e.target !== $("#pattern-editor")) return; // a backdrop click targets the dialog itself
        const r = $("#pattern-editor").getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) save();
    });
}
