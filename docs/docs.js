// Shared docs behaviour (no dependencies). The active nav link is set per page
// server-side (class="active"); this only handles the bits that need JS.

// mobile menu toggle (aria-expanded mirrors the open state for AT)
const menuBtn = document.querySelector('.menu-btn');
const nav = document.querySelector('.topnav nav');
if (menuBtn && nav) {
  nav.id = nav.id || 'site-nav';
  menuBtn.setAttribute('aria-controls', nav.id);
  const sync = () => menuBtn.setAttribute('aria-expanded', String(nav.classList.contains('open')));
  sync();
  menuBtn.addEventListener('click', () => { nav.classList.toggle('open'); sync(); });
  nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { nav.classList.remove('open'); sync(); }));
}

// back-to-top button appears after scrolling
const toTop = document.querySelector('.to-top');
if (toTop) {
  const onScroll = () => toTop.classList.toggle('show', window.scrollY > 600);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  // scroll to the very top in JS — the href="#top" anchor targets the sticky
  // nav, which browsers treat as already in view (so it only nudged per click)
  toTop.addEventListener('click', e => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// clickable permalinks on section headings (h2 with an id). aria-hidden so the
// "#" doesn't get read into every heading's accessible name; the heading ids
// remain linkable through the URL/TOC for AT users.
document.querySelectorAll('.content h2[id]').forEach(h => {
  const a = document.createElement('a');
  a.href = '#' + h.id;
  a.className = 'anchor';
  a.textContent = '#';
  a.setAttribute('aria-hidden', 'true');
  a.tabIndex = -1;
  h.append(a);
});
