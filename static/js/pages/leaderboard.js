// The gambling leaderboard: everyone's tokens, counting what's riding on
// open bets, from the GuinnessBet token betting.

import { sb, esc } from '../db.js';
import { fmtTokens } from '../betting.js';

const app = document.getElementById('app');

async function render() {
  const { data, error } = await sb.rpc('leaderboard');
  if (error) { app.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
  const rows = data ?? [];
  const me = rows.find(r => r.me);
  app.innerHTML = `<section class="panel">
    <h2>Leaderboard</h2>
    ${me ? '' : '<p class="muted small"><a href="/account/?next=/leaderboard/">Sign up</a> to join in.</p>'}
    ${rows.length ? `<table class="lb-table">
      <thead><tr><th></th><th class="l">Name</th><th>Tokens</th><th>Bets</th><th>Won</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.me ? 'me' : ''}">
        <td class="muted">${i + 1}</td>
        <td class="l">${esc(r.name)}</td>
        <td><b>${fmtTokens(r.total)}</b>${r.in_play ? `<span class="muted small lb-play">${fmtTokens(r.in_play)} in play</span>` : ''}</td>
        <td>${r.placed}</td>
        <td>${r.won}</td>
      </tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nobody yet.</p>'}
  </section>`;
}

render().catch(err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
