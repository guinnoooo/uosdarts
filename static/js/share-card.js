// Shareable picture cards: a match result, a GuinnessBet win or a player's
// order of merit points. Each is drawn on a canvas at Instagram story-ish size (1080 x 1350)
// and handed to the phone's share sheet. Where the browser can't share
// files (most desktops), the picture downloads instead.

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
  // A faint dartboard in the corner, so it's recognisably ours.
  g.save(); g.globalAlpha = .07; g.strokeStyle = C.gold; g.lineWidth = 6;
  for (const r of [420, 330, 250, 150, 60]) { g.beginPath(); g.arc(W - 40, 120, r, 0, Math.PI * 2); g.stroke(); }
  for (let i = 0; i < 20; i++) {
    const a = i * Math.PI / 10;
    g.beginPath(); g.moveTo(W - 40 + 60 * Math.cos(a), 120 + 60 * Math.sin(a)); g.lineTo(W - 40 + 420 * Math.cos(a), 120 + 420 * Math.sin(a)); g.stroke();
  }
  g.restore();
  return [c, g];
}

function text(g, s, x, y, { size = 40, weight = 400, color = C.text, align = 'left', max = null, spacing = 0 } = {}) {
  g.font = `${weight} ${size}px ${F}`;
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
  let str = String(s ?? '');
  if (max) {   // shrink to fit rather than run off the card
    let sz = size;
    while (sz > 18 && g.measureText(str).width > max) { sz -= 2; g.font = `${weight} ${sz}px ${F}`; }
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
  header(g, [r.event, r.round].filter(Boolean).join(' · '), 'Full time');
  const side = (n, y) => {
    const won = r.winner === n;
    box(g, 80, y, W - 160, 190, 22, won ? '#1f1b12' : C.panel, won ? C.gold : C.line);
    text(g, n === 1 ? r.name1 : r.name2, 130, y + 115, { size: 62, weight: won ? 800 : 600, color: won ? C.text : C.dim, max: W - 420 });
    text(g, n === 1 ? r.score1 : r.score2, W - 130, y + 130, { size: 120, weight: 800, color: won ? C.gold : C.dim, align: 'right' });
    if (won) text(g, 'WINNER', 130, y + 160, { size: 24, weight: 700, color: C.gold, spacing: 4 });
  };
  side(1, 330); side(2, 545);
  text(g, (r.unit ?? 'legs').toUpperCase(), W - 130, 775, { size: 24, weight: 600, color: C.faint, align: 'right', spacing: 3 });
  const rows = (r.stats ?? []).filter(s => s[1] != null || s[2] != null).slice(0, 5);
  rows.forEach(([label, a, b], i) => {
    const y = 880 + i * 72;
    text(g, a ?? '–', 130, y, { size: 46, weight: 700, color: r.winner === 1 ? C.text : C.dim });
    text(g, label.toUpperCase(), W / 2, y - 6, { size: 24, weight: 600, color: C.faint, align: 'center', spacing: 3 });
    text(g, b ?? '–', W - 130, y, { size: 46, weight: 700, color: r.winner === 2 ? C.text : C.dim, align: 'right' });
  });
  footer(g, r.date);
  return c;
}

// { selection, market, price, stake, paid, cashedOut, legs: [{label, price}] }
export async function betWinCard(b) {
  await fontsReady();
  const [c, g] = canvas();
  header(g, 'GuinnessBet', b.cashedOut ? 'Cashed out' : 'Winner');
  box(g, 80, 330, W - 160, 300, 22, '#1f1b12', C.gold);
  text(g, b.selection, 130, 440, { size: 64, weight: 800, max: W - 460 });
  text(g, b.market ?? '', 130, 505, { size: 32, color: C.dim, max: W - 460 });
  box(g, W - 330, 385, 200, 100, 14, C.gold, null);
  text(g, b.price, W - 230, 455, { size: 56, weight: 800, color: '#111', align: 'center', max: 180 });
  if (b.legs?.length) text(g, `${b.legs.length}-fold acca`, 130, 590, { size: 30, weight: 600, color: C.gold });
  const tok = n => Number(n ?? 0).toLocaleString('en-GB');
  text(g, 'STAKE', 130, 760, { size: 26, weight: 600, color: C.faint, spacing: 4 });
  text(g, tok(b.stake), 130, 840, { size: 80, weight: 700, color: C.dim });
  text(g, b.cashedOut ? 'CASHED OUT FOR' : 'PAID', W - 130, 760, { size: 26, weight: 600, color: C.faint, spacing: 4, align: 'right' });
  text(g, tok(b.paid), W - 130, 840, { size: 80, weight: 800, color: C.good, align: 'right' });
  const profit = Number(b.paid) - Number(b.stake);
  text(g, `+${tok(profit)} tokens`, W / 2, 1010, { size: 92, weight: 800, color: C.gold, align: 'center' });
  footer(g, 'Tokens only. No real money.');
  return c;
}

// { name, total, rank, events: [{ name, pts, total, won }] }
export async function oomCard(p) {
  await fontsReady();
  const [c, g] = canvas();
  header(g, 'Order of merit', p.name);
  text(g, Number(p.total).toLocaleString('en-GB'), 80, 470, { size: 190, weight: 800, color: C.gold });
  text(g, `points${p.rank ? ` · #${p.rank} on the OoM` : ''}`, 80, 545, { size: 44, weight: 600, color: C.dim });
  const ev = p.events ?? [];
  if (ev.length >= 2) {
    const L = 100, R = W - 100, T = 650, B = 1080;
    const hi = ev.at(-1).total * 1.08 || 1;
    const x = i => L + i * (R - L) / ev.length;
    const y = v => B - v * (B - T) / hi;
    box(g, 80, T - 40, W - 160, B - T + 80, 22);
    g.strokeStyle = C.gold; g.lineWidth = 7; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x(0), y(0)); ev.forEach((q, i) => g.lineTo(x(i + 1), y(q.total))); g.stroke();
    ev.forEach((q, i) => {
      if (q.won) { g.beginPath(); g.arc(x(i + 1), y(q.total), 22, 0, Math.PI * 2); g.strokeStyle = C.gold; g.lineWidth = 4; g.stroke(); }
      g.beginPath(); g.arc(x(i + 1), y(q.total), 10, 0, Math.PI * 2); g.fillStyle = C.gold; g.fill();
    });
  }
  const wins = ev.filter(q => q.won).length;
  footer(g, wins ? `${wins} event win${wins === 1 ? '' : 's'} this season` : `${ev.length} events with points this season`);
  return c;
}

// ------------------------------------------------------------ sharing

export async function share(c, { filename = 'uosdarts.png', title = 'UOS Darts', text: msg = '', url = '' } = {}) {
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], filename, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title, text: [msg, url].filter(Boolean).join(' ') });
      return 'shared';
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'closed';   // they closed the share sheet
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}
