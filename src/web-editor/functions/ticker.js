// Device event ticker (bottom strip).
import { $ } from "functions/util.js";

let tickerTimer;
export function tick(text) {
    const log = $("#ticker-log");
    const prev = log.textContent.slice(0, 220);
    // build with DOM nodes, not innerHTML: old entries must never round-trip back in as markup
    const b = document.createElement("b");
    b.textContent = text;
    log.replaceChildren(b, `  ${prev}`);
    const led = $("#ticker-led");
    led.classList.add("blip");
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(() => led.classList.remove("blip"), 250);
}
