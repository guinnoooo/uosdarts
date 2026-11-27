// Odds: every upcoming match that can be bet on, grouped by event, for
// building an acca. Tap a price to put it in the acca (tap again to take it
// out). The winner prices show straight away; the other markets for a match
// are only worked out when its "More markets" is opened.

import { sb, esc, matchLabel } from '../db.js';
import { oomScores, matchChance, isThin } from '../winprob.js';
import { bookPrices } from '../prices.js';
import { matchMarkets, pickLabel, legTitle } from '../markets.js';
import { loadAccount, slipEvent, accaBarHtml, accaHas, accaToggle, accaPicks } from '../betting.js';

const app = document.getElementById('app');
const S = { matches: [], oom: [], open: new Set(), more: new Set(), markets: new Map(), loaded: false, error: null };

const day = d => (d ? new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

async function load() {
  const [board] = await Promise.all([sb.rpc('odds_board'), loadAccount().catch(() => null)]);
  if (board.error) { S.error = board.error.message; render(); return; }
  S.oom = board.data?.oom ?? [];
  S.matches = (board.data?.matches ?? []).map(m => {
    const pv = { ...m.preview, oom: oomScores(S.oom, m.name1, m.name2) };
    return { ...m, pv, prices: bookPrices(matchChance(pv, m)), thin: isThin(pv) };
  });
  // The first event starts open; the rest are folded up.
  if (!S.loaded && S.matches.length) S.open.add(S.matches[0].tournament_id);
  S.loaded = true;
  render();
}

// Grouped by event, in the order the server sent them (soonest first).
function groups() {
  const out = new Map();
  for (const m of S.matches) {
    if (!out.has(m.tournament_id)) out.set(m.tournament_id, { id: m.tournament_id, name: m.tournament, starts: m.starts_at, list: [] });
    out.get(m.tournament_id).list.push(m);
  }
  return [...out.values()];
}

const title = m => `${m.name1} v ${m.name2}`;

function marketsFor(m) {
  if (!S.markets.has(m.id)) S.markets.set(m.id, matchMarkets(m.pv, m, m.figs ?? {}, [m.name1, m.name2]));
  return S.markets.get(m.id);
}

function pickBtn(sel, name, price, extra = '') {
  const on = accaHas(sel);
  return `<button class="odds-pick ob-pick${on ? ' on' : ''}${extra}" data-add='${esc(JSON.stringify(sel))}' aria-pressed="${on}">
    <span class="odds-name">${esc(name)}</span><b>${esc(price)}</b></button>`;
}

function matchCard(m) {
  const win = n => pickBtn({ match_id: m.id, market: 'win', pick: String(n), label: n === 1 ? m.name1 : m.name2, title: title(m), price: m.prices[n - 1] },
    n === 1 ? m.name1 : m.name2, m.prices[n - 1]);
  const open = S.more.has(m.id);
  const more = open ? marketsFor(m) : null;
  const picked = accaPicks().find(x => x.match_id === m.id);
  return `<div class="ob-match${picked ? ' ob-picked' : ''}" data-card="${m.id}">
    <div class="ob-top">
      <span class="ob-round">${esc(matchLabel(m, m.ko_rounds))}${m.thin ? '<sup class="odds-star">*</sup>' : ''}</span>
      <a class="ob-link" href="/match/?id=${m.id}">Match page ›</a>
    </div>
    <div class="odds-row">${win(1)}${win(2)}</div>
    <details class="ob-more" data-more="${m.id}"${open ? ' open' : ''}>
      <summary>More markets</summary>
      ${more ? (more.length ? more.map(mk => `<div class="ob-mk">
          <span class="ob-mk-title">${esc(mk.title)}</span>
          <div class="mk-picks${mk.multi ? ' mk-multi' : ''}">${mk.outcomes.map(o =>
            pickBtn({ match_id: m.id, market: mk.key, pick: o.pick, label: pickLabel(mk, o), title: legTitle(title(m), mk), price: o.price },
              o.label, o.price, ' small-pick mk-pick')).join('')}</div>
        </div>`).join('') : '<p class="muted small">No other markets for this match.</p>') : ''}
    </details>
  </div>`;
}

function groupMeta(g) {
  const inAcca = accaPicks().filter(x => g.list.some(m => m.id === x.match_id)).length;
  return `${esc(day(g.starts))} · ${g.list.length} match${g.list.length === 1 ? '' : 'es'}${inAcca ? ` · <b>${inAcca} in acca</b>` : ''}`;
}

// A tap only changes one match's buttons, its event's count and the acca
// bar, so only those are redrawn (a full redraw with every event open is
// slow on a phone).
function refreshPicks(matchId) {
  const card = app.querySelector(`[data-card="${matchId}"]`);
  if (!card) { render(); return; }
  for (const btn of card.querySelectorAll('[data-add]')) {
    let on = false;
    try { on = accaHas(JSON.parse(btn.dataset.add)); } catch { /* leave it */ }
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  card.classList.toggle('ob-picked', accaPicks().some(x => x.match_id === matchId));
  const g = groups().find(x => x.list.some(m => m.id === matchId));
  const meta = g && app.querySelector(`[data-group="${g.id}"] .ob-group-meta`);
  if (meta) meta.innerHTML = groupMeta(g);
  const bar = app.querySelector('.acca-bar');
  const html = accaBarHtml();
  if (bar) { if (html) bar.outerHTML = html; else bar.remove(); } else if (html) app.insertAdjacentHTML('beforeend', html);
}

function render() {
  if (S.error) { app.innerHTML = `<p class="error">${esc(S.error)}</p>`; return; }
  if (!S.loaded) { app.innerHTML = '<p class="muted">Loading…</p>'; return; }
  const gs = groups();
  const thin = S.matches.some(m => m.thin);
  app.innerHTML = `
    <div class="ob-head">
      <h1>Odds</h1>
      <p class="muted">One pick per match.</p>
    </div>
    ${gs.length ? gs.map(g => {
      return `<details class="ob-group" data-group="${g.id}"${S.open.has(g.id) ? ' open' : ''}>
        <summary>
          <span class="ob-group-name">${esc(g.name)}</span>
          <span class="ob-group-meta">${groupMeta(g)}</span>
        </summary>
        <div class="ob-list">${S.open.has(g.id) ? g.list.map(matchCard).join('') : ''}</div>
      </details>`;
    }).join('') : '<div class="card empty"><p>No matches to bet on right now.</p></div>'}
    ${thin ? '<p class="muted small odds-note">* Little data on a player, so these odds are rough</p>' : ''}
    ${accaBarHtml()}`;
}

// Opening and closing events and markets, kept across redraws.
app.addEventListener('toggle', e => {
  const g = e.target.closest?.('[data-group]');
  if (g && e.target === g) {
    const had = S.open.has(g.dataset.group);
    if (g.open && !had) { S.open.add(g.dataset.group); render(); }
    else if (!g.open && had) { S.open.delete(g.dataset.group); }
    return;
  }
  const d = e.target.closest?.('[data-more]');
  if (d && e.target === d) {
    const had = S.more.has(d.dataset.more);
    if (d.open && !had) { S.more.add(d.dataset.more); render(); }
    else if (!d.open && had) S.more.delete(d.dataset.more);
  }
}, true);

const ctx = { slip: () => null, set: () => {}, render: () => render(), changed: async () => {} };
app.addEventListener('input', e => { slipEvent(e, ctx); });
app.addEventListener('click', async e => {
  const b = e.target.closest('[data-add]');
  if (b) {
    let sel;
    try { sel = JSON.parse(b.dataset.add); } catch { return; }
    accaToggle(sel);
    refreshPicks(sel.match_id);
    return;
  }
  await slipEvent(e, ctx);
});

// Back on the page after a while: prices may have moved and matches started.
let last = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - last > 60000) { last = Date.now(); S.markets.clear(); load(); }
});

render();
load();
