// @ts-check
// Slot editor header: name LCD, info chips, start/end readout, control init.
import { applySlotControls } from "components/controls/controls.js";
import { loadWave } from "components/sample-editor/waveform.js";
import { noteName } from "functions/notes.js";
import { slotData, state } from "functions/state.js";
import { tick } from "functions/ticker.js";
import { $, apiJson, closestEl, jsonBody } from "functions/util.js";

export async function showSlot(i, { keepWave = false } = {}) {
    const s = slotData(i);
    $("#editor-empty").hidden = true;
    $("#editor-body").hidden = false;
    $("#sel-slot").textContent = noteName(i);
    $("#sel-name").textContent = s.empty ? "--------" : s.name.padEnd(8);
    $("#sel-long").textContent = s.empty ? "EMPTY SLOT" : s.long_name || "";
    $("#download-btn").href = `/api/sample/${i}.wav`;
    $("#download-btn").style.visibility = s.empty ? "hidden" : "visible";
    $("#audition-btn").style.visibility = s.empty ? "hidden" : "visible";
    $("#rename-btn").style.visibility = s.empty ? "hidden" : "visible";
    $("#clear-btn").style.visibility = s.empty ? "hidden" : "visible";

    renderChips(s);

    // controls — fully initialised from the bank blob (flags8 decoded
    // 2026-06-08: bit7=loop, bits5-6=bpm sync, bit4=reverse, bit3=fx sw)
    applySlotControls(s);

    // start/end points — editable by dragging the S/E flags on the waveform
    renderPoints(s);
    if (!s.empty) renderMetaFmt(s);
    else $("#meta-fmt").textContent = "";

    // waveform
    if (!keepWave) await loadWave(i);
}

// Rate/length aren't in the bank blob — they arrive once the WAV is fetched
// (reading headers per slot would strand the device's sample-select state).
export function renderPoints(s) {
    const ro = $("#ro-row");
    if (s.empty) {
        ro.innerHTML = "";
        return;
    }
    // editable START/END (device frames) — committed by waveform.js. Build the
    // inputs once, then only update their values, so a drag redraw doesn't churn
    // the DOM or stomp a field the user is typing in.
    let si = /** @type {HTMLInputElement} */ (ro.querySelector('[data-point="start"]'));
    if (!si) {
        ro.innerHTML = `<label class="ro">START <input class="ro-input" type="number" data-point="start" min="0" step="1"></label>
       <label class="ro">END <input class="ro-input" type="number" data-point="end" min="0" step="1"></label>`;
        si = /** @type {HTMLInputElement} */ (ro.querySelector('[data-point="start"]'));
    }
    const ei = /** @type {HTMLInputElement} */ (ro.querySelector('[data-point="end"]'));
    const max = (s.frames || 2) - 2;
    si.max = ei.max = String(max);
    // not editable until the WAV (hence the frame count) has loaded — committing a
    // point against an unknown length clamps to a 1-frame region (corrupts the
    // sample on the device). loadWave() re-renders to re-enable once frames known.
    si.disabled = ei.disabled = !s.frames;
    if (document.activeElement !== si) si.value = s.start;
    if (document.activeElement !== ei) ei.value = s.end;
}

export function renderChips(s) {
    const chips = $("#info-chips");
    chips.innerHTML = "";
    if (s.empty) return;
    const pairs = [];
    if (s.rate_hz) {
        pairs.push(
            ["RATE", `${s.rate_hz / 1000}k`],
            ["CH", s.stereo ? "ST" : "MONO"],
            ["LEN", `${s.seconds >= 10 ? s.seconds.toFixed(1) : s.seconds.toFixed(2)}s`]
        );
    } else {
        pairs.push(["RATE", "—"], ["LEN", "—"]);
    }
    for (const [k, v] of pairs) chips.insertAdjacentHTML("beforeend", `<span class="chip">${k} <b>${v}</b></span>`);
    // ORIG BPM is editable — a normal button (styled like the others) opens the
    // dialog (it re-uploads); the static RATE/CH/LEN chips are plain readouts
    if (s.tempo_bpm)
        chips.insertAdjacentHTML(
            "beforeend",
            `<button class="hw-btn chip-bpm" id="chip-bpm" type="button"
         title="Original BPM (sample tempo) — click to edit"><span class="hw-btn-cap">BPM <b>${s.tempo_bpm.toFixed(1)}</b></span></button>`
        );
}

// ORIG BPM lives only in the sample's upload header, so there is no live command —
// applying re-uploads the sample (audio + all other params preserved). A dialog
// (like the bank name/BPM editor) makes the value + decimals legible and the
// re-upload deliberate.
$("#info-chips").addEventListener("click", (e) => {
    if (!closestEl(e.target, "#chip-bpm") || state.sel == null) return;
    const s = slotData(state.sel);
    if (s.empty || !s.tempo_bpm) return;
    $("#td-bpm").value = s.tempo_bpm.toFixed(1);
    $("#tempo-dialog").showModal();
});
$("#td-ok").onclick = async (e) => {
    e.preventDefault();
    if (state.sel == null) return;
    const i = state.sel,
        s = slotData(i);
    const raw = parseFloat($("#td-bpm").value);
    // blank/garbage input must NO-OP — clamping it first would turn '' into 20
    // and trigger the destructive re-upload at BPM 20
    if (!Number.isFinite(raw)) {
        $("#tempo-dialog").close();
        return;
    }
    const bpm = Math.max(20, Math.min(300, raw));
    if (Math.abs(bpm - (s.tempo_bpm || 0)) < 0.05) {
        $("#tempo-dialog").close();
        return;
    }
    $("#td-ok").setAttribute("aria-busy", "true"); // dims APPLY while the re-upload runs
    tick(`→ ${noteName(i)} rewriting sample (ORIG BPM ${bpm.toFixed(1)})…`);
    try {
        const r = await apiJson(`/api/sample/${i}/tempo`, jsonBody({ bpm }));
        s.tempo_bpm = r.tempo_bpm;
        if (state.sel === i) renderChips(s);
        tick(`→ ${noteName(i)} ORIG BPM = ${r.tempo_bpm.toFixed(1)}`);
        $("#tempo-dialog").close();
    } catch (err) {
        tick(`⚠ ORIG BPM failed: ${err.message}`);
    } finally {
        $("#td-ok").removeAttribute("aria-busy");
    }
};

export function renderMetaFmt(s) {
    $("#meta-fmt").textContent = s.frames
        ? `${s.frames.toLocaleString()} FRAMES · 16-BIT ${s.stereo ? "STEREO" : "MONO"}`
        : "CLICK ▶ PLAY OR WAIT FOR THE WAVEFORM TO LOAD FORMAT DETAILS";
}
