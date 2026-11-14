import { sb } from '../db.js';

const root = document.querySelector('.ds');
if (root) {
  fitToViewport();
  centreTheCast();
  countdown();
  reveal();
  fillOomPlaces();
}

// A full-height section has to allow for the site header above it, or the
// scroll cue ends up just below the fold. The header's height changes when
// the nav wraps, so measure it rather than guessing.
function fitToViewport() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  const apply = () => root.style.setProperty('--ds-top', `${Math.round(header.offsetHeight)}px`);
  apply();
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(header);
  else addEventListener('resize', apply);
}

// On a phone the cast is wider than the screen and scrolls sideways. Start
// it on the captain rather than at the far left. Purely a convenience: the
// figures are visible with or without this.
function centreTheCast() {
  const wrap = document.querySelector('.ds-cast-wrap');
  const centre = document.querySelector('.ds-cast-fig.is-named');
  if (!wrap || !centre) return;
  const place = () => {
    if (wrap.scrollWidth <= wrap.clientWidth) return;   // they all fit
    wrap.scrollLeft = centre.offsetLeft - (wrap.clientWidth - centre.offsetWidth) / 2;
  };
  place();
  addEventListener('resize', place);
}

// ---------------------------------------------------------------- countdown

function countdown() {
  const el = document.getElementById('ds-countdown');
  const raw = root.dataset.eventDate;
  if (!el || !raw) return;
  const target = new Date(`${raw}T19:00:00`);
  if (Number.isNaN(target.getTime())) return;

  const tick = () => {
    const ms = target - Date.now();
    if (ms <= 0) { el.textContent = 'Tonight'; return; }
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor(ms / 3600000) % 24;
    el.textContent = days > 1 ? `${days} days to go`
      : days === 1 ? `1 day, ${hours} hours to go`
      : `${hours} hours to go`;
  };
  tick();
  setInterval(tick, 60000);
}

// ------------------------------------------------- arrive on scroll

// Sections fade up as they come into view. If the browser can't observe
// intersections, everything is simply shown.
function reveal() {
  const bits = [
    ...document.querySelectorAll('.ds-player-art'),
    ...document.querySelectorAll('.ds-player-body'),
    ...document.querySelectorAll('.ds-outro-inner'),
  ];
  if (!('IntersectionObserver' in window)
      || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    bits.forEach(b => b.classList.add('ds-reveal', 'is-in'));
    return;
  }
  bits.forEach(b => b.classList.add('ds-reveal'));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);          // once it has arrived, leave it alone
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 });
  bits.forEach(b => io.observe(b));
}

// --------------------------------------------------------- order of merit

// Each named player's current place, read live. Anyone not on the table has
// their slot removed rather than showing a blank.
async function fillOomPlaces() {
  const slots = [...document.querySelectorAll('[data-oom-for]')];
  if (!slots.length) return;

  const args = { p_pc_only: false };
  if (root.dataset.season) args.p_season = root.dataset.season;

  const { data, error } = await sb.rpc('oom_table', args);
  if (error || !data) { slots.forEach(el => el.remove()); return; }

  const bySlug = new Map(data.map(r => [r.player_slug, r]));
  for (const el of slots) {
    const row = bySlug.get(el.dataset.oomFor);
    if (row && row.rank) {
      el.textContent = `Order of Merit #${row.rank}`;
      el.hidden = false;
    } else {
      el.remove();
    }
  }
}
