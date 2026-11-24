// Super admin: players, points and who the admins are.
// Everything here is guarded in the database as well, so a plain admin who
// finds this page can read it but cannot change anything.

import { sb, showLoadError, esc, toast, toLoginEmail, toUsername } from '../db.js';

const app = document.getElementById('app');
const SEASON = '2026/27';

const S = {
  role: null, players: [], admins: [], sel: null, points: [], usage: null,
  filter: '', mergeInto: '', friendlies: [], showReviewed: false,
};

const check = r => { if (r.error) throw r.error; return r.data; };

// ---------------------------------------------------------------- data

async function loadInner() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) {
    app.innerHTML = `<div class="panel narrow center">
      <h2>Super admin</h2>
      <p class="muted">Sign in on the <a href="/admin/">admin page</a> first.</p>
    </div>`;
    return;
  }

  S.role = check(await sb.rpc('my_admin_role'));
  if (S.role !== 'super') {
    app.innerHTML = `<div class="panel narrow center">
      <h2>Super admin</h2>
      <p class="muted">Signed in as ${esc(toUsername(session.user.email))}${S.role ? ` (${esc(S.role)})` : ''}.
        This page is for super admins.</p>
      <p><a href="/admin/">Back to the admin page</a></p>
    </div>`;
    return;
  }

  S.players = check(await sb.from('players').select('*').order('name'));
  S.admins = check(await sb.rpc('super_list_admins'));
  S.friendliesOn = (await sb.rpc('friendlies_enabled')).data ?? false;
  S.hubsOn = (await sb.rpc('hub_enabled', { p_kind: 'uduk' })).data ?? false;
  S.friendlies = check(await sb.rpc('super_list_friendlies')) ?? [];
  S.openFriendlies = check(await sb.rpc('super_list_open_friendlies')) ?? [];
  S.accounts = check(await sb.rpc('super_list_accounts')) ?? [];
  S.futures = check(await sb.rpc('super_futures')) ?? [];
  if (S.accBetsFor) S.accBets = check(await sb.rpc('super_account_bets', { p_user: S.accBetsFor })) ?? [];
  S.seeds = new Map((check(await sb.from('player_seeds').select('player_id, rating')) ?? [])
    .map(r => [r.player_id, Number(r.rating)]));
  if (S.sel) {
    S.sel = S.players.find(p => p.id === S.sel.id) ?? null;
  }
  if (S.sel) await loadPlayer(S.sel.id);
  render();
}

async function loadPlayer(id) {
  S.points = check(await sb.rpc('player_points', { p_player: id, p_season: SEASON }));
  const u = check(await sb.rpc('player_usage', { p_player: id }));
  S.usage = Array.isArray(u) ? u[0] : u;
}

// ---------------------------------------------------------------- rendering

function playersPanel() {
  const f = S.filter.toLowerCase();
  const list = f ? S.players.filter(p => p.name.toLowerCase().includes(f)) : S.players;
  return `<section class="panel">
    <h2>Players (${S.players.length})</h2>
    <div class="player-add">
      <input type="text" id="p-filter" placeholder="Search players" value="${esc(S.filter)}" autocomplete="off">
      <input type="text" id="p-new" placeholder="New player name" autocomplete="off">
      <button data-act="add-player" class="primary">Add</button>
    </div>
    <div class="chips">${list.map(p => `<button class="chip${S.sel?.id === p.id ? ' on' : ''}" data-pick="${p.id}">${esc(p.name)}</button>`).join('')
      || '<p class="muted">No players match.</p>'}</div>
  </section>`;
}

// The profile shown on the order of merit. Players created on the site keep
// it in the database and can be edited here. Players with a yaml file keep it
// in that file, so the boxes aren't offered: entering stats here as well would
// count their history twice.
function profileBlock(p) {
  if (YAML.has(p.slug)) {
    return `<div class="row"><span class="muted small">Profile: <code>data/players/${esc(p.slug)}.yaml</code>.
      Edit that file to change their nickname, Student/Alumni or stats.</span></div>`;
  }
  const yr = p.year ?? '';
  return `<div class="profile-edit">
    <p class="new-player-title">Profile</p>
    <div class="new-player-grid">
      <label>Nickname <input type="text" id="pf-nick" value="${esc(p.nickname ?? '')}" placeholder="Optional"></label>
      <label>Student or alumni
        <select id="pf-year">
          <option value="" ${yr === '' ? 'selected' : ''}>Not set</option>
          <option ${yr === 'Student' ? 'selected' : ''}>Student</option>
          <option ${yr === 'Alumni' ? 'selected' : ''}>Alumni</option>
          ${yr && !['Student', 'Alumni'].includes(yr) ? `<option selected>${esc(yr)}</option>` : ''}
        </select></label>
    </div>
    <p class="muted small">Totals from before live scoring. Anything scored on the site is added on top.</p>
    <div class="new-player-stats">
      <label>180s <input type="number" id="pf-180" min="0" step="1" value="${p.base_180s ?? 0}"></label>
      <label>100+ checkouts <input type="number" id="pf-100" min="0" step="1" value="${p.base_100_plus ?? 0}"></label>
      <label>Sheet legs <input type="number" id="pf-sheets" min="0" step="1" value="${p.base_sheet_legs ?? 0}"></label>
    </div>
    <div class="row"><button data-act="save-profile" class="primary">Save profile</button></div>
  </div>`;
}

// Starting rating for the odds model, from what you know of their level.
// Results move it from there. Only super admins can see it.
const TIERS = [[1900, 'Very top'], [1750, 'Top'], [1650, 'Mid to top'], [1550, 'Mid'], [1450, 'Lower'], [1350, 'Beginner']];
function seedBlock(p) {
  const cur = S.seeds?.get(p.id) ?? null;
  const known = TIERS.some(([r]) => r === cur);
  return `<div class="row">
      <label>Starting rating <select id="p-seed">
        <option value="">No seed (starts at 1500)</option>
        ${TIERS.map(([r, t]) => `<option value="${r}" ${r === cur ? 'selected' : ''}>${t} (${r})</option>`).join('')}
        ${cur !== null && !known ? `<option value="${cur}" selected>${cur}</option>` : ''}
      </select></label>
      <button data-act="set-seed" class="primary">Save</button>
      <span class="muted small">Used by the odds. Results move it from there.</span>
    </div>`;
}

function playerPanel() {
  const p = S.sel;
  if (!p) return '';
  const u = S.usage ?? { matches: 0, tournaments: 0, point_rows: 0 };
  const total = S.points.reduce((a, r) => a + Number(r.points), 0);

  return `<section class="panel settings-block" style="display:block">
    <h3>${esc(p.name)}</h3>

    <div class="row">
      <label>Name <input type="text" id="p-name" value="${esc(p.name)}"></label>
      <button data-act="rename" class="primary">Save name</button>
      <span class="muted small">Slug: <code>${esc(p.slug)}</code></span>
    </div>

    ${profileBlock(p)}
    ${seedBlock(p)}

    <div class="row">
      <span class="muted small">In ${u.matches} match${u.matches === 1 ? '' : 'es'},
        ${u.tournaments} tournament${u.tournaments === 1 ? '' : 's'},
        ${u.point_rows} points entr${u.point_rows === 1 ? 'y' : 'ies'}.</span>
    </div>

    <h3>Order of merit points · ${SEASON} · ${total}</h3>
    <table class="points-list">
      <thead><tr><th>Event</th><th>Key</th><th>Points</th><th>Source</th><th></th></tr></thead>
      <tbody>
        ${S.points.map(r => `<tr>
          <td>${esc(r.event_name ?? '')}${r.is_pc ? ' <span class="tag">PC</span>' : ''}${r.is_major ? ' <span class="tag">Major</span>' : ''}</td>
          <td class="mono">${esc(r.event_key)}</td>
          <td class="mono">${Number(r.points)}</td>
          <td class="muted small">${r.from_tournament ? 'from a tournament' : 'entered by hand'}</td>
          <td>${r.from_tournament ? '' : `<button data-delpts="${r.id}" title="Remove">&times;</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing scored yet.</td></tr>'}
      </tbody>
    </table>
    <p class="muted small">Entries from a tournament are changed by fixing the result and awarding its points again.</p>

    <div class="row manual-points">
      <label>Event key <input type="text" id="pt-key" placeholder="e.g. ham_cup"></label>
      <label>Shown as <input type="text" id="pt-name" placeholder="e.g. Ham Cup"></label>
      <label>Points <input type="number" id="pt-points" step="50" value="0"></label>
      <label class="chk"><input type="checkbox" id="pt-pc"> PC</label>
      <label class="chk"><input type="checkbox" id="pt-major"> Major</label>
      <button data-act="set-points" class="primary">Add or update</button>
    </div>

    <div class="row merge-row">
      <label>Merge this player into
        <select id="p-merge">
          <option value="">Pick a player</option>
          ${S.players.filter(x => x.id !== p.id).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
        </select></label>
      <button data-act="merge">Merge</button>
      <span class="muted small">Use this for a name typed twice. Everything moves across and this one is removed.</span>
    </div>

    <div class="row danger">
      <button data-act="delete-player">Delete player</button>
      <span class="muted small">Only possible while they have no matches, tournaments or points.</span>
    </div>
  </section>`;
}

// One password for starting friendlies, shared with whoever should be able
// to. Clearing it switches friendlies off.
function friendlyPanel() {
  return `<section class="panel">
    <h2>Friendly matches</h2>
    <p class="muted small">Friendlies are ${S.friendliesOn ? '<b>on</b>' : '<b>off</b>'}.
      Anyone with this password can start a friendly at <a href="/friendly/">/friendly/</a>.
      Friendlies don't count towards the order of merit or anyone's stats, unless you count one under Friendlies to check.</p>
    <div class="row">
      <label>New password <input type="text" id="fr-pw" autocomplete="off" placeholder="At least 4 characters"></label>
      <button data-act="set-friendly-pw" class="primary">Save</button>
      ${S.friendliesOn ? '<button data-act="clear-friendly-pw">Switch friendlies off</button>' : ''}
    </div>
  </section>`;
}

// The password people enter to see and use match chat. Changing it locks
// chat for everyone until they enter the new one.
function chatPanel() {
  return `<section class="panel">
    <h2>Chat password</h2>
    <p class="muted small">Needed to see or post in match chat. Changing it means everyone has to enter the new one.</p>
    <div class="row">
      <label>New password <input type="text" id="chat-pw" autocomplete="off" placeholder="At least 4 characters"></label>
      <button data-act="set-chat-pw" class="primary">Save</button>
    </div>
  </section>`;
}

// Finished friendlies to check. One that was played properly can count
// towards each player's averages, first 9, doubles % and the odds model
// (never 180s, 100+ checkouts, sheet legs, win rates or the order of merit).
// Players never see any of this.
function reviewPanel() {
  const todo = S.friendlies.filter(f => f.counted === null);
  const done = S.friendlies.filter(f => f.counted !== null);
  const opts = sel => `<option value="">No profile, skip</option>${S.players.map(p =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  const score = f => f.sets_to_win ? `${f.p1_sets}–${f.p2_sets} sets` : `${f.p1_legs}–${f.p2_legs}`;
  const when = f => f.finished ? new Date(f.finished).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  const nameOf = id => S.players.find(p => p.id === id)?.name;
  const row = f => `<div class="fr-review" data-fr="${f.tournament_id}">
      <div class="fr-head">
        <a href="/match/?id=${f.match_id}">${esc(f.p1_name)} ${score(f)} ${esc(f.p2_name)}</a>
        <span class="muted small">${when(f)} · ${f.visits} visits${f.remote ? ' · remote' : ''}</span>
      </div>
      <div class="row">
        <label>${esc(f.p1_name)} <span class="muted small">(avg ${f.p1_avg ?? '–'})</span>
          <select data-side="1">${opts(f.match_p1_id)}</select></label>
        <label>${esc(f.p2_name)} <span class="muted small">(avg ${f.p2_avg ?? '–'})</span>
          <select data-side="2">${opts(f.match_p2_id)}</select></label>
      </div>
      <div class="row">
        <button data-frcount="${f.tournament_id}" class="primary">Played properly, count it</button>
        <button data-frskip="${f.tournament_id}">Don't count</button>
        <button data-frdelete="${f.match_id}" class="danger">Delete</button>
      </div>
    </div>`;
  const doneRow = f => `<tr>
      <td><a href="/match/?id=${f.match_id}">${esc(f.p1_name)} ${score(f)} ${esc(f.p2_name)}</a> <span class="muted small">${when(f)}</span></td>
      <td>${f.counted ? `Counted${[f.counted_p1_id, f.counted_p2_id].some(Boolean)
        ? `: ${[f.counted_p1_id, f.counted_p2_id].map(nameOf).filter(Boolean).map(esc).join(', ')}` : ''}` : 'Not counted'}</td>
      <td><button data-frreset="${f.tournament_id}">Undo</button>
        <button data-frdelete="${f.match_id}" class="danger">Delete</button></td>
    </tr>`;
  return `<section class="panel">
    <h2>Friendlies to check (${todo.length})</h2>
    <p class="muted small">If a finished friendly was played properly, pick each player's profile and count it.
      Their averages, first 9, doubles % and odds then include it. 180s, 100+ checkouts, sheet legs,
      win rates and the order of merit never do. Only super admins see this.</p>
    ${todo.length ? todo.map(row).join('') : '<p class="muted">Nothing to check.</p>'}
    ${done.length ? `<p><button data-act="toggle-reviewed" class="link">${S.showReviewed ? 'Hide' : 'Show'} checked friendlies (${done.length})</button></p>
      ${S.showReviewed ? `<table class="points-list"><tbody>${done.map(doneRow).join('')}</tbody></table>` : ''}` : ''}
  </section>
  ${openFriendliesPanel()}`;
}

// Email accounts (chat and token betting). Only super admins see emails.
function accountsPanel() {
  const list = S.accounts ?? [];
  const q = (S.accQ ?? '').toLowerCase();
  const shown = q ? list.filter(a => `${a.display_name} ${a.email}`.toLowerCase().includes(q)) : list;
  return `<section class="panel">
    <h2>Accounts (${list.length})</h2>
    <p class="muted small">Blocked accounts can't chat or bet.</p>
    ${list.length > 8 ? `<input id="acc-q" placeholder="Search name or email" value="${esc(S.accQ ?? '')}">` : ''}
    ${shown.length ? `<table class="points-list"><tbody>${shown.map(a => `<tr>
      <td><b>${esc(a.display_name)}</b>${a.banned ? ' <span class="error small">blocked</span>' : ''}
        <span class="muted small" style="display:block">${esc(a.email ?? '')} · ${Number(a.tokens).toLocaleString('en-GB')} tokens · ${a.bets} bets · ${a.messages} messages</span></td>
      <td class="row" style="justify-content:flex-end;flex-wrap:wrap">
        <input type="number" step="100" placeholder="± tokens" data-acctok="${a.user_id}" style="width:7rem">
        <button data-accadj="${a.user_id}">Give</button>
        <button data-accban="${a.user_id}" data-banned="${a.banned}" class="${a.banned ? '' : 'danger'}">${a.banned ? 'Unblock' : 'Block'}</button>
        <button data-accbets="${a.user_id}"${a.bets ? '' : ' disabled'}>${S.accBetsFor === a.user_id ? 'Hide bets' : 'Bets'}</button>
      </td></tr>${S.accBetsFor === a.user_id ? `<tr><td colspan="2">${accountBetsHtml(S.accBets ?? [])}</td></tr>` : ''}`).join('')}</tbody></table>` : '<p class="muted">Nobody yet.</p>'}
  </section>`;
}

const BET_STATUS = { open: 'Open', won: 'Won', lost: 'Lost', void: 'Refunded', cancelled: 'Cancelled' };
const fmtN = n => Number(n ?? 0).toLocaleString('en-GB');
const shortWhen = d => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// Every bet one account has placed, newest first, with the net result.
function accountBetsHtml(list) {
  if (!list.length) return '<p class="muted small">No bets.</p>';
  const settled = list.filter(b => b.status === 'won' || b.status === 'lost');
  const net = settled.reduce((t, b) => t + Number(b.payout) - Number(b.stake), 0);
  const open = list.filter(b => b.status === 'open');
  return `<div class="acc-bets">
    <p class="small">${list.length} bets · ${settled.length} settled, net ${net >= 0 ? '+' : ''}${fmtN(net)} · ${open.length} open, ${fmtN(open.reduce((t, b) => t + Number(b.stake), 0))} staked</p>
    <table class="bets-list"><tbody>${list.map(b => `<tr>
      <td class="l"><b>${esc(b.selection)}</b> at ${esc(b.price)}
        <span class="muted small">${esc(b.market)}${b.event && !b.market.includes(b.event) ? ` · ${esc(b.event)}` : ''} · ${shortWhen(b.placed_at)}</span></td>
      <td>${fmtN(b.stake)}</td>
      <td class="bet-${b.status}">${BET_STATUS[b.status] ?? b.status}${b.status === 'won' ? ` +${fmtN(b.payout)}` : b.status === 'open' ? ` · to win ${fmtN(b.returns)}` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- futures

const FUT_STATUS = { draft: 'Draft (hidden)', open: 'Open', suspended: 'Suspended', closed: 'Closed', settled: 'Settled' };
const localInput = d => {
  if (!d) return '';
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function futuresPanel() {
  const list = S.futures ?? [];
  if (!list.length) return '';
  return `<section class="panel futures-admin">
    <h2>Futures</h2>
    <p class="muted small">Draft markets are hidden from everyone else. Only selections with a price show on the
      <a href="/futures/">futures page</a>. Prices are fixed odds: changing one doesn't move bets already placed.</p>
    ${list.map(futureMarketHtml).join('')}
  </section>`;
}

function futureMarketHtml(m) {
  const inMarket = new Set(m.selections.map(s => s.player_id));
  const addable = S.players.filter(p => !inMarket.has(p.id));
  const staked = m.selections.reduce((t, s) => t + Number(s.staked), 0);
  const liability = m.selections.reduce((t, s) => t + Number(s.liability), 0);
  return `<div class="fut-market" data-fm="${m.id}">
    <h3>${esc(m.title)}</h3>
    <div class="new-player-grid">
      <label>Title <input type="text" data-fm-title value="${esc(m.title)}"></label>
      <label>Status <select data-fm-status>${Object.entries(FUT_STATUS).map(([k, v]) =>
        `<option value="${k}"${m.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Betting closes <input type="datetime-local" data-fm-closes value="${localInput(m.closes_at)}"></label>
    </div>
    <label>Rules <textarea data-fm-rules rows="2">${esc(m.rules ?? '')}</textarea></label>
    <div class="row"><button class="primary" data-futsave="${m.id}">Save market</button>
      <span class="muted small">${fmtN(staked)} staked · ${fmtN(liability)} to pay if every open bet wins</span></div>
    <div class="fut-scroll"><table class="points-list"><thead><tr><th class="l">Player</th><th>Suggested</th><th>Price</th><th>Bets</th><th>Result</th></tr></thead>
    <tbody>${m.selections.map(s => `<tr>
      <td class="l">${esc(s.name)}</td>
      <td class="fut-sugg">${esc(s.suggested ?? '')}</td>
      <td><input class="fut-price" data-fs-price="${s.id}" data-orig="${esc(s.price ?? '')}" data-sugg="${esc(s.suggested ?? '')}" value="${esc(s.price ?? '')}" placeholder="off"></td>
      <td class="small">${s.bets ? `${s.bets} · ${fmtN(s.staked)}` : ''}</td>
      <td><select data-fs-res="${s.id}">
          <option value=""${s.result ? '' : ' selected'}>–</option>
          ${['won', 'lost', 'void'].map(r => `<option${s.result === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
        <button data-futres="${s.id}">Set</button>
        ${s.bets ? '' : `<button class="link" data-futrm="${s.id}" title="Remove">✕</button>`}</td>
    </tr>`).join('')}</tbody></table></div>
    <div class="row">
      <button data-futsugg="${m.id}">Fill empty prices with suggestions</button>
      <button class="primary" data-futprices="${m.id}">Save prices</button>
    </div>
    <div class="row">
      <select data-fm-add><option value="">Add a player…</option>${addable.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button data-futadd="${m.id}">Add</button>
      <button class="danger" data-futrest="${m.id}">Settle everyone left as lost</button>
    </div>
  </div>`;
}

// Friendlies that haven't finished: being played now, or set up and left.
function openFriendliesPanel() {
  const list = S.openFriendlies ?? [];
  if (!list.length) return '';
  const score = f => f.sets_to_win ? `${f.p1_sets}–${f.p2_sets} sets` : `${f.p1_legs}–${f.p2_legs}`;
  const when = f => new Date(f.updated).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `<section class="panel">
    <h2>Unfinished friendlies (${list.length})</h2>
    <p class="muted small">Being played now, or set up and never finished. Deleting one removes it and everything scored in it.</p>
    <table class="points-list"><tbody>${list.map(f => `<tr>
      <td><a href="/match/?id=${f.match_id}">${esc(f.p1_name)} ${score(f)} ${esc(f.p2_name)}</a>
        <span class="muted small">${f.status === 'live' ? 'live' : 'not started'} · last change ${when(f)} · ${f.visits} visits${f.remote ? ' · remote' : ''}</span></td>
      <td><button data-frdelete="${f.match_id}" class="danger">Delete</button></td>
    </tr>`).join('')}</tbody></table>
  </section>`;
}

// One password, shared by UDUK and Franny, for starting team matches,
// picking players and scoring the games. Clearing it switches both off.
function hubPanel() {
  return `<section class="panel">
    <h2>UDUK and Franny matches</h2>
    <p class="muted small">Team matches are ${S.hubsOn ? '<b>on</b>' : '<b>off</b>'}.
      Anyone with this password can start a match at <a href="/uduk/">/uduk/</a> or <a href="/franny/">/franny/</a>,
      pick the players and score the games.</p>
    <div class="row">
      <label>New password <input type="text" id="hub-pw" autocomplete="off" placeholder="At least 4 characters"></label>
      <button data-act="set-hub-pw" class="primary">Save</button>
      ${S.hubsOn ? '<button data-act="clear-hub-pw">Switch team matches off</button>' : ''}
    </div>
  </section>`;
}

function adminsPanel() {
  return `<section class="panel">
    <h2>Admin logins</h2>
    <table class="points-list">
      <thead><tr><th>Username</th><th>Level</th><th>Added</th><th></th></tr></thead>
      <tbody>${S.admins.map(a => `<tr>
        <td>${esc(toUsername(a.email) || '(unknown)')}</td>
        <td>${a.role === 'super' ? '<b>super</b>' : 'admin'}</td>
        <td class="muted small">${new Date(a.added_at).toLocaleDateString('en-GB')}</td>
        <td><button data-rmadmin="${a.user_id}" data-email="${esc(toUsername(a.email) ?? '')}">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="row">
      <label>Username <input type="text" id="a-email" placeholder="committee"></label>
      <label>Level
        <select id="a-role"><option value="admin">admin</option><option value="super">super</option></select>
      </label>
      <button data-act="set-admin" class="primary">Grant</button>
    </div>
    <p class="muted small">The account has to exist first: create it in the Supabase dashboard under
      Authentication → Users, with the email <code>username@uosdarts.com</code> and
      <b>Auto Confirm User</b> ticked. Then grant the username here. An <b>admin</b> runs tournaments.
      A <b>super</b> can also do everything on this page.</p>
  </section>`;
}

function render() {
  if (S.role !== 'super') return;
  app.innerHTML = `<div class="admin-head">
      <h1>Super admin</h1>
      <a href="/admin/" class="muted small">Tournament admin</a>
    </div>
    ${playersPanel()}${playerPanel()}${reviewPanel()}${accountsPanel()}${futuresPanel()}${friendlyPanel()}${hubPanel()}${chatPanel()}${adminsPanel()}`;
  const f = app.querySelector('#p-filter');
  if (f && S.filter) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

// ---------------------------------------------------------------- actions

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg, false);
  } catch (e) {
    toast(e.message);
  }
  await load();
}

const val = id => app.querySelector(id)?.value.trim() ?? '';

// Players with a yaml file in data/players, published by the build.
let YAML = new Set();
try { YAML = new Set(JSON.parse(document.getElementById('yaml-profiles')?.textContent || '[]')); } catch {}

app.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;

  if (el.dataset.pick) {
    S.sel = S.players.find(p => p.id === el.dataset.pick) ?? null;
    if (S.sel) await loadPlayer(S.sel.id);
    render();
    return;
  }
  if (el.dataset.delpts) {
    await run(async () => check(await sb.rpc('super_delete_points', { p_id: Number(el.dataset.delpts) })),
      'Entry removed');
    return;
  }
  if (el.dataset.accban) {
    const banned = el.dataset.banned !== 'true';
    await run(async () => check(await sb.rpc('super_set_banned', { p_user: el.dataset.accban, p_banned: banned })),
      banned ? 'Account blocked' : 'Account unblocked');
    return;
  }
  if (el.dataset.accbets) {
    const u = el.dataset.accbets;
    if (S.accBetsFor === u) { S.accBetsFor = null; S.accBets = null; render(); return; }
    try {
      S.accBets = check(await sb.rpc('super_account_bets', { p_user: u })) ?? [];
      S.accBetsFor = u;
    } catch (err) { toast(err.message); }
    render();
    return;
  }
  if (await futuresClick(el)) return;
  if (el.dataset.accadj) {
    const box = app.querySelector(`[data-acctok="${el.dataset.accadj}"]`);
    const n = Math.trunc(Number(box?.value));
    if (!n) { toast('Enter a number of tokens (negative to take some away)'); return; }
    await run(async () => check(await sb.rpc('super_adjust_tokens', { p_user: el.dataset.accadj, p_change: n })),
      n > 0 ? `Gave ${n} tokens` : `Took ${-n} tokens`);
    return;
  }
  if (el.dataset.frdelete) {
    const id = el.dataset.frdelete;
    const f = [...S.friendlies, ...(S.openFriendlies ?? [])].find(x => x.match_id === id);
    const label = f ? `${f.p1_name} v ${f.p2_name}` : 'this friendly';
    if (!confirm(`Delete ${label}? This removes the match and everything scored in it, and can't be undone.`)) return;
    await run(async () => check(await sb.rpc('delete_friendly', { p_match: id })), 'Friendly deleted');
    return;
  }
  if (el.dataset.frcount || el.dataset.frskip || el.dataset.frreset) {
    const t = el.dataset.frcount || el.dataset.frskip || el.dataset.frreset;
    const box = app.querySelector(`[data-fr="${t}"]`);
    const side = n => box?.querySelector(`[data-side="${n}"]`)?.value || null;
    const counted = el.dataset.frcount ? true : el.dataset.frskip ? false : null;
    if (counted && !side(1) && !side(2)) { toast('Pick a profile for at least one player'); return; }
    await run(async () => check(await sb.rpc('super_count_friendly', {
      p_tournament: t, p_counted: counted,
      p_p1: counted ? side(1) : null, p_p2: counted ? side(2) : null,
    })), counted ? 'Counted' : counted === false ? 'Marked as not counting' : 'Back to unchecked');
    return;
  }
  if (el.dataset.rmadmin) {
    if (!confirm(`Remove admin access for ${el.dataset.email}?`)) return;
    await run(async () => check(await sb.rpc('super_remove_admin', { p_user: el.dataset.rmadmin })),
      'Access removed');
    return;
  }

  switch (el.dataset.act) {
    case 'toggle-reviewed':
      S.showReviewed = !S.showReviewed;
      render();
      break;
    case 'add-player': {
      const name = val('#p-new');
      if (!name) { toast('Type a name first'); break; }
      await run(async () => {
        const id = check(await sb.rpc('admin_add_player', { p_name: name }));
        S.sel = { id, name };
      }, `${name} added`);
      break;
    }
    case 'save-profile': {
      const n = id => Math.max(0, parseInt(val(id), 10) || 0);
      await run(async () => check(await sb.rpc('super_set_player_profile', {
        p_player: S.sel.id,
        p_year: val('#pf-year') || null,
        p_nickname: val('#pf-nick') || null,
        p_180s: n('#pf-180'),
        p_100_plus: n('#pf-100'),
        p_sheet_legs: n('#pf-sheets'),
      })), 'Profile saved');
      break;
    }
    case 'rename': {
      const name = val('#p-name');
      if (!name) { toast('Type a name first'); break; }
      await run(async () => check(await sb.rpc('super_rename_player', {
        p_player: S.sel.id, p_name: name,
      })), 'Name changed');
      break;
    }
    case 'set-points': {
      const key = val('#pt-key');
      if (!key) { toast('Give the event a key'); break; }
      await run(async () => check(await sb.rpc('super_set_points', {
        p_player: S.sel.id,
        p_season: SEASON,
        p_event_key: key,
        p_points: Number(val('#pt-points')) || 0,
        p_event_name: val('#pt-name') || key,
        p_is_pc: app.querySelector('#pt-pc').checked,
        p_is_major: app.querySelector('#pt-major').checked,
      })), 'Points saved');
      break;
    }
    case 'set-seed': {
      const v = val('#p-seed');
      await run(async () => check(await sb.rpc('super_set_seed', {
        p_player: S.sel.id, p_rating: v ? Number(v) : null,
      })), v ? 'Starting rating saved' : 'Seed removed');
      break;
    }
    case 'merge': {
      const into = val('#p-merge');
      if (!into) { toast('Pick who to merge into'); break; }
      const name = S.players.find(p => p.id === into)?.name;
      if (!confirm(`Merge ${S.sel.name} into ${name}? Everything moves across and ${S.sel.name} is removed.`)) break;
      await run(async () => {
        check(await sb.rpc('super_merge_players', { p_from: S.sel.id, p_into: into }));
        S.sel = null;
      }, 'Merged');
      break;
    }
    case 'delete-player':
      if (!confirm(`Delete ${S.sel.name}?`)) break;
      await run(async () => {
        check(await sb.rpc('super_delete_player', { p_player: S.sel.id }));
        S.sel = null;
      }, 'Player deleted');
      break;
    case 'set-chat-pw': {
      const pw = val('#chat-pw');
      if (pw.length < 4) { toast('Use at least 4 characters'); break; }
      if (!confirm('Change the chat password? Everyone will need to enter the new one.')) break;
      await run(async () => check(await sb.rpc('super_set_chat_password', { p_password: pw })),
        'Chat password saved');
      break;
    }
    case 'set-friendly-pw': {
      const pw = val('#fr-pw');
      if (pw.length < 4) { toast('Use at least 4 characters'); break; }
      await run(async () => check(await sb.rpc('super_set_friendly_password', { p_password: pw })),
        'Friendly password saved');
      break;
    }
    case 'clear-friendly-pw':
      if (!confirm('Switch friendlies off? Nobody will be able to start one until a new password is set.')) break;
      await run(async () => check(await sb.rpc('super_set_friendly_password', { p_password: '' })),
        'Friendlies switched off');
      break;
    case 'set-hub-pw': {
      const pw = val('#hub-pw');
      if (pw.length < 4) { toast('Use at least 4 characters'); break; }
      await run(async () => check(await sb.rpc('super_set_hub_password', { p_password: pw })),
        'Team match password saved');
      break;
    }
    case 'clear-hub-pw':
      if (!confirm('Switch UDUK and Franny matches off? Nobody will be able to start or score them until a new password is set.')) break;
      await run(async () => check(await sb.rpc('super_set_hub_password', { p_password: '' })),
        'Team matches switched off');
      break;
    case 'set-admin': {
      const email = val('#a-email');
      if (!email) { toast('Type an email'); break; }
      await run(async () => check(await sb.rpc('super_set_admin', {
        p_email: toLoginEmail(email), p_role: app.querySelector('#a-role').value,
      })), 'Access granted');
      break;
    }
  }
});

async function futuresClick(el) {
  const box = el.closest('[data-fm]');
  if (!box) return false;
  const q = sel => box.querySelector(sel);
  const mid = Number(box.dataset.fm);
  const market = (S.futures ?? []).find(m => m.id === mid);
  if (el.dataset.futsugg) {
    let n = 0;
    box.querySelectorAll('[data-fs-price]').forEach(i => {
      if (!i.value.trim() && i.dataset.sugg) { i.value = i.dataset.sugg; i.classList.add('fut-changed'); n++; }
    });
    toast(n ? `Filled ${n}. Check them, then Save prices.` : 'Nothing empty to fill', !n);
    return true;
  }
  if (el.dataset.futprices) {
    const prices = {};
    box.querySelectorAll('[data-fs-price]').forEach(i => {
      if (i.value.trim() !== i.dataset.orig) prices[i.dataset.fsPrice] = i.value.trim() || null;
    });
    if (!Object.keys(prices).length) { toast('No prices changed'); return true; }
    await run(async () => check(await sb.rpc('super_future_prices', { p_market: mid, p_prices: prices })),
      `${Object.keys(prices).length} price${Object.keys(prices).length === 1 ? '' : 's'} saved`);
    return true;
  }
  if (el.dataset.futsave) {
    const status = q('[data-fm-status]').value;
    const closes = q('[data-fm-closes]').value;
    if (status === 'open' && market?.status !== 'open'
      && !confirm(`Open "${market?.title}"? Everyone will be able to see it and bet on the priced selections.`)) return true;
    await run(async () => check(await sb.rpc('super_future_market', {
      p_market: mid, p_title: q('[data-fm-title]').value, p_rules: q('[data-fm-rules]').value,
      p_status: status, p_closes_at: closes ? new Date(closes).toISOString() : null,
    })), 'Market saved');
    return true;
  }
  if (el.dataset.futres) {
    const sid = Number(el.dataset.futres);
    const r = q(`[data-fs-res="${sid}"]`).value || null;
    const sel = market?.selections.find(x => x.id === sid);
    const what = r ? { won: 'a winner', lost: 'a loser', void: 'void (stakes back)' }[r] : 'unsettled (bets back to open)';
    if (!confirm(`Settle ${sel?.name ?? 'this'} as ${what}? ${sel?.bets ?? 0} bets are affected.`)) return true;
    await run(async () => check(await sb.rpc('super_future_settle', { p_selection: sid, p_result: r })), 'Settled');
    return true;
  }
  if (el.dataset.futrm) {
    await run(async () => check(await sb.rpc('super_future_remove', { p_selection: Number(el.dataset.futrm) })), 'Removed');
    return true;
  }
  if (el.dataset.futadd) {
    const pid = q('[data-fm-add]').value;
    if (!pid) { toast('Pick a player'); return true; }
    await run(async () => check(await sb.rpc('super_future_add', { p_market: mid, p_player: pid })), 'Added. Give them a price.');
    return true;
  }
  if (el.dataset.futrest) {
    const left = market?.selections.filter(x => !x.result).length ?? 0;
    if (!confirm(`Settle all ${left} unsettled selections in "${market?.title}" as lost and mark the market settled? Set the winners (and any voids) first.`)) return true;
    await run(async () => check(await sb.rpc('super_future_settle_rest', { p_market: mid })), 'Market settled');
    return true;
  }
  return false;
}

app.addEventListener('input', e => {
  if (e.target.dataset?.fsPrice !== undefined) {
    e.target.classList.toggle('fut-changed', e.target.value.trim() !== e.target.dataset.orig);
    return;
  }
  if (e.target.id === 'p-filter') {
    S.filter = e.target.value;
    render();
  }
  if (e.target.id === 'acc-q') {
    S.accQ = e.target.value;
    render();
    const box = app.querySelector('#acc-q');
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }
});

async function load() {
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}

load();
