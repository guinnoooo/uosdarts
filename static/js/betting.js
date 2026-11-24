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
    body = `<p class="small"><a href="${loginLink()}">Log in or sign up</a> to bet with tokens. Everyone starts with 10,000.</p>`;
  } else if (a.banned) {
    body = '<p class="small">Your account can\'t place bets.</p>';
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

// Handles clicks and typing inside a slip. Returns true if the event was a
// slip's. ctx: { slip: () => current slip, set: s => store it, render: () => redraw }.
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
      s.note = `The price has moved to ${r.price}.`;
      ctx.render();
      return true;
    }
    toast(`Bet placed: ${fmtTokens(stake)} on ${s.selection} at ${s.price}. Returns ${fmtTokens(returnsFor(stake, s.price))}.`, false);
    ctx.set(null);
    await loadAccount(true);
    ctx.render();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
  return true;
}
