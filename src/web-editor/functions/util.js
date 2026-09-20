// Shared helpers: DOM lookup, escaping, formatting, bridge API access.
import { readWavHeader } from "functions/audioTools.js";

// AppEl is deliberately PERMISSIVE: every element type the app actually pulls
// out of its own markup, intersected. The DOM lookups really return `Element`,
// which would make `.value` / `.checked` / `.showModal` / `.getContext` /
// `.dataset` an error at ~180 call sites and force a cast on each one. The
// intersection trades that precision (a `$("#some-div").value` still passes) for
// keeping the rest of the type checking — misspelled methods, bad arithmetic,
// wrong argument types — available without a mass refactor. Tighten it later by
// splitting out typed helpers ($input, $dialog) if the looseness ever bites.
/** @typedef {HTMLElement & HTMLInputElement & HTMLDialogElement & HTMLCanvasElement & HTMLAnchorElement} AppEl */

/** @type {(s: string) => AppEl} */
export const $ = (s) => document.querySelector(s);

/** @type {(s: string, root?: ParentNode) => NodeListOf<AppEl>} */
export const $$ = (s, root = document) => root.querySelectorAll(s);

// `ev.target` is an EventTarget, so the delegation idiom `e.target.closest(sel)`
// needs a cast at every handler. This wraps it once.
/** @type {(t: EventTarget, s: string) => AppEl} */
export const closestEl = (t, s) => (t instanceof Element ? t.closest(s) : null);

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const fmtSigned = (v) => (v > 0 ? "+" : "") + v;

export async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
        let msg = r.statusText;
        try {
            msg = (await r.json()).error || msg;
        } catch {
            /* binary/none */
        }
        throw new Error(msg);
    }
    return r;
}
export const apiJson = async (path, opts) => (await api(path, opts)).json();

// localStorage wrappers — persistence is best-effort: private-mode, a disabled
// store, or a quota error must never throw into the caller. lsGet returns the
// fallback when the key is missing OR storage is unavailable; lsSet is a no-op
// on failure.
export function lsGet(key, fallback = null) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    } catch {
        return fallback;
    }
}
export function lsSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* ignore */
    }
}

// opts for a JSON POST — pass to api() (raw response) or apiJson() (parsed),
// whichever the caller needs. Centralises the method + Content-Type + stringify.
export const jsonBody = (data) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
});

// styled replacement for window.confirm — a themed <dialog>, returns a
// Promise<boolean> (native dialog gives focus-trap + Esc-to-cancel for free).
export function confirmDialog(title, body, okLabel = "OK") {
    const dlg = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-body").textContent = body;
    $("#confirm-ok .hw-btn-cap").textContent = okLabel;
    return new Promise((resolve) => {
        dlg.onclose = () => resolve(dlg.returnValue === "ok");
        dlg.showModal();
    });
}

export function wavFormat(arrayBuf) {
    // channels + rate off the shared RIFF/WAVE chunk walk (device WAVs have a
    // canonical 44-byte header, so a 44-byte slice is enough — see sampleLoad)
    const h = readWavHeader(new DataView(arrayBuf));
    return h ? { channels: h.channels, rate: h.rate } : null;
}

// clamp a BPM into the device's supported range (also the pattern-playhead
// sweep range) — used wherever a bank/pattern BPM drives timing.
export const clampBpm = (bpm) => Math.max(20, Math.min(300, bpm || 120));

// Approximate looping playhead: sweep `el` left→right across `width` px over
// `durMs`, looping, via a compositor-only transform. `alive()` gates each frame
// (stopped / superseded). Returns a stop() that cancels the rAF. Shared by the
// pattern card mini-rolls and the pattern-editor preview (the waveform audition
// playhead is bespoke — reverse / one-shot / zoom-clipping).
export function sweepPlayhead(el, durMs, width, alive) {
    let t0 = null,
        raf = null;
    const frame = (ts) => {
        if (!alive()) return;
        if (t0 == null) t0 = ts;
        el.style.transform = `translateX(${(((ts - t0) % durMs) / durMs) * width}px)`;
        raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
        if (raf) cancelAnimationFrame(raf);
    };
}

// toggle `.on` + aria-pressed across a segmented button group. `pairs` is
// [[element, isActive], …] — the single spelling of the pattern that was
// hand-rolled in the keyboard mode switch, pattern-editor tool/track, etc.
export function setSegActive(pairs) {
    for (const [el, on] of pairs) {
        el.classList.toggle("on", on);
        el.setAttribute("aria-pressed", String(on));
    }
}
