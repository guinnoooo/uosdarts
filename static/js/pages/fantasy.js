// Fantasy darts: five starters, one bench player and a captain, within a
// budget. Points come from every PC and major in the week. All the rules
// are checked again in the database (fantasy_save).

import { sb, esc, toast } from '../db.js';
import { loadAccount } from '../betting.js';

const app = document.getElementById('app');
const S = { team: null, market: [], board: [], squad: [null, null, null, null, null, null], captain: null, name: '', q: '', view: null, open: null };

const money = n => Number(n ?? 0).toFixed(1);
const when = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const gwLabel = d => `w/c ${new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
const byId = id => S.market.find(p => p.id === id);

async function load() {
  const [acc, market, board, gws] = await Promise.all([loadAccount(), sb.rpc('fantasy_market'), sb.rpc('fantasy_leaderboard'), sb.rpc('fantasy_gws')]);
  S.market = market.data ?? [];
  S.curGw = (gws.data ?? []).filter(g => g.locks_at && new Date(g.locks_at) <= new Date()).map(g => g.gw).at(-1) ?? null;
  S.board = board.data ?? [];
  S.account = acc;
  if (acc) {
    const { data } = await sb.rpc('fantasy_my_team');
    S.team = data;
    S.name = data?.name ?? acc.display_name ?? '';
    const sq = data?.squad ?? [];
    S.squad = [1, 2, 3, 4, 5, 6].map(n => sq.find(x => x.slot === n)?.player_id ?? null);
    S.captain = sq.find(x => x.captain)?.player_id ?? null;
  }
}

const cost = () => S.squad.reduce((t, id) => t + Number(byId(id)?.price ?? 0), 0);
const changes = () => {
  if (!S.team || S.team.first_squad) return 0;
  const prev = new Set(S.team.previous ?? []);
  return S.squad.filter(id => id && !prev.has(id)).length;
};

function squadHtml() {
  const t = S.team;
  if (!S.account) return `<section class="panel"><h2>Your team</h2><p><a href="/account/?next=/fantasy/">Log in</a> to pick a team.</p></section>`;
  if (!t?.next_gw) return `<section class="panel"><h2>Your team</h2><p class="muted">No PC or major coming up to pick a team for.</p></section>`;
  const left = Number(t.budget) - cost();
  const ch = changes();
  const hit = Math.max(0, ch - 1) * t.hit;
  const slot = (id, i) => {
    const p = byId(id);
    const label = i === 5 ? 'Bench' : `Starter ${i + 1}`;
    if (!id) return `<li class="fx-slot empty"><span class="muted small">${label}</span><span class="muted">Pick from the list below</span></li>`;
    return `<li class="fx-slot">
      <span class="muted small">${label}</span>
      <span><b>${esc(p?.name ?? '?')}</b> <span class="muted">${money(p?.price)}</span></span>
      <span class="fx-slot-btns">
        ${i < 5 ? `<button class="fx-cap${S.captain === id ? ' on' : ''}" data-cap="${id}" title="Captain">C</button>` : ''}
        ${i < 5 && S.squad[5] ? `<button class="link" data-swap="${i}" title="Swap with the bench">⇅</button>` : ''}
        <button class="link" data-drop="${i}" title="Remove">✕</button>
      </span></li>`;
  };
  return `<section class="panel">
    <h2>Your team</h2>
    <label>Team name <input id="fx-name" maxlength="30" value="${esc(S.name)}"></label>
    <p class="small">Picking for ${gwLabel(t.next_gw)}. Locks ${when(t.locks_at)}.</p>
    <ol class="fx-squad">${S.squad.map(slot).join('')}</ol>
    <p class="small"><b class="${left < 0 ? 'error' : ''}">${money(left)}</b> left of ${money(t.budget)}
      ${t.first_squad ? '' : ` · ${ch} change${ch === 1 ? '' : 's'}${hit ? `, <span class="error">−${hit} points</span>` : ' (1 free)'}`}</p>
    <button class="primary" data-act="save">Save team</button>
  </section>`;
}

function marketHtml() {
  const q = S.q.toLowerCase();
  const list = q ? S.market.filter(p => p.name.toLowerCase().includes(q)) : S.market;
  const inSquad = new Set(S.squad.filter(Boolean));
  const full = S.squad.every(Boolean);
  return `<section class="panel">
    <h2>Players</h2>
    <input id="fx-q" placeholder="Search players" value="${esc(S.q)}" autocomplete="off">
    ${S.market.length ? `<table class="lb-table fx-market"><thead><tr><th class="l">Player</th><th>Price</th><th>Last</th><th>Season</th><th></th></tr></thead>
    <tbody>${list.map(p => `<tr>
      <td class="l">${esc(p.name)}</td><td>${money(p.price)}</td><td>${p.last}</td><td>${p.season}</td>
      <td>${S.account && S.team?.next_gw ? (inSquad.has(p.id) ? '<span class="muted small">In</span>'
        : `<button class="small-pick odds-pick" data-add="${p.id}"${full ? ' disabled' : ''}>Add</button>`) : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted">Prices aren\'t set yet.</p>'}
  </section>`;
}

function historyHtml() {
  const h = S.team?.history ?? [];
  if (!h.length) return '';
  return `<section class="panel"><h2>Your weeks</h2>${h.map(teamWeekHtml).join('')}</section>`;
}

function teamWeekHtml(w) {
  const det = d => d ? Object.entries(d).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') : '';
  return `<details class="fx-week"><summary><b>${gwLabel(w.gw)}</b> · ${w.total} points${w.hits ? ` (−${w.hits} for changes)` : ''}</summary>
    <ul>${w.starters.map(s => `<li>${esc(s.name)}${s.captain ? ' (C)' : ''}: <b>${s.points}</b>
      <span class="muted small">${s.played ? esc(det(s.detail)) : 'didn\'t play'}</span></li>`).join('')}
      ${w.bench_name ? `<li class="muted">Bench: ${esc(w.bench_name)}, ${w.bench_points}${w.bench_came_on ? ' (came on)' : ' (didn\'t count)'}</li>` : ''}</ul>
  </details>`;
}

function boardHtml() {
  return `<section class="panel">
    <h2>Leaderboard</h2>
    ${S.board.length ? `<table class="lb-table"><thead><tr><th></th><th class="l">Team</th><th>Week</th><th>Total</th></tr></thead>
      <tbody>${S.board.map((r, i) => `<tr class="${r.me ? 'me' : ''}">
        <td class="muted">${i + 1}</td>
        <td class="l"><button class="link" data-view="${r.user_id}">${esc(r.name)}</button><span class="muted small lb-play">${esc(r.manager)}</span></td>
        <td>${r.week ?? ''}</td><td><b>${r.total}</b></td></tr>
        ${S.open === r.user_id && S.view ? `<tr><td colspan="4">${teamWeekHtml(S.view)}</td></tr>` : ''}`).join('')}</tbody></table>`
      : '<p class="muted">No teams yet.</p>'}
  </section>`;
}

const RULES = `<section class="panel"><h2>How it works</h2><ul class="small fx-rules">
  <li>Pick five starters and one bench player within the budget, and a captain whose points count double.</li>
  <li>Every PC and major in a week counts. Your team locks when the week's first one starts.</li>
  <li>If a starter doesn't play that week, your bench player's points count instead.</li>
  <li>One free change a week. Each extra change costs 4 points.</li>
  <li>Points per match: 2 for a win, 1 per leg won, 3 per 180, 5 per 100+ checkout, 1 for a 50+ average (2 for 60+). Winning an event is worth 10, runner-up 5.</li>
  <li>Prices move a little each week with form.</li></ul></section>`;

function render() {
  app.innerHTML = `${squadHtml()}${historyHtml()}${boardHtml()}${marketHtml()}${RULES}`;
}

app.addEventListener('input', e => {
  if (e.target.id === 'fx-name') { S.name = e.target.value; return; }
  if (e.target.id === 'fx-q') {
    S.q = e.target.value;
    render();
    const box = app.querySelector('#fx-q');
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
});

app.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.add) {
    const i = S.squad.indexOf(null);
    if (i < 0) { toast('Your squad is full. Remove someone first.'); return; }
    S.squad[i] = b.dataset.add;
    if (!S.captain && i < 5) S.captain = b.dataset.add;
    render();
    return;
  }
  if (b.dataset.drop) {
    const i = Number(b.dataset.drop);
    if (S.squad[i] === S.captain) S.captain = null;
    S.squad[i] = null;
    render();
    return;
  }
  if (b.dataset.swap) {
    const i = Number(b.dataset.swap);
    [S.squad[i], S.squad[5]] = [S.squad[5], S.squad[i]];
    if (S.squad[5] === S.captain) S.captain = S.squad[i];
    render();
    return;
  }
  if (b.dataset.cap) { S.captain = b.dataset.cap; render(); return; }
  if (b.dataset.view) {
    const u = b.dataset.view;
    if (S.open === u) { S.open = null; S.view = null; render(); return; }
    const gw = S.curGw;
    if (!gw) { toast('Teams are shown once the first week starts'); return; }
    const { data, error } = await sb.rpc('fantasy_team_view', { p_user: u, p_gw: gw });
    if (error) { toast(error.message); return; }
    S.open = u; S.view = data;
    render();
    return;
  }
  if (b.dataset.act === 'save') {
    if (S.squad.some(x => !x)) { toast('Pick five starters and a bench player'); return; }
    if (!S.captain) { toast('Pick a captain (C) from your starters'); return; }
    const ch = changes();
    if (ch > 1 && !confirm(`That's ${ch} changes. Each one after the first costs ${S.team.hit} points. Save anyway?`)) return;
    b.disabled = true;
    const { data, error } = await sb.rpc('fantasy_save', { p_name: S.name, p_players: S.squad, p_captain: S.captain });
    b.disabled = false;
    if (error) { toast(error.message); return; }
    toast(`Team saved for ${gwLabel(data.gw)}`, false);
    await load();
    render();
  }
});

load().then(render, err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
