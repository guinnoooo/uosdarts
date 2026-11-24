// Futures: Ham Cup winner and the Dartsity markets. Prices are set by hand
// on the super admin page, and a bet keeps the price it was placed at.

import { sb, esc } from '../db.js';
import { loadAccount, account, slipHtml, slipEvent, statusText, cancelButton, fmtTokens } from '../betting.js';

const app = document.getElementById('app');
const S = { markets: [], bets: [], slip: null, all: new Set() };
const SHOW = 8;

const when = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function load() {
  const [board] = await Promise.all([sb.rpc('futures_board'), loadAccount()]);
  if (board.error) throw board.error;
  S.markets = board.data ?? [];
  await loadBets();
}

async function loadBets() {
  if (!account()) { S.bets = []; return; }
  const { data } = await sb.rpc('my_bets', { p_limit: 200 });
  S.bets = (data ?? []).filter(b => b.future_market && b.status !== 'cancelled');
}

const RESULT = { won: 'Won', lost: 'Lost', void: 'Void' };

function marketHtml(m) {
  const mine = S.bets.filter(b => b.future_market === m.id);
  const list = m.selections;
  const shown = S.all.has(m.id) ? list : list.slice(0, SHOW);
  const slipHere = S.slip?.market === m.id;
  const state = m.open ? (m.closes_at ? `Closes ${when(m.closes_at)}` : '')
    : m.status === 'suspended' ? 'Suspended' : m.status === 'settled' ? 'Settled' : 'Closed';
  const cell = s => {
    if (s.result) return `<span class="muted small">${RESULT[s.result]}</span>`;
    if (!s.price) return '';
    return m.open
      ? `<button class="odds-pick small-pick${S.slip?.future_id === s.id ? ' on' : ''}" data-fbet="${s.id}"><b>${esc(s.price)}</b></button>`
      : `<b>${esc(s.price)}</b>`;
  };
  return `<section class="panel outright">
    <h2>${esc(m.title)}</h2>
    ${m.rules ? `<p class="muted small">${esc(m.rules)}</p>` : ''}
    ${state ? `<p class="small">${esc(state)}</p>` : ''}
    ${slipHere ? slipHtml(S.slip) : ''}
    ${mine.length ? `<div class="my-bets"><h3>Your bets</h3><ul>${mine.map(b => `<li>
        <span><b>${fmtTokens(b.stake)}</b> on ${esc(b.selection)} at ${esc(b.price)}</span>
        <span class="muted small">${statusText(b)}</span> ${cancelButton(b)}</li>`).join('')}</ul></div>` : ''}
    ${list.length ? `<table class="outright-list futures-list"><tbody>${shown.map(s => `<tr>
      <td class="l">${esc(s.name)}</td><td>${cell(s)}</td></tr>`).join('')}</tbody></table>
    ${list.length > SHOW ? `<button class="link" data-fall="${m.id}">${S.all.has(m.id) ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}`
    : '<p class="muted">No prices yet.</p>'}
    ${m.open ? '<p class="muted small">Others available on request. Bets can be cancelled free for 24 hours, then cashed out at the current price less a 10% fee.</p>' : ''}
  </section>`;
}

function render() {
  app.innerHTML = S.markets.length
    ? S.markets.map(marketHtml).join('')
    : '<section class="panel"><h2>Futures</h2><p class="muted">No markets open yet.</p></section>';
}

const ctx = {
  slip: () => S.slip,
  set: v => { S.slip = v; },
  render,
  changed: async () => { await load(); },
};

app.addEventListener('input', e => { slipEvent(e, ctx); });
app.addEventListener('click', async e => {
  const more = e.target.closest('[data-fall]');
  if (more) {
    const id = Number(more.dataset.fall);
    if (S.all.has(id)) S.all.delete(id); else S.all.add(id);
    render();
    return;
  }
  const pick = e.target.closest('[data-fbet]');
  if (pick) {
    const id = Number(pick.dataset.fbet);
    const m = S.markets.find(x => x.selections.some(s => s.id === id));
    const s = m?.selections.find(x => x.id === id);
    if (!s?.price) return;
    S.slip = { kind: 'future', future_id: id, market: m.id, selection: s.name, price: s.price, stake: S.slip?.stake ?? 100 };
    render();
    return;
  }
  await slipEvent(e, ctx);
});

load().then(render, err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
