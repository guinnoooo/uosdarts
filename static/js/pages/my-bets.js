// My Bets: your token balance and every bet you've placed, open first,
// then settled, with cancelled ones folded away. Part of GuinnessBet.

import { sb, esc, toast } from '../db.js';
import { loadAccount, fmtTokens, betCard, cashOut } from '../betting.js';

const app = document.getElementById('app');

const when = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function balanceHtml(a) {
  return `<section class="panel account-box">
    <h2>${esc(a.display_name)}</h2>
    ${a.banned ? '<p class="error">Blocked from chat and betting.</p>' : ''}
    <div class="token-row">
      <div><span class="muted small">Tokens</span><b>${fmtTokens(a.tokens)}</b></div>
      <div><span class="muted small">In open bets</span><b>${fmtTokens(a.in_play)}</b></div>
    </div>
    <p class="muted small">+250 on ${when(a.next_topup)}</p>
  </section>`;
}

function betsHtml(bets) {
  if (!bets.length) return '<section class="panel"><h2>Your bets</h2><p class="muted">No bets yet. Have a look at <a href="/odds/">Odds</a> or <a href="/futures/">Futures</a>.</p></section>';
  const open = bets.filter(b => b.status === 'open');
  const settled = bets.filter(b => ['won', 'lost', 'void', 'cashed_out'].includes(b.status));
  const cancelled = bets.filter(b => b.status === 'cancelled');
  const cards = list => `<div class="betcards">${list.map(b => betCard(b)).join('')}</div>`;
  const net = settled.reduce((t, b) => t + Number(b.payout ?? 0) - (b.status === 'void' ? 0 : Number(b.stake)), 0);
  return `<section class="panel"><h2>Your bets</h2>
    <h3 class="bets-head">Open <span class="muted">${open.length}</span></h3>
    ${open.length ? cards(open) : '<p class="muted small">Nothing open right now.</p>'}
    ${settled.length ? `<details class="bets-group" open><summary><h3 class="bets-head">Settled <span class="muted">${settled.length}</span>
      <span class="small ${net >= 0 ? 'bet-won' : 'bet-lost'}">${net >= 0 ? '+' : '−'}${fmtTokens(Math.abs(net))}</span></h3></summary>${cards(settled)}</details>` : ''}
    ${cancelled.length ? `<details class="bets-group"><summary><h3 class="bets-head">Cancelled <span class="muted">${cancelled.length}</span></h3></summary>${cards(cancelled)}</details>` : ''}
  </section>`;
}

async function render() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) {
    app.innerHTML = `<section class="panel account-box">
      <h2>My Bets</h2>
      <p><a href="/account/?next=/my-bets/">Log in</a> to see your tokens and bets.</p>
    </section>`;
    return;
  }
  const a = await loadAccount(true);
  if (!a) {
    app.innerHTML = '<section class="panel account-box"><h2>My Bets</h2><p class="muted">Confirm your email first. The link is in your inbox.</p></section>';
    return;
  }
  if (a.can_bet === false) {
    app.innerHTML = '<section class="panel account-box"><h2>My Bets</h2><p class="muted">Admin accounts can\'t bet.</p></section>';
    return;
  }
  const bets = (await sb.rpc('my_bets', { p_limit: 100 })).data ?? [];
  app.innerHTML = balanceHtml(a) + betsHtml(bets);
}

app.addEventListener('click', async e => {
  const co = e.target.closest('[data-cashout]');
  if (co) { if (await cashOut(co)) render(); return; }
  const c = e.target.closest('[data-cancelbet]');
  if (c) {
    if (!confirm('Cancel this bet?')) return;
    c.disabled = true;
    const { error } = await sb.rpc('cancel_bet', { p_bet: Number(c.dataset.cancelbet) });
    if (error) { toast(error.message); c.disabled = false; return; }
    toast('Bet cancelled', false);
    render();
  }
});

render().catch(err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
