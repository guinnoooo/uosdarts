// Token betting: the signed-in account and the bet slip, shared by the match
// and tournament pages.
//
// Bets go through the place-bet edge function, which prices them again on the
// server with the same model. The page sends the price it showed; if the
// server's price is different nothing is placed and the slip shows the new
// price to accept.

import { sb, esc, toast } from './db.js';

let ACCOUNT;   // undefined: not loaded yet; null: no account

// The signed-in user's account (tokens, name), or null if they haven't got one.
export async function loadAccount(force = false) {
  if (ACCOUNT !== undefined && !force) return ACCOUNT;
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) { ACCOUNT = null; return null; }
  const { data, error } = await sb.rpc('my_account');
  ACCOUNT = error ? null : data ?? null;
  return ACCOUNT;
}
export const account = () => ACCOUNT;

export const fmtTokens = n => Number(n ?? 0).toLocaleString('en-GB');
const ladderValue = f => (f === 'Evens' ? 1 : f.split('/').reduce((a, b) => a / b));
export const returnsFor = (stake, price) => Math.floor((Number(stake) || 0) * (ladderValue(price) + 1));
// Decimal odds of a price on the ladder (6/4 -> 2.5), and of several multiplied (an acca).
const decimalOf = f => Math.round((ladderValue(f) + 1) * 10000) / 10000;
const accaDecimal = sels => Math.round(sels.reduce((t, x) => t * decimalOf(x.price), 1) * 10000) / 10000;
// An acca's odds as a fraction, rounded down (never up) to one that reads
// cleanly: X/1, X/2, X/3 or X/5 under 5/1, X/1 or X/2 up to 10/1, whole
// numbers above that, 1/X under 1/5. The database rounds the same way
// (nice_fraction in migration 085), so the slip shows what the bet pays.
export function niceFraction(dec) {
  const f = dec - 1;
  let num = 0, den = 1, best = -1;
  for (const b of [1, 2, 3, 5]) {
    if ((f >= 10 && b > 1) || (f >= 5 && b > 2)) continue;
    const a = Math.floor(f * b + 1e-7);
    if (a / b > best + 1e-9) { best = a / b; num = a; den = b; }
  }
  if (num === 0 && f > 0) { num = 1; den = Math.ceil(1 / f - 1e-7); }
  return { num, den, text: num === den ? 'Evens' : `${num}/${den}`, decimal: Math.round((1 + num / den) * 10000) / 10000 };
}
const accaOdds = sels => (sels.length > 1 ? niceFraction(accaDecimal(sels)) : { text: sels[0]?.price ?? '', decimal: accaDecimal(sels) });
const slipReturns = s => (s.kind === 'sels' ? Math.floor((Number(s.stake) || 0) * accaOdds(s.sels).decimal) : returnsFor(s.stake, s.price));

const loginLink = () => `/account/?next=${encodeURIComponent(location.pathname + location.search)}`;

// The slip under a market. slip: { kind, match_id | tournament_id | future_id, side | player_id,
// selection, price, stake, note }.
export function slipHtml(slip) {
  if (!slip) return '';
  const a = ACCOUNT;
  let body;
  if (a === undefined) body = '<p class="muted small">Loading…</p>';
  else if (!a) {
    body = `<p class="small"><a href="${loginLink()}">Log in</a> to bet.</p>`;
  } else if (a.banned) {
    body = '<p class="small">Blocked from betting.</p>';
  } else if (a.can_bet === false) {
    body = '<p class="small">Admins can\'t bet.</p>';
  } else {
    body = `<div class="slip-row">
        <label>Stake <input type="number" inputmode="numeric" min="10" step="10" data-slip-stake value="${esc(slip.stake ?? '')}" placeholder="Tokens"></label>
        <span class="slip-returns">Returns <b data-slip-ret>${fmtTokens(slipReturns(slip))}</b></span>
      </div>
      ${slip.note ? `<p class="small slip-note">${esc(slip.note)}</p>` : ''}
      <div class="row">
        <button class="primary" data-slip="place">${slip.note ? 'Place at the new price' : 'Place bet'}</button>
        ${slip.accaable ? `<button data-slip="acca">${accaHas(slip.sels[0]) ? 'In your acca' : 'Add to acca'}</button>` : ''}
        <button data-slip="cancel">Cancel</button>
        <span class="muted small">You have ${fmtTokens(a.tokens)} tokens</span>
      </div>`;
  }
  return `<div class="slip">
    <p class="slip-head">Backing <b>${esc(slip.selection)}</b> at <b>${esc(slip.price)}</b></p>
    ${body}
  </div>`;
}

// The signed-in user's bets on one match (or one tournament's outright).
export async function myBetsOn({ matchId = null, tournamentId = null }) {
  if (!ACCOUNT) return [];
  const { data, error } = await sb.rpc('my_bets_on', { p_match: matchId, p_tournament: tournamentId });
  return error ? [] : data ?? [];
}

const STATUS = { open: 'Open', won: 'Won', lost: 'Lost', void: 'Bet void', cancelled: 'Cancelled', cashed_out: 'Cashed out' };
const hhmm = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
export const statusText = b => `${STATUS[b.status] ?? b.status}${b.status === 'won' || b.status === 'cashed_out' ? ` +${fmtTokens(b.payout)}`
  : b.status === 'open' ? ` · to win ${fmtTokens(b.returns)}` : ''}`;
// Futures: free to cancel for 12 hours, then cash out at the current price less a fee.
export const cancelButton = b => (b.can_cancel
  ? `<button class="link" data-cancelbet="${b.id}">Cancel${b.free_cancel_until ? ` (till ${hhmm(b.free_cancel_until)})` : ''}</button>`
  : b.cash_out != null ? `<button class="link cash-out" data-cashout="${b.id}" data-value="${b.cash_out}">Cash out ${fmtTokens(b.cash_out)}</button>` : '');

// Cash out a futures bet at the value shown. If the price has moved, the
// new value is offered instead. Returns true once it's done.
export async function cashOut(btn) {
  let value = Number(btn.dataset.value);
  if (!confirm(`Cash out for ${fmtTokens(value)} tokens?`)) return false;
  btn.disabled = true;
  for (let tries = 0; tries < 2; tries++) {
    const { data, error } = await sb.rpc('cash_out_bet', { p_bet: Number(btn.dataset.cashout), p_value: value });
    if (error) { toast(error.message); btn.disabled = false; return false; }
    if (!data?.changed) {
      if (ACCOUNT && data?.tokens != null) ACCOUNT.tokens = data.tokens;
      toast(`Cashed out for ${fmtTokens(data.value)} tokens`, false);
      return true;
    }
    value = Number(data.value);
    if (!confirm(`Price moved. Cash out for ${fmtTokens(value)}?`)) { btn.disabled = false; return true; }
  }
  btn.disabled = false;
  return false;
}

// One bet as a ticket. Built to look good in a screenshot: what was backed,
// the odds, the stake and the return, the result, and the site's name.
const dayTime = d => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const LEG_MARK = { won: '✓', lost: '✕', void: '–', open: '·' };
export function betCard(b, { context = null } = {}) {
  const st = b.status;
  const badge = STATUS[st] ?? st;
  const [label, value] = st === 'won' ? ['Paid', b.payout]
    : st === 'cashed_out' ? ['Cashed out', b.payout]
    : st === 'void' || st === 'cancelled' ? ['Returned', b.stake]
    : st === 'lost' ? ['Returns', 0]
    : ['To return', b.returns];
  const ctx = b.kind === 'acca' ? 'GuinnessBet acca' : context ?? ([b.market, b.tournament && !String(b.market ?? '').includes(b.tournament) ? b.tournament : null].filter(Boolean).join(' · ')
    || document.title.split(' · ')[0].trim());
  const shareable = b.status === 'won' || b.status === 'cashed_out';
  const shareData = shareable ? esc(JSON.stringify({ selection: b.kind === 'acca' ? `${b.legs?.length ?? ''}-fold acca` : b.selection,
    market: b.kind === 'acca' ? null : ctx, price: b.price, stake: b.stake, paid: b.payout, cashedOut: b.status === 'cashed_out', legs: b.kind === 'acca' ? (b.legs ?? []).map(l => ({ label: l.label, title: l.title, price: l.price })) : null })) : '';
  const actions = [cancelButton(b), shareable ? `<button class="link" data-sharebet="${shareData}">Share</button>` : ''].filter(Boolean).join(' ');
  return `<article class="betcard betcard-${esc(st)}">
    <header class="betcard-top">
      <span class="betcard-ctx">${esc(ctx || 'Bet')}</span>
      <span class="betcard-badge">${esc(badge)}</span>
    </header>
    ${b.kind === 'acca' && b.legs?.length
      ? `<div class="betcard-sel"><span>${b.legs.length}-fold acca</span><span class="betcard-odds">${esc(b.price)}</span></div>
         <ul class="betcard-legs">${b.legs.map(l => `<li class="leg-${esc(l.status)}"><span class="leg-mark" aria-hidden="true">${LEG_MARK[l.status] ?? ''}</span>
           <span><b>${esc(l.label)}</b><small>${esc(l.title)}</small></span><span class="leg-price">${esc(l.price)}</span></li>`).join('')}</ul>`
      : `<div class="betcard-sel"><span>${esc(b.selection)}</span><span class="betcard-odds">${esc(b.price)}</span></div>`}
    <div class="betcard-nums">
      <div><span>Stake</span><b>${fmtTokens(b.stake)}</b></div>
      <div><span>${label}</span><b>${fmtTokens(value)}</b></div>
    </div>
    <footer class="betcard-foot"><span>${b.placed_at ? dayTime(b.placed_at) : ''}</span><span class="betcard-brand">uosdarts.com</span></footer>
    ${actions ? `<div class="betcard-actions">${actions}</div>` : ''}
  </article>`;
}

// A Share button on a winning bet card makes a picture of it.
document.addEventListener('click', async e => {
  const btn = e.target.closest?.('[data-sharebet]');
  if (!btn) return;
  e.preventDefault();
  let b; try { b = JSON.parse(btn.dataset.sharebet); } catch { return; }
  const { betWinCard, share } = await import('./share-card.js');
  await share(await betWinCard(b), { filename: 'guinnessbet-win.png', title: 'GuinnessBet', text: `${b.selection} at ${b.price}`, url: 'https://uosdarts.com/odds/' });
});

export function myBetsHtml(list) {
  if (!list?.length) return '';
  const net = betsNet(list);
  const open = list.some(b => b.status === 'open');
  const result = net === null || open ? ''
    : `<p class="bets-net ${net >= 0 ? 'bet-won' : 'bet-lost'}">${net >= 0 ? `You won ${fmtTokens(net)}` : `You lost ${fmtTokens(-net)}`} tokens</p>`;
  return `<div class="my-bets"><h3>Your bets</h3>${result}<div class="betcards">${list.map(b => betCard(b)).join('')}</div></div>`;
}

async function placeBet(slip) {
  // Futures are priced by hand, so the database checks the price itself.
  if (slip.kind === 'future') {
    const { data, error } = await sb.rpc('place_future_bet', { p_selection: slip.future_id, p_price: slip.price, p_stake: Number(slip.stake) });
    if (error) throw new Error(error.message);
    return data;
  }
  if (slip.kind === 'sels') return invoke(selsBody(slip.sels, { stake: Number(slip.stake) }));
  const body = {
    kind: slip.kind, price: slip.price, stake: Number(slip.stake),
    ...(slip.kind === 'match' ? { match_id: slip.match_id, side: slip.side } : { tournament_id: slip.tournament_id, player_id: slip.player_id }),
  };
  return invoke(body);
}

async function invoke(body) {
  const { data, error } = await sb.functions.invoke('place-bet', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* not JSON */ }
    if (/failed to send/i.test(msg)) msg = 'Betting isn\'t switched on yet';
    throw new Error(msg);
  }
  return data;
}

const selsBody = (sels, extra) => ({
  kind: 'sels', sels: sels.map(x => ({ match_id: x.match_id, market: x.market, pick: x.pick })),
  prices: sels.map(x => x.price), ...extra,
});

// New prices from the server, onto the picks they belong to. Returns a note
// if any moved.
function applyPrices(sels, prices) {
  const moved = sels.filter((x, i) => prices?.[i] && prices[i] !== x.price);
  sels.forEach((x, i) => { if (prices?.[i]) x.price = prices[i]; });
  return moved.length ? `Price${moved.length > 1 ? 's' : ''} moved: ${moved.map(x => `${x.label} now ${x.price}`).join(', ')}.` : null;
}

// Asks the server for the price as soon as a slip opens. It wakes the
// betting server up (the first request after a quiet spell is the slow one)
// and catches a moved price before the person presses Place.
export async function quoteSlip(slip, ctx) {
  if (slip.kind === 'future') return;
  if (slip.kind === 'sels') {
    try {
      const data = await invoke(selsBody(slip.sels, { quote: true }));
      if (ctx.slip() !== slip) return;
      const note = applyPrices(slip.sels, data?.prices);
      if (note) { slip.price = slip.sels[0].price; slip.note = note; ctx.render(); }
    } catch { /* the bet itself will check again */ }
    return;
  }
  const body = { kind: slip.kind, quote: true,
    ...(slip.kind === 'match' ? { match_id: slip.match_id, side: slip.side } : { tournament_id: slip.tournament_id, player_id: slip.player_id }) };
  try {
    const { data } = await sb.functions.invoke('place-bet', { body });
    if (data?.price && ctx.slip() === slip && data.price !== slip.price) {
      slip.price = data.price;
      slip.note = `Price moved to ${data.price}.`;
      ctx.render();
    }
  } catch { /* the bet itself will check again */ }
}

// The result of someone's bets on a finished match: tokens back minus staked.
export function betsNet(list) {
  const settled = (list ?? []).filter(b => b.status === 'won' || b.status === 'lost');
  if (!settled.length) return null;
  return settled.reduce((t, b) => t + Number(b.payout) - Number(b.stake), 0);
}

// Handles clicks and typing inside a slip, and Cancel on a bet. Returns true
// if the event was one of those. ctx: { slip: () => current slip,
// set: s => store it, render: () => redraw, changed: async () => after a bet
// is placed or cancelled }.
export async function slipEvent(e, ctx) {
  const stakeBox = e.target.closest?.('[data-slip-stake]');
  if (stakeBox && e.type === 'input') {
    const s = ctx.slip();
    if (!s) return true;
    s.stake = stakeBox.value;
    const ret = stakeBox.closest('.slip')?.querySelector('[data-slip-ret]');
    if (ret) ret.textContent = fmtTokens(slipReturns(s));
    return true;
  }
  if (await accaEvent(e, ctx)) return true;
  const co = e.target.closest?.('[data-cashout]');
  if (co && e.type === 'click') {
    if (await cashOut(co)) { await Promise.all([loadAccount(true), ctx.changed?.()]); ctx.render(); }
    return true;
  }
  const cancel = e.target.closest?.('[data-cancelbet]');
  if (cancel && e.type === 'click') {
    if (!confirm('Cancel this bet?')) return true;
    cancel.disabled = true;
    const { error } = await sb.rpc('cancel_bet', { p_bet: Number(cancel.dataset.cancelbet) });
    if (error) { toast(error.message); cancel.disabled = false; return true; }
    toast('Bet cancelled', false);
    await Promise.all([loadAccount(true), ctx.changed?.()]);
    ctx.render();
    return true;
  }
  const btn = e.target.closest?.('[data-slip]');
  if (!btn || e.type !== 'click') return false;
  const s = ctx.slip();
  if (btn.dataset.slip === 'cancel' || !s) { ctx.set(null); ctx.render(); return true; }
  if (btn.dataset.slip === 'acca') {
    if (s.sels?.[0]) { accaAdd(s.sels[0]); toast(`Added to your acca (${ACCA.length} pick${ACCA.length === 1 ? '' : 's'})`, false); }
    ctx.set(null); ctx.render();
    return true;
  }

  const stake = Math.floor(Number(s.stake));
  if (!(stake >= 10)) { toast('The smallest bet is 10 tokens'); return true; }
  btn.disabled = true;
  try {
    const r = await placeBet({ ...s, stake });
    if (r?.changed && s.kind === 'sels') {
      s.note = applyPrices(s.sels, r.prices) ?? 'Prices moved.';
      s.price = s.sels[0].price;
      ctx.render();
      return true;
    }
    if (r?.changed) {
      if (!r.price) { toast('That price has been taken off'); ctx.set(null); ctx.render(); await ctx.changed?.(); ctx.render(); return true; }
      s.price = r.price;
      s.note = `Price moved to ${r.price}.`;
      ctx.render();
      return true;
    }
    toast(`Bet placed: ${fmtTokens(stake)} on ${s.selection} at ${s.price}. Returns ${fmtTokens(slipReturns({ ...s, stake }))}.`, false);
    ctx.set(null);
    // The reply carries the new balance, so only the bet list needs fetching.
    if (ACCOUNT && r?.tokens != null) ACCOUNT.tokens = r.tokens;
    ctx.render();
    await ctx.changed?.();
    ctx.render();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
  return true;
}

// ---------------------------------------------------------------- accas
//
// Picks from different matches (match markets only, no futures), kept in
// this browser until placed, so they can be collected across match pages.
// One pick per match: adding another from the same match replaces it.
// Each pick: { match_id, market, pick, label, title, price }.

const ACCA_KEY = 'uosdarts:acca';
let ACCA = (() => {
  try { const v = JSON.parse(localStorage.getItem(ACCA_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
})();
let ACCA_UI = { open: false, stake: 100, note: null, busy: false };
const saveAcca = () => { try { localStorage.setItem(ACCA_KEY, JSON.stringify(ACCA)); } catch { /* private mode */ } };

export const accaPicks = () => ACCA;
export const accaHas = sel => !!sel && ACCA.some(x => x.match_id === sel.match_id && x.market === sel.market && x.pick === sel.pick);
export function accaAdd(sel) {
  ACCA = [...ACCA.filter(x => x.match_id !== sel.match_id), { ...sel }];
  ACCA_UI.note = null;
  saveAcca();
}
// Tapping a price on the Odds page: in the acca if it wasn't, out if it was.
export function accaToggle(sel) {
  if (accaHas(sel)) ACCA = ACCA.filter(x => !(x.match_id === sel.match_id && x.market === sel.market && x.pick === sel.pick));
  else ACCA = [...ACCA.filter(x => x.match_id !== sel.match_id), { ...sel }];
  ACCA_UI.note = null;
  saveAcca();
}
function accaRemove(i) { ACCA = ACCA.filter((_, j) => j !== i); saveAcca(); }

// The bar along the bottom of the page, and the acca slip when it's opened.
export function accaBarHtml() {
  if (!ACCA.length) return '';
  const odds = accaOdds(ACCA);
  const dec = odds.decimal;
  const a = ACCOUNT;
  if (!ACCA_UI.open) {
    return `<div class="acca-bar"><button class="acca-open" data-acca="open">
      <span>Acca · ${ACCA.length} pick${ACCA.length === 1 ? '' : 's'}</span><b>${esc(odds.text)}</b></button></div>`;
  }
  const can = a && !a.banned && a.can_bet !== false;
  return `<div class="acca-bar acca-bar-open">
    <div class="acca-panel">
      <div class="acca-head"><h3>Your acca</h3><button class="link" data-acca="close">Hide</button></div>
      <ul class="acca-list">${ACCA.map((x, i) => `<li>
        <div><b>${esc(x.label)}</b><span class="muted small">${esc(x.title)}</span></div>
        <span class="acca-price">${esc(x.price)}</span>
        <button class="link" data-acca="remove" data-i="${i}" aria-label="Remove">✕</button></li>`).join('')}</ul>
      <p class="acca-total">Odds <b>${esc(odds.text)}</b> <span class="muted small">(every pick has to win)</span></p>
      ${ACCA_UI.note ? `<p class="small slip-note">${esc(ACCA_UI.note)}</p>` : ''}
      ${ACCA.length < 2 ? '<p class="muted small">Add a pick from another match to make an acca.</p>'
        : !a ? `<p class="small"><a href="${loginLink()}">Log in</a> to bet.</p>`
        : !can ? '<p class="small">This account can\'t bet.</p>'
        : `<div class="slip-row">
            <label>Stake <input type="number" inputmode="numeric" min="10" step="10" data-acca-stake value="${esc(ACCA_UI.stake ?? '')}" placeholder="Tokens"></label>
            <span class="slip-returns">Returns <b data-acca-ret>${fmtTokens(Math.floor((Number(ACCA_UI.stake) || 0) * dec))}</b></span>
          </div>
          <div class="row">
            <button class="primary" data-acca="place" ${ACCA_UI.busy ? 'disabled' : ''}>${ACCA_UI.note ? 'Place at the new prices' : 'Place acca'}</button>
            <button data-acca="clear">Clear</button>
            <span class="muted small">You have ${fmtTokens(a.tokens)} tokens</span>
          </div>`}
    </div></div>`;
}

async function accaEvent(e, ctx) {
  const box = e.target.closest?.('[data-acca-stake]');
  if (box && e.type === 'input') {
    ACCA_UI.stake = box.value;
    const ret = document.querySelector('[data-acca-ret]');
    if (ret) ret.textContent = fmtTokens(Math.floor((Number(box.value) || 0) * accaOdds(ACCA).decimal));
    return true;
  }
  const btn = e.target.closest?.('[data-acca]');
  if (!btn || e.type !== 'click') return false;
  const act = btn.dataset.acca;
  if (act === 'open') {
    ACCA_UI.open = true;
    ctx.render();
    loadAccount().then(ctx.render, ctx.render);
    // Fresh prices as it opens, so a stale pick shows up before Place.
    if (ACCA.length) invoke(selsBody(ACCA, { quote: true })).then(d => {
      const note = applyPrices(ACCA, d?.prices);
      if (note) { ACCA_UI.note = note; saveAcca(); ctx.render(); }
    }, err => { ACCA_UI.note = err.message; ctx.render(); });
  } else if (act === 'close') {
    ACCA_UI.open = false; ctx.render();
  } else if (act === 'remove') {
    accaRemove(Number(btn.dataset.i)); ACCA_UI.note = null; ctx.render();
  } else if (act === 'clear') {
    if (confirm('Clear your acca?')) { ACCA = []; saveAcca(); ACCA_UI = { open: false, stake: ACCA_UI.stake, note: null, busy: false }; ctx.render(); }
  } else if (act === 'place') {
    const stake = Math.floor(Number(ACCA_UI.stake));
    if (!(stake >= 10)) { toast('The smallest bet is 10 tokens'); return true; }
    ACCA_UI.busy = true; ctx.render();
    try {
      const r = await invoke(selsBody(ACCA, { stake }));
      if (r?.changed) {
        ACCA_UI.note = applyPrices(ACCA, r.prices) ?? 'Prices moved.';
        saveAcca();
      } else {
        const o = accaOdds(ACCA);
        toast(`Acca placed: ${fmtTokens(stake)} at ${r.price ?? o.text}. Returns ${fmtTokens(Math.floor(stake * Number(r.decimal ?? o.decimal)))}.`, false);
        if (ACCOUNT && r?.tokens != null) ACCOUNT.tokens = r.tokens;
        ACCA = []; saveAcca();
        ACCA_UI = { open: false, stake, note: null, busy: false };
        await ctx.changed?.();
      }
    } catch (err) { toast(err.message); }
    ACCA_UI.busy = false;
    ctx.render();
  }
  return true;
}
