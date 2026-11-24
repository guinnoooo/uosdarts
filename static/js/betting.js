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

const loginLink = () => `/account/?next=${encodeURIComponent(location.pathname + location.search)}`;

// The slip under a market. slip: { kind, match_id | tournament_id, side | player_id,
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
        <span class="slip-returns">Returns <b data-slip-ret>${fmtTokens(returnsFor(slip.stake, slip.price))}</b></span>
      </div>
      ${slip.note ? `<p class="small slip-note">${esc(slip.note)}</p>` : ''}
      <div class="row">
        <button class="primary" data-slip="place">${slip.note ? 'Place at the new price' : 'Place bet'}</button>
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

const STATUS = { open: 'Open', won: 'Won', lost: 'Lost', void: 'Refunded', cancelled: 'Cancelled' };
export const statusText = b => `${STATUS[b.status] ?? b.status}${b.status === 'won' ? ` +${fmtTokens(b.payout)}`
  : b.status === 'open' ? ` · to win ${fmtTokens(b.returns)}` : ''}`;
export const cancelButton = b => (b.can_cancel ? `<button class="link" data-cancelbet="${b.id}">Cancel</button>` : '');

export function myBetsHtml(list) {
  if (!list?.length) return '';
  const net = betsNet(list);
  const open = list.some(b => b.status === 'open');
  const result = net === null || open ? ''
    : `<p class="bets-net ${net >= 0 ? 'bet-won' : 'bet-lost'}">${net >= 0 ? `You won ${fmtTokens(net)}` : `You lost ${fmtTokens(-net)}`} tokens</p>`;
  return `<div class="my-bets"><h3>Your bets</h3>${result}<ul>${list.map(b => `<li>
      <span><b>${fmtTokens(b.stake)}</b> on ${esc(b.selection)} at ${esc(b.price)}</span>
      <span class="muted small">${statusText(b)}</span> ${cancelButton(b)}</li>`).join('')}</ul></div>`;
}

async function placeBet(slip) {
  const body = {
    kind: slip.kind, price: slip.price, stake: Number(slip.stake),
    ...(slip.kind === 'match' ? { match_id: slip.match_id, side: slip.side } : { tournament_id: slip.tournament_id, player_id: slip.player_id }),
  };
  const { data, error } = await sb.functions.invoke('place-bet', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* not JSON */ }
    if (/not found|failed to send/i.test(msg)) msg = 'Betting isn\'t switched on yet';
    throw new Error(msg);
  }
  return data;
}

// Asks the server for the price as soon as a slip opens. It wakes the
// betting server up (the first request after a quiet spell is the slow one)
// and catches a moved price before the person presses Place.
export async function quoteSlip(slip, ctx) {
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
    if (ret) ret.textContent = fmtTokens(returnsFor(s.stake, s.price));
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

  const stake = Math.floor(Number(s.stake));
  if (!(stake >= 10)) { toast('The smallest bet is 10 tokens'); return true; }
  btn.disabled = true;
  try {
    const r = await placeBet({ ...s, stake });
    if (r?.changed) {
      s.price = r.price;
      s.note = `Price moved to ${r.price}.`;
      ctx.render();
      return true;
    }
    toast(`Bet placed: ${fmtTokens(stake)} on ${s.selection} at ${s.price}. Returns ${fmtTokens(returnsFor(stake, s.price))}.`, false);
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
