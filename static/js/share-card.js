// Shareable picture cards: a match result or a GuinnessBet win. Each is
// drawn on a canvas at Instagram story-ish size (1080 x 1350) and handed to
// the phone's share sheet. Where the browser can't share files (most
// desktops), the picture downloads instead.

const W = 1080, H = 1350;
const C = {
  bg: '#0e0e0e', panel: '#171717', line: '#2b2b2b', text: '#f2f2f2', dim: '#9a9a9a', faint: '#5e5e5e',
  gold: '#c9a961', good: '#8ad3ae', live: '#ff5a5a',
};
const F = '"D-DIN PRO", "Bahnschrift", system-ui, sans-serif';

async function fontsReady() {
  try {
    await Promise.all(['400', '600', '700', '800'].map(w => document.fonts.load(`${w} 40px "D-DIN PRO"`)));
  } catch { /* draw with whatever is there */ }
}

function canvas() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  return [c, g];
}

// `mid: true` puts the middle of capitals and figures exactly on y, so
// labels and numbers of different sizes sit centred in the same row.
function text(g, s, x, y, { size = 40, weight = 400, color = C.text, align = 'left', max = null, spacing = 0, mid = false } = {}) {
  g.font = `${weight} ${size}px ${F}`;
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
  let str = String(s ?? '');
  if (max) {   // shrink to fit rather than run off the card
    let sz = size;
    while (sz > 18 && g.measureText(str).width > max) { sz -= 2; g.font = `${weight} ${sz}px ${F}`; }
  }
  if (mid) {
    const m = g.measureText('H0');
    y += (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  }
  g.fillText(str, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}

function header(g, kicker, title) {
  text(g, 'UOS DARTS', 80, 130, { size: 34, weight: 700, color: C.gold, spacing: 6 });
  text(g, kicker.toUpperCase(), 80, 190, { size: 30, weight: 600, color: C.dim, spacing: 3, max: W - 160 });
  if (title) text(g, title, 80, 262, { size: 64, weight: 800, max: W - 160 });
}

function footer(g, note) {
  g.fillStyle = C.line; g.fillRect(80, H - 150, W - 160, 2);
  text(g, note ?? '', 80, H - 90, { size: 30, color: C.dim, max: W - 420 });
  text(g, 'uosdarts.com', W - 80, H - 90, { size: 32, weight: 700, color: C.gold, align: 'right' });
}

function box(g, x, y, w, h, r = 18, fill = C.panel, stroke = C.line) {
  g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill();
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2; g.stroke(); }
}

// ------------------------------------------------------------ the cards

// { event, round, date, name1, name2, score1, score2, unit, winner (1|2), stats: [[label, a, b], ...] }
export async function resultCard(r) {
  await fontsReady();
  const [c, g] = canvas();
  // The event and round once each: a friendly is just "Friendly".
  header(g, [...new Set([r.event, r.round].filter(Boolean))].join(' · '), 'Full time');
  const side = (n, y) => {
    const won = r.winner === n;
    box(g, 80, y, W - 160, 160, 22, won ? '#1f1b12' : C.panel, won ? C.gold : C.line);
    text(g, n === 1 ? r.name1 : r.name2, 130, y + 95, { size: 58, weight: won ? 800 : 600, color: won ? C.text : C.dim, max: W - 420 });
    text(g, n === 1 ? r.score1 : r.score2, W - 130, y + 115, { size: 108, weight: 800, color: won ? C.gold : C.dim, align: 'right' });
    if (won) text(g, 'WINNER', 130, y + 135, { size: 22, weight: 700, color: C.gold, spacing: 4 });
  };
  side(1, 310); side(2, 490);
  text(g, (r.unit ?? 'legs').toUpperCase(), W - 130, 690, { size: 22, weight: 600, color: C.faint, align: 'right', spacing: 3 });
  // Every stat from the match page, spaced to fit however many there are.
  const rows = (r.stats ?? []).filter(s => s[1] != null || s[2] != null);
  // Equal bands between the score boxes and the footer line; each row's
  // figures and label are centred in their band, dividers sit on the edges.
  const top = 720, bottom = 1170;
  const gap = Math.min(70, (bottom - top) / Math.max(rows.length, 1));
  rows.forEach(([label, a, b], i) => {
    const cy = top + gap * (i + .5);
    if (i) { g.fillStyle = '#1e1e1e'; g.fillRect(130, Math.round(top + gap * i) - 1, W - 260, 2); }
    text(g, a ?? '–', 130, cy, { size: 40, weight: 700, color: r.winner === 1 ? C.text : C.dim, max: 300, mid: true });
    text(g, label.toUpperCase(), W / 2, cy, { size: 22, weight: 600, color: C.faint, align: 'center', spacing: 3, mid: true });
    text(g, b ?? '–', W - 130, cy, { size: 40, weight: 700, color: r.winner === 2 ? C.text : C.dim, align: 'right', max: 300, mid: true });
  });
  footer(g, r.date);
  return c;
}

// { selection, market, price, stake, paid, cashedOut, legs: [{label, price}] }
export async function betWinCard(b) {
  await fontsReady();
  const [c, g] = canvas();
  const tok = n => Number(n ?? 0).toLocaleString('en-GB');
  header(g, b.boost ? 'GuinnessBet superboost' : 'GuinnessBet', b.cashedOut ? 'Cashed out' : 'Winner');
  const legs = b.legs ?? [];
  let y;
  if (legs.length) {
    // An acca: the fold and its odds, then every pick with its price.
    box(g, 80, 310, W - 160, 130, 22, '#1f1b12', C.gold);
    text(g, `${legs.length}-fold acca`, 130, 395, { size: 58, weight: 800, max: W - 460 });
    box(g, W - 330, 330, 200, 90, 14, C.gold, null);
    text(g, b.price, W - 230, 375, { size: 52, weight: 800, color: '#111', align: 'center', max: 180, mid: true });
    const shown = legs.slice(0, 6);
    const gap = Math.min(92, 520 / shown.length);
    shown.forEach((l, i) => {
      const top = 480 + i * gap;
      text(g, '✓', 100, top + 34, { size: 34, weight: 700, color: C.good });
      text(g, l.label, 150, top + 34, { size: 36, weight: 700, max: W - 420 });
      if (l.title) text(g, l.title, 150, top + 70, { size: 24, color: C.dim, max: W - 420 });
      text(g, l.price ?? '', W - 110, top + 34, { size: 36, weight: 700, color: C.gold, align: 'right' });
    });
    if (legs.length > shown.length) text(g, `+${legs.length - shown.length} more`, 150, 480 + shown.length * gap + 30, { size: 26, color: C.dim });
    y = 1040;
    text(g, 'STAKE', 130, y, { size: 24, weight: 600, color: C.faint, spacing: 4 });
    text(g, tok(b.stake), 130, y + 64, { size: 60, weight: 700, color: C.dim });
    text(g, b.cashedOut ? 'CASHED OUT FOR' : 'PAID', W - 130, y, { size: 24, weight: 600, color: C.faint, spacing: 4, align: 'right' });
    text(g, tok(b.paid), W - 130, y + 64, { size: 60, weight: 800, color: C.good, align: 'right' });
    text(g, `+${tok(Number(b.paid) - Number(b.stake))}`, W / 2, y + 64, { size: 60, weight: 800, color: C.gold, align: 'center' });
  } else {
    box(g, 80, 330, W - 160, 300, 22, '#1f1b12', C.gold);
    text(g, b.selection, 130, 440, { size: 64, weight: 800, max: W - 500 });
    text(g, b.market ?? '', 130, 505, { size: 32, color: C.dim, max: W - 500 });
    box(g, W - 330, 385, 200, 100, 14, C.gold, null);
    text(g, b.price, W - 230, 435, { size: 56, weight: 800, color: '#111', align: 'center', max: 180, mid: true });
    if (b.was) {   // a superboost: the old price, struck through
      text(g, b.was, W - 230, 540, { size: 40, weight: 600, color: C.dim, align: 'center', mid: true });
      g.font = `600 40px ${F}`;
      const w = g.measureText(b.was).width;
      g.fillStyle = C.dim; g.fillRect(W - 230 - w / 2 - 6, 538, w + 12, 4);
    }
    text(g, 'STAKE', 130, 760, { size: 26, weight: 600, color: C.faint, spacing: 4 });
    text(g, tok(b.stake), 130, 840, { size: 80, weight: 700, color: C.dim });
    text(g, b.cashedOut ? 'CASHED OUT FOR' : 'PAID', W - 130, 760, { size: 26, weight: 600, color: C.faint, spacing: 4, align: 'right' });
    text(g, tok(b.paid), W - 130, 840, { size: 80, weight: 800, color: C.good, align: 'right' });
    text(g, `+${tok(Number(b.paid) - Number(b.stake))} tokens`, W / 2, 1010, { size: 92, weight: 800, color: C.gold, align: 'center' });
  }
  footer(g, 'Tokens only. No real money.');
  return c;
}

// ------------------------------------------------------------ sharing

// Opens a preview of the picture in a pop-up. From there it can be saved,
// or sent straight to the share sheet where the phone supports sharing
// pictures.
export async function share(c, { filename = 'uosdarts.png', title = 'UOS Darts', text: msg = '', url = '' } = {}) {
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], filename, { type: 'image/png' });
  const src = URL.createObjectURL(blob);
  const canShare = !!navigator.canShare?.({ files: [file] });
  const d = document.createElement('dialog');
  d.className = 'share-preview';
  d.innerHTML = `<div class="sp-inner">
    <img src="${src}" alt="${title.replace(/[<>&"]/g, '')}">
    <div class="sp-btns">
      ${canShare ? '<button class="primary" data-sp="share">Share</button>' : ''}
      <a class="button${canShare ? '' : ' primary'}" data-sp="save" href="${src}" download="${filename.replace(/[^\w.-]/g, '')}">Save image</a>
      <button data-sp="close">Close</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); setTimeout(() => URL.revokeObjectURL(src), 1000); };
  d.addEventListener('click', async e => {
    if (e.target === d) return close();   // tap outside the picture
    const b = e.target.closest('[data-sp]');
    if (!b) return;
    if (b.dataset.sp === 'close') return close();
    if (b.dataset.sp === 'share') {
      try { await navigator.share({ files: [file], title, text: [msg, url].filter(Boolean).join(' ') }); } catch { /* closed */ }
    }
  });
  d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  d.showModal();
  return 'shown';
}
