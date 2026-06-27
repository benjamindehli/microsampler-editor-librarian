// Shared docs behaviour (no dependencies). The active nav link is set per page
// server-side (class="active"); this only handles the bits that need JS.

// mobile menu toggle
const menuBtn = document.querySelector('.menu-btn');
const nav = document.querySelector('.topnav nav');
if (menuBtn && nav) {
  menuBtn.addEventListener('click', () => nav.classList.toggle('open'));
  nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.classList.remove('open')));
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

// clickable permalinks on section headings (h2 with an id)
document.querySelectorAll('.content h2[id]').forEach(h => {
  const a = document.createElement('a');
  a.href = '#' + h.id;
  a.className = 'anchor';
  a.textContent = '#';
  a.setAttribute('aria-label', 'Link to this section');
  h.append(a);
});
