// @ts-check
// 36-slot pad grid: rendering, selection, device note-play, WAV drop.
import { openUpload, uploadBatch } from "components/dialogs/dialogs.js";
import { syncKeybed } from "components/keyboard/keyboard.js";
import { showSlot } from "components/sample-editor/slot.js";
import { openSlotOp } from "components/sample-editor/slotops.js";
import { isBlackKey, noteName } from "functions/notes.js";
import { state } from "functions/state.js";
import { tick } from "functions/ticker.js";
import { $, api, closestEl, esc, jsonBody, lsGet, lsSet } from "functions/util.js";

export function selectSlot(i) {
    state.sel = i;
    syncPads();
    showSlot(i)
        .then(syncPads)
        .catch(() => {}); // light the loaded dot
}

// In-place refresh of sel/loaded/name on the EXISTING buttons — the hot paths
// (every pad click ×2, once per preloaded sample) don't need renderPads()'s
// full 36-button rebuild, which repaints the whole grid and destroys the
// focused pad (keyboard focus silently dropped to <body>). Falls back to the
// rebuild when the grid doesn't match the bank (first render, or a slot
// flipped empty↔used — those change a pad's children/draggable).
export function syncPads() {
    const kids = $("#pad-grid").children;
    const slots = state.bank.slots;
    if (kids.length !== slots.length) return renderPads();
    let used = 0;
    for (const s of slots) {
        const b = kids[s.slot];
        if (b.classList.contains("empty") === !s.empty) return renderPads();
        if (!s.empty) used++;
        b.classList.toggle("sel", state.sel === s.slot);
        b.classList.toggle("loaded", !s.empty && state.buffers.has(s.slot));
        const nameEl = b.querySelector(".pad-name");
        const name = s.empty ? "· · · ·" : s.name;
        if (nameEl.textContent !== name) nameEl.textContent = name;
    }
    $("#count-used").textContent = String(used);
    applyPadFilter(); // re-apply any active filter
    syncKeybed(); // mirror used/loaded/selected onto the piano
}

export function renderPads() {
    const grid = $("#pad-grid");
    grid.innerHTML = "";
    let used = 0;
    state.bank.slots.forEach((s) => {
        if (!s.empty) used++;
        const b = document.createElement("button");
        b.dataset.slot = s.slot;
        // "loaded" = decoded audio cached → instant audition/waveform, exact meter
        const loaded = !s.empty && state.buffers.has(s.slot);
        // sharps (C#/D#/F#/G#/A#) are a keyboard's black keys — tint them darker
        const black = isBlackKey(48 + s.slot);
        b.className =
            "pad " + (s.empty ? "empty" : "used") + (black ? " black" : "") + (state.sel === s.slot ? " sel" : "") + (loaded ? " loaded" : "");
        b.innerHTML =
            `<span class="pad-num">${String(s.slot + 1).padStart(2, "0")} · ${noteName(s.slot)}</span>
                   <span class="pad-name">${s.empty ? "· · · ·" : esc(s.name)}</span>
                   <span class="pad-led"></span>` +
            (s.empty ? "" : '<span class="pad-play" aria-hidden="true" title="Play on the device (hold)">▶</span>');
        b.onclick = () => selectSlot(s.slot); // keyboard (Enter/Space) activation
        // Also select on pointerdown: a used pad is draggable (copy/swap), so a
        // press with the slightest movement becomes a native drag that suppresses
        // the click, leaving the pad unselected. Selecting on pointerdown makes it
        // reliable; the ▶ corner still plays without selecting.
        b.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || closestEl(e.target, ".pad-play")) return;
            selectSlot(s.slot);
        });
        if (!s.empty) {
            // used pads drag → copy/swap
            b.draggable = true;
            b.addEventListener("dragstart", (e) => e.dataTransfer.setData("application/x-msmpl-slot", String(s.slot)));
        }
        grid.append(b);
    });
    $("#count-used").textContent = String(used);
    applyPadFilter(); // re-apply any active filter
    syncKeybed(); // mirror used/loaded/selected onto the piano
}

// dim pads whose name doesn't match the filter box (keeps the fixed 3-col note
// grid intact rather than hiding/reflowing pads)
function applyPadFilter() {
    const q = ($("#pad-search").value || "").trim().toLowerCase();
    for (const b of $("#pad-grid").children) {
        const name = (b.querySelector(".pad-name").textContent || "").toLowerCase();
        const match = !q || (!b.classList.contains("empty") && name.includes(q));
        b.classList.toggle("dimmed", !!q && !match);
    }
}
$("#pad-search").addEventListener("input", applyPadFilter);

// play pads THROUGH THE DEVICE: hold the ▶ corner of a pad → MIDI note
// on/off via the bridge (note 48+slot on the global channel — the same
// sample-mode numbering patterns use). The device plays the sample with
// its real envelope/FX, unlike the browser-side audition.
{
    const grid = $("#pad-grid");
    let down = null; // slot currently sounding
    const noteOff = () => {
        if (down == null) return;
        const slot = down;
        down = null;
        api("/api/note", jsonBody({ slot, on: false })).catch(() => {});
    };
    grid.addEventListener("pointerdown", (e) => {
        const play = closestEl(e.target, ".pad-play");
        if (!play) return;
        e.preventDefault();
        e.stopPropagation(); // don't select the pad
        const pad = closestEl(play, ".pad");
        const slot = +pad.dataset.slot;
        down = slot;
        pad.classList.add("sounding");
        api("/api/note", jsonBody({ slot, on: true, velocity: 100 })).catch((err) => tick(`⚠ note failed: ${err.message}`));
    });
    for (const ev of ["pointerup", "pointercancel"]) {
        window.addEventListener(ev, () => {
            grid.querySelectorAll(".pad.sounding").forEach((p) => p.classList.remove("sounding"));
            noteOff();
        });
    }
    // a click on ▶ must not bubble into the pad's select handler
    grid.addEventListener(
        "click",
        (e) => {
            if (closestEl(e.target, ".pad-play")) e.stopPropagation();
        },
        true
    );
}

// drag & drop a WAV straight onto a pad — selects that slot and opens the
// upload dialog pre-filled with the file (works for used AND empty pads)
{
    const grid = $("#pad-grid");
    const hint = (pad) => {
        for (const p of grid.querySelectorAll(".pad.drop-hint")) if (p !== pad) p.classList.remove("drop-hint");
        if (pad) pad.classList.add("drop-hint");
    };
    grid.addEventListener("dragover", (e) => {
        const pad = closestEl(e.target, ".pad");
        if (!pad) return;
        e.preventDefault();
        e.stopPropagation(); // keep the editor's drop veil out
        hint(pad);
    });
    grid.addEventListener("dragleave", (e) => {
        if (!grid.contains(/** @type {Node} */ (e.relatedTarget))) hint(null);
    });
    grid.addEventListener("drop", (e) => {
        e.preventDefault();
        hint(null);
        const pad = closestEl(e.target, ".pad");
        if (!pad) return;
        const slot = +pad.dataset.slot;
        // pad-to-pad drag → copy/swap dialog (internal drag, no files)
        const from = e.dataTransfer.getData("application/x-msmpl-slot");
        if (from !== "" && +from !== slot) return openSlotOp(+from, slot);
        // file drop → upload to this pad; many WAVs → fill consecutive pads from here
        const wavs = [...e.dataTransfer.files].filter((f) => /\.wav$/i.test(f.name));
        if (!wavs.length) return;
        if (wavs.length > 1) return uploadBatch(slot, wavs);
        state.sel = slot;
        syncPads();
        showSlot(slot); // no await — dialog opens right away
        openUpload(wavs[0]);
    });
}

// ── FOLLOW toggle (default ON): the app selection tracks the last sample
// triggered on the device (manual OR pattern). events.js gates the SSE 'note'
// → waveform.followSelect on state.follow. Device-panel patterns can't be told
// apart from manual play, so this toggle is the only on/off control.
{
    const fb = $("#follow-hw");
    fb.checked = lsGet("msmpl.follow") !== "0";
    state.follow = fb.checked;
    fb.addEventListener("change", () => {
        state.follow = fb.checked;
        lsSet("msmpl.follow", fb.checked ? "1" : "0");
        tick(`follow: ${fb.checked ? "ON" : "OFF"}`);
    });
}
