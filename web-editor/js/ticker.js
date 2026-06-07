// Device event ticker (bottom strip).
import { $ } from './util.js';

let tickerTimer;
export function tick(text) {
  const log = $('#ticker-log');
  const prev = log.textContent.slice(0, 220);
  const b = document.createElement('b');
  b.textContent = text;                 // DOM nodes, not innerHTML — old
  log.replaceChildren(b, `  ${prev}`);  // entries must never round-trip
  const led = $('#ticker-led');         // back in as markup (CodeQL js/xss)
  led.classList.add('blip');
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => led.classList.remove('blip'), 250);
}
