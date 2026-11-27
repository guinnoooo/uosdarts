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
  if (!session || session.user.is_anonymous) { location.replace('/account/?next=/super/'); return; }

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

  // Everything the page shows, fetched at once rather than one after another.
  const rpc = (fn, args) => sb.rpc(fn, args);
  const [players, admins, friendliesOn, hubsOn, friendlies, openFriendlies, accounts, futures, fantasy,
    fxScoring, fxTeams, allBets, accBets, seeds, futCats, boosts, comps] = await Promise.all([
    sb.from('players').select('*').order('name'),
    rpc('super_list_admins'),
    rpc('friendlies_enabled'),
    rpc('hub_enabled', { p_kind: 'uduk' }),
    rpc('super_list_friendlies'),
    rpc('super_list_open_friendlies'),
    rpc('super_list_accounts'),
    rpc('super_futures'),
    rpc('super_fantasy_prices'),
    rpc('fantasy_scoring_list'),
    rpc('super_fantasy_teams'),
    rpc('super_all_bets', { p_limit: 500 }),
    S.accBetsFor ? rpc('super_account_bets', { p_user: S.accBetsFor }) : Promise.resolve({ data: null }),
    sb.from('player_seeds').select('player_id, rating'),
    rpc('super_future_categories'),
    rpc('super_boosts'),
    sb.from('tournaments').select('id, name, starts_at, status').is('deleted_at', null).eq('is_friendly', false)
      .neq('status', 'complete').order('starts_at', { ascending: true, nullsFirst: false }).limit(40),
  ]);
  S.players = check(players);
  S.admins = check(admins);
  S.friendliesOn = friendliesOn.data ?? false;
  S.hubsOn = hubsOn.data ?? false;
  S.friendlies = check(friendlies) ?? [];
  S.openFriendlies = check(openFriendlies) ?? [];
  S.accounts = check(accounts) ?? [];
  S.futures = check(futures) ?? [];
  S.futCats = check(futCats) ?? [];
  S.boosts = check(boosts) ?? [];
  S.comps = check(comps) ?? [];
  S.fantasy = check(fantasy) ?? [];
  S.fxScoring = check(fxScoring) ?? [];
  S.fxTeams = check(fxTeams) ?? null;
  S.allBets = check(allBets) ?? [];
  if (S.accBetsFor) S.accBets = check(accBets) ?? [];
  S.seeds = new Map((check(seeds) ?? []).map(r => [r.player_id, Number(r.rating)]));
  if (S.sel) {
    S.sel = S.players.find(p => p.id === S.sel.id) ?? null;
  }
  if (S.sel) await loadPlayer(S.sel.id);
  render();
}

async function loadPlayer(id) {
  const [points, usage] = await Promise.all([
    sb.rpc('player_points', { p_player: id, p_season: SEASON }),
    sb.rpc('player_usage', { p_player: id }),
  ]);
  S.points = check(points);
  const u = check(usage);
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
const isPairs = f => /&/.test(`${f.p1_name}${f.p2_name}`);
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
      ${isPairs(f) ? '<p class="muted small">Pairs: the visits aren\'t split between players, so it can\'t be counted.</p>' : `<div class="row">
        <label>${esc(f.p1_name)} <span class="muted small">(avg ${f.p1_avg ?? '–'})</span>
          <select data-side="1">${opts(f.match_p1_id)}</select></label>
        <label>${esc(f.p2_name)} <span class="muted small">(avg ${f.p2_avg ?? '–'})</span>
          <select data-side="2">${opts(f.match_p2_id)}</select></label>
      </div>`}
      <div class="row">
        ${isPairs(f) ? '' : `<button data-frcount="${f.tournament_id}" class="primary">Played properly, count it</button>`}
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
  const shown = q ? list.filter(a => `${a.display_name} ${a.email} ${a.player_name ?? ''}`.toLowerCase().includes(q)) : list;
  const linked = new Set(list.map(a => a.player_id).filter(Boolean));
  // An unlinked account whose name matches a player gets a one-tap suggestion.
  const guess = a => a.player_id ? null
    : S.players.find(p => !linked.has(p.id) && p.name.toLowerCase() === String(a.display_name ?? '').trim().toLowerCase());
  const linkCell = a => {
    if (S.linkFor === a.user_id) {
      return `<span class="row" style="flex-wrap:wrap">
        <select data-linkpick="${a.user_id}"><option value="">Not linked</option>${S.players.filter(p => p.id === a.player_id || !linked.has(p.id))
          .map(p => `<option value="${p.id}"${p.id === a.player_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <button data-linksave="${a.user_id}" class="primary">Save</button><button data-linkfor="">Cancel</button></span>`;
    }
    const g = guess(a);
    return `<span class="small">${a.player_id ? `Player: <a href="/player/?p=${esc(S.players.find(p => p.id === a.player_id)?.slug ?? '')}">${esc(a.player_name)}</a>` : '<span class="muted">No player linked</span>'}
      <button class="link" data-linkfor="${a.user_id}">${a.player_id ? 'Change' : 'Link'}</button>
      ${g ? `<button class="link" data-linkquick="${a.user_id}" data-player="${g.id}">Link to ${esc(g.name)}?</button>` : ''}</span>`;
  };
  return `<section class="panel">
    <h2>Accounts (${list.length})</h2>
    <p class="muted small">Blocked accounts can't chat or bet. Link an account to the player it belongs to, ready for emailing results later.
      ${list.filter(a => a.player_id).length} of ${list.length} linked.</p>
    ${list.length > 8 ? `<input id="acc-q" placeholder="Search name or email" value="${esc(S.accQ ?? '')}">` : ''}
    ${shown.length ? `<table class="points-list"><tbody>${shown.map(a => `<tr>
      <td><b>${esc(a.display_name)}</b>${a.banned ? ' <span class="error small">blocked</span>' : ''}
        <span class="muted small" style="display:block">${esc(a.email ?? '')} · ${Number(a.tokens).toLocaleString('en-GB')} tokens · ${a.bets} bets · ${a.messages} messages</span>
        <span style="display:block">${linkCell(a)}</span></td>
      <td class="row" style="justify-content:flex-end;flex-wrap:wrap">
        <input type="number" step="100" placeholder="± tokens" data-acctok="${a.user_id}" style="width:7rem">
        <button data-accadj="${a.user_id}">Give</button>
        <button data-accban="${a.user_id}" data-banned="${a.banned}" class="${a.banned ? '' : 'danger'}">${a.banned ? 'Unblock' : 'Block'}</button>
        <button data-accbets="${a.user_id}"${a.bets ? '' : ' disabled'}>${S.accBetsFor === a.user_id ? 'Hide bets' : 'Bets'}</button>
      </td></tr>${S.accBetsFor === a.user_id ? `<tr><td colspan="2">${accountBetsHtml(S.accBets ?? [])}</td></tr>` : ''}`).join('')}</tbody></table>` : '<p class="muted">Nobody yet.</p>'}
  </section>`;
}

const BET_STATUS = { open: 'Open', won: 'Won', lost: 'Lost', void: 'Bet void', cancelled: 'Cancelled', cashed_out: 'Cashed out' };
const fmtN = n => Number(n ?? 0).toLocaleString('en-GB');
const shortWhen = d => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// An open futures bet can be voided on its own: stake back, shown as "Bet void".
const voidBtn = b => b.future_id && b.status === 'open' ? ` <button class="link small" data-betvoid="${b.id}">Void</button>` : '';

// Market, then the match or event it belongs to.
const betWhat = b => [b.market, b.match, b.event && !b.market.includes(b.event) ? b.event : null].filter(Boolean).map(esc).join(' · ');

// Every bet on the site, newest first. Search by account, player or market.
function allBetsPanel() {
  const list = S.allBets ?? [];
  const q = (S.betQ ?? '').toLowerCase();
  const shown = q ? list.filter(b => `${b.account} ${b.selection} ${b.market} ${b.event ?? ''} ${b.match ?? ''}`.toLowerCase().includes(q)) : list;
  const open = shown.filter(b => b.status === 'open');
  return `<section class="panel">
    <h2>All bets (${list.length})</h2>
    ${list.length ? `<input id="bet-q" placeholder="Search account, player or market" value="${esc(S.betQ ?? '')}">
    <p class="small">${open.length} open · ${fmtN(open.reduce((t, b) => t + Number(b.stake), 0))} staked · ${fmtN(open.reduce((t, b) => t + Number(b.returns), 0))} to pay if all win</p>
    <table class="bets-list"><tbody>${shown.map(b => `<tr>
      <td class="l"><b>${esc(b.account)}</b>: ${esc(b.selection)} at ${esc(b.price)}
        <span class="muted small">${betWhat(b)} · ${shortWhen(b.placed_at)}</span></td>
      <td>${fmtN(b.stake)}</td>
      <td class="bet-${b.status}">${BET_STATUS[b.status] ?? b.status}${b.status === 'won' || b.status === 'cashed_out' ? ` +${fmtN(b.payout)}` : b.status === 'open' ? ` · to win ${fmtN(b.returns)}` : ''}${voidBtn(b)}</td>
    </tr>`).join('') || '<tr><td class="muted">No bets match.</td></tr>'}</tbody></table>` : '<p class="muted">No bets yet.</p>'}
  </section>`;
}

// Every fantasy team for the coming week, including ones still hidden from
// everyone else until the deadline.
const FX_ROLES = ['Captain', 'Power Scorer', 'Big Finisher', 'Dark Horse', 'Europa Specialist', 'Bench'];
const fxMoney = n => n == null ? '' : `£${Number(n).toFixed(1)}m`;
function fantasyTeamsPanel() {
  const d = S.fxTeams;
  const teams = d?.teams ?? [];
  const locked = d?.locks_at && new Date(d.locks_at) <= new Date();
  return `<section class="panel">
    <h2>Fantasy teams (${teams.length})</h2>
    ${d ? `<p class="small muted">Week of ${new Date(d.gw).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${d.locks_at ? ` · ${locked ? 'locked' : 'locks'} ${shortWhen(d.locks_at)}` : ''}</p>` : ''}
    ${teams.length ? teams.map(t => `<div class="fx-admin-team">
      <p><b>${esc(t.name)}</b> <span class="muted small">${esc(t.manager)} · ${fxMoney(t.bank)} in the bank${t.changes ? ` · ${t.changes} change${t.changes === 1 ? '' : 's'}` : ''}${t.saved_this_week ? '' : ' · not changed since last week'}</span></p>
      <table class="points-list"><tbody>${t.squad.map(p => `<tr>
        <td class="muted small">${FX_ROLES[p.slot - 1] ?? p.slot}</td>
        <td class="l">${esc(p.name)}</td>
        <td class="small">${fxMoney(p.paid)}${p.price != null && Number(p.price) !== Number(p.paid) ? ` <span class="muted">(now ${fxMoney(p.price)})</span>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`).join('') : '<p class="muted">No teams yet.</p>'}
  </section>`;
}

// Every bet one account has placed, newest first, with the net result.
function accountBetsHtml(list) {
  if (!list.length) return '<p class="muted small">No bets.</p>';
  const settled = list.filter(b => ['won', 'lost', 'cashed_out'].includes(b.status));
  const net = settled.reduce((t, b) => t + Number(b.payout) - Number(b.stake), 0);
  const open = list.filter(b => b.status === 'open');
  return `<div class="acc-bets">
    <p class="small">${list.length} bets · ${settled.length} settled, net ${net >= 0 ? '+' : ''}${fmtN(net)} · ${open.length} open, ${fmtN(open.reduce((t, b) => t + Number(b.stake), 0))} staked</p>
    <table class="bets-list"><tbody>${list.map(b => `<tr>
      <td class="l"><b>${esc(b.selection)}</b> at ${esc(b.price)}
        <span class="muted small">${betWhat(b)} · ${shortWhen(b.placed_at)}</span></td>
      <td>${fmtN(b.stake)}</td>
      <td class="bet-${b.status}">${BET_STATUS[b.status] ?? b.status}${b.status === 'won' || b.status === 'cashed_out' ? ` +${fmtN(b.payout)}` : b.status === 'open' ? ` · to win ${fmtN(b.returns)}` : ''}${voidBtn(b)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- futures

const FUT_STATUS = { draft: 'Draft (hidden)', open: 'Open', suspended: 'Suspended', closed: 'Closed', settled: 'Settled' };
const localInput = d => {
  if (!d) return '';
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

// Fantasy prices. Nobody can be picked until they have one.
function fantasyPanel() {
  const list = S.fantasy ?? [];
  const listed = new Set(list.map(r => r.player_id));
  const addable = S.players.filter(p => !listed.has(p.id));
  return `<section class="panel futures-admin" data-fx>
    <h2>Fantasy prices</h2>
    <p class="muted small">Budget £50.0m for six. A blank price can't be picked.</p>
    <div class="fut-scroll"><table class="points-list"><thead><tr><th class="l">Player</th><th>Suggested (£m)</th><th>Price (£m)</th><th>In teams</th></tr></thead>
    <tbody>${list.map(r => `<tr>
      <td class="l">${esc(r.name)}${r.price == null ? ' <span class="small muted">needs a price</span>' : ''}</td>
      <td class="fut-sugg">${r.suggested ?? ''}</td>
      <td><input class="fut-price" data-fx-price="${r.player_id}" data-orig="${r.price ?? ''}" data-sugg="${r.suggested ?? ''}" value="${r.price ?? ''}" inputmode="decimal" placeholder="off"></td>
      <td class="small">${r.picked || ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="row">
      <button data-fxsugg="1">Fill empty prices with suggestions</button>
      <button class="primary" data-fxsave="1">Save prices</button>
    </div>
    <div class="row">
      <select data-fx-add><option value="">Add a player…</option>${addable.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <input type="number" step="0.5" min="1" max="30" data-fx-addprice placeholder="Price" style="width:6rem">
      <button data-fxadd="1">Add</button>
    </div>
  </section>`;
}

// What each thing scores in fantasy darts. Changes apply to every week,
// past ones included, the next time points are worked out.
function fantasyScoringPanel() {
  const list = S.fxScoring ?? [];
  return `<section class="panel futures-admin" data-fxs>
    <h2>Fantasy scoring</h2>
    <p class="muted small">Changes rescore every week, past ones too.</p>
    <table class="points-list"><tbody>${list.map(r => `<tr>
      <td class="l">${esc(r.label)}</td>
      <td><input class="fut-price" type="number" step="1" data-fxs-pts="${esc(r.key)}" data-orig="${r.points}" value="${r.points}"></td>
    </tr>`).join('')}</tbody></table>
    <div class="row"><button class="primary" data-fxssave="1">Save scoring</button></div>
  </section>`;
}

// Superboosts: hand-priced bets at better odds, shown first in their comp on
// the Odds page as "was 4/1, now 6/1". Optional max stake per person.
const BOOST_STATUS = { draft: 'Draft (hidden)', open: 'Open', closed: 'Closed' };
function boostForm(b) {
  const id = b?.id ?? 'new';
  const settled = b?.status === 'settled';
  const comps = (S.comps ?? []).concat(b?.tournament_id && !(S.comps ?? []).some(c => c.id === b.tournament_id) ? [{ id: b.tournament_id, name: b.tournament }] : []);
  return `<div class="fut-market boost-admin" data-bx="${id}">
    ${b ? `<h3>${esc(b.title)}${settled ? ` <span class="muted small">settled ${esc(b.result)}</span>` : ''}</h3>` : ''}
    <div class="new-player-grid">
      <label>Comp <select data-bx-comp><option value="">None (own heading)</option>${comps.map(c => `<option value="${c.id}"${c.id === b?.tournament_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>Was <input type="text" data-bx-was value="${esc(b?.was_price ?? '')}" placeholder="e.g. 4/1"></label>
      <label>Now <input type="text" data-bx-price value="${esc(b?.price ?? '')}" placeholder="e.g. 6/1"></label>
      <label>Max stake <input type="number" min="10" step="10" data-bx-max value="${b?.max_stake ?? ''}" placeholder="No limit"></label>
      <label>Status <select data-bx-status${settled ? ' disabled' : ''}>${Object.entries(BOOST_STATUS).map(([k, v]) => `<option value="${k}"${(b?.status ?? 'draft') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Betting closes <input type="datetime-local" data-bx-closes value="${localInput(b?.closes_at)}"></label>
    </div>
    <label>What it is <input type="text" data-bx-title value="${esc(b?.title ?? '')}" placeholder="e.g. Mikey Guinness to win PC 10 and hit a 180"></label>
    <label>Small print <input type="text" data-bx-detail value="${esc(b?.detail ?? '')}" placeholder="Optional, e.g. Both must happen"></label>
    <div class="row">
      <button class="primary" data-bxsave>${b ? 'Save' : 'Add superboost'}</button>
      ${b ? `<span class="muted small">${b.bets} bet${b.bets === 1 ? '' : 's'} · ${fmtN(b.staked)} staked · ${fmtN(b.liability)} to pay if it wins</span>` : ''}
    </div>
    ${b ? `<div class="row">
      <select data-bx-res><option value=""${b.result ? '' : ' selected'}>Not settled</option>${['won', 'lost', 'void'].map(r => `<option${b.result === r ? ' selected' : ''}>${r}</option>`).join('')}</select>
      <button data-bxsettle>Settle</button>
      ${b.bets ? '' : '<button class="danger" data-bxdel>Delete</button>'}
    </div>` : ''}
  </div>`;
}
function boostsPanel() {
  const list = S.boosts ?? [];
  return `<section class="panel futures-admin">
    <h2>Superboosts${list.filter(b => b.status === 'open').length ? ` <span class="fut-pending">${list.filter(b => b.status === 'open').length} open</span>` : ''}</h2>
    <p class="muted small">Shown first in their comp on the Odds page, the old price struck through. Single bets only, not in accas.
      Drafts are hidden. Settle with won, lost or void.</p>
    <h3>New superboost</h3>
    ${boostForm(null)}
    ${list.map(boostForm).join('')}
  </section>`;
}

// Futures and specials, grouped by category. Categories are the headings
// on the Futures page: add, rename, reorder or delete them here, and move
// markets between them or up and down within one.
function futuresPanel() {
  const cats = S.futCats ?? [];
  const list = S.futures ?? [];
  const pending = list.reduce((t, m) => t + m.selections.filter(x => x.proposed).length, 0);
  const catOpts = sel => cats.map(c => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const groups = cats.map(c => ({ c, markets: list.filter(m => m.category_id === c.id) }));
  const loose = list.filter(m => !cats.some(c => c.id === m.category_id));
  return `<section class="panel futures-admin">
    <h2>Futures and specials${pending ? ` <span class="fut-pending">${pending} to approve</span>` : ''}</h2>
    <p class="muted small">Drafts are hidden. A blank price isn't shown. Prices only change when you approve them.
      Refresh suggestions works out moves for player markets from form and the betting so far. The weekly model run does it too.</p>
    <div class="row"><button data-futsuggest="1">Refresh suggestions</button></div>

    <h3>Categories</h3>
    <p class="muted small">The headings on the Futures page, in this order.</p>
    <table class="points-list fut-cats"><tbody>${cats.map((c, i) => `<tr>
      <td class="l"><input type="text" data-fc-name="${c.id}" value="${esc(c.name)}"></td>
      <td class="small muted">${c.markets} market${c.markets === 1 ? '' : 's'}</td>
      <td class="fut-move"><button data-fcmove="${c.id}" data-dir="-1"${i ? '' : ' disabled'} title="Up">↑</button><button data-fcmove="${c.id}" data-dir="1"${i < cats.length - 1 ? '' : ' disabled'} title="Down">↓</button></td>
      <td><button data-fcsave="${c.id}">Rename</button>${c.markets ? '' : ` <button class="link" data-fcdel="${c.id}" title="Delete">✕</button>`}</td>
    </tr>`).join('')}</tbody></table>
    <div class="row"><input type="text" id="fc-new" placeholder="New category, e.g. Ham Cup specials" style="flex:1">
      <button data-act="fc-create">Add category</button></div>

    <h3>New market</h3>
    <p class="muted small">Starts as a draft, hidden until you open it.</p>
    <div class="row"><input type="text" id="fm-new-title" placeholder="e.g. Will anyone hit a 9-darter this season?" style="flex:1"></div>
    <div class="row">
      <select id="fm-new-kind"><option value="special">Typed options (Yes / No…)</option><option value="matchup">Matchups (A v B pairings)</option><option value="player">Players</option></select>
      <select id="fm-new-cat">${catOpts(cats.at(-1)?.id)}</select>
      <button class="primary" data-act="fm-create">Create</button>
    </div>

    ${groups.map(g => `<div class="fut-cat-group"><h3 class="fut-cat-head">${esc(g.c.name)}</h3>
      ${g.markets.length ? g.markets.map((m, i) => futureMarketHtml(m, { first: !i, last: i === g.markets.length - 1, catOpts })).join('') : '<p class="muted small">No markets yet.</p>'}</div>`).join('')}
    ${loose.length ? `<div class="fut-cat-group"><h3 class="fut-cat-head">No category</h3>${loose.map(m => futureMarketHtml(m, { first: true, last: true, catOpts })).join('')}</div>` : ''}
  </section>`;
}

// Decimal odds from "5/2" or "Evens", for comparing prices.
const frac = p => { if (!p) return Infinity; if (/^evens$/i.test(p)) return 2; const [a, b] = String(p).split('/').map(Number); return b ? 1 + a / b : Infinity; };

// The green/red arrow on the Futures page for a price that moved this week.
// Tap to hide it for this selection (it stays hidden until shown again).
function arrowToggle(s) {
  const moved = s.was && s.price && frac(s.was) !== frac(s.price);
  if (!moved && !s.hide_move) return '';
  if (s.hide_move) return `<button class="link small fut-arrow-tg" data-futarrow="${s.id}" data-hide="0" title="The arrow is hidden. Tap to show it again.">arrow off</button>`;
  const inward = frac(s.price) < frac(s.was);
  return `<button class="link small fut-arrow-tg" data-futarrow="${s.id}" data-hide="1" title="Showing ${inward ? 'in' : 'out'} from ${esc(s.was)}. Tap to hide it.">
    <span class="fut-arrow ${inward ? 'in' : 'out'}">${inward ? '▼' : '▲'}</span> hide</button>`;
}

function futureMarketHtml(m, { first = true, last = true, catOpts = null } = {}) {
  // Typed options and matchups have no model suggestions; matchups show as
  // pairings, each side settled on its own (both void if they go out together).
  const special = m.kind !== 'player';
  const matchup = m.kind === 'matchup';
  const inMarket = new Set(m.selections.map(s => s.player_id));
  const addable = S.players.filter(p => !inMarket.has(p.id));
  const staked = m.selections.reduce((t, s) => t + Number(s.staked), 0);
  const liability = m.selections.reduce((t, s) => t + Number(s.liability), 0);
  return `<div class="fut-market" data-fm="${m.id}">
    <h3 class="fut-market-head" data-fold="${esc(m.title)}">${esc(m.title)}
      <span class="fut-move"><button data-fmmove="${m.id}" data-dir="-1"${first ? ' disabled' : ''} title="Up">↑</button><button data-fmmove="${m.id}" data-dir="1"${last ? ' disabled' : ''} title="Down">↓</button></span></h3>
    <div class="new-player-grid">
      ${catOpts ? `<label>Category <select data-fm-cat>${catOpts(m.category_id)}</select></label>` : ''}
      <label>Title <input type="text" data-fm-title value="${esc(m.title)}"></label>
      <label>Status <select data-fm-status>${Object.entries(FUT_STATUS).map(([k, v]) =>
        `<option value="${k}"${m.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Betting closes <input type="datetime-local" data-fm-closes value="${localInput(m.closes_at)}"></label>
    </div>
    <label>Rules <textarea data-fm-rules rows="2">${esc(m.rules ?? '')}</textarea></label>
    <div class="row"><button class="primary" data-futsave="${m.id}">Save market</button>
      <span class="muted small">${fmtN(staked)} staked · ${fmtN(liability)} to pay if every open bet wins</span></div>
    ${m.selections.some(x => x.proposed) ? `<div class="row fut-approve-row"><b>${m.selections.filter(x => x.proposed).length} suggested move${m.selections.filter(x => x.proposed).length === 1 ? '' : 's'}</b>
      <button class="primary" data-futapproveall="${m.id}">Approve all</button></div>` : ''}
    <div class="fut-scroll"><table class="points-list"><thead><tr><th class="l">${matchup ? 'Pairing' : special ? 'Option' : 'Player'}</th>${special ? '' : '<th>Suggested</th>'}<th>Price</th><th>Bets</th><th>Result</th></tr></thead>
    <tbody>${m.selections.map((s, i, all) => `<tr${matchup && s.pair !== all[i - 1]?.pair ? ' class="mu-first"' : ''}>
      <td class="l">${matchup ? `<span class="muted small">${s.pair !== all[i - 1]?.pair ? `#${s.pair}` : 'v'}</span> ` : ''}${esc(s.name)}</td>
      ${special ? '' : `<td class="fut-sugg">${esc(s.suggested ?? '')}</td>`}
      <td class="fut-price-cell"><input class="fut-price" data-fs-price="${s.id}" data-orig="${esc(s.price ?? '')}" data-sugg="${esc(s.suggested ?? '')}" value="${esc(s.price ?? '')}" placeholder="off">${arrowToggle(s)}</td>
      <td class="small">${s.bets ? `${s.bets} · ${fmtN(s.staked)}` : ''}</td>
      <td><select data-fs-res="${s.id}">
          <option value=""${s.result ? '' : ' selected'}>–</option>
          ${['won', 'lost', 'void'].map(r => `<option${s.result === r ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
        <button data-futres="${s.id}">Set</button>
        ${matchup
          ? (s.pair !== all[i - 1]?.pair && !all.some(x => x.pair === s.pair && x.bets) ? `<button class="link" data-murm="${s.pair}" title="Remove pairing">✕</button>` : '')
          : s.bets ? '' : `<button class="link" data-futrm="${s.id}" title="Remove">✕</button>`}</td>
    </tr>${s.proposed ? `<tr class="fut-sugg-row"><td colspan="${special ? 4 : 5}">
      <span class="fut-to ${frac(s.proposed) < frac(s.price) ? 'in' : 'out'}">${frac(s.proposed) < frac(s.price) ? '▼ Shorten' : '▲ Drift'} to ${esc(s.proposed)}</span>
      <button class="primary small-btn" data-futok="${s.id}">Approve</button><button class="small-btn" data-futno="${s.id}">Reject</button>
      <span class="muted small" style="display:block">${esc(s.proposed_reason ?? '')}</span></td></tr>` : ''}`).join('')}</tbody></table></div>
    <div class="row">
      ${special ? '' : `<button data-futsugg="${m.id}">Fill empty prices with suggestions</button>`}
      <button class="primary" data-futprices="${m.id}">Save prices</button>
    </div>
    <div class="row">
      ${matchup
        ? `<input type="text" data-mu-a list="mu-players" placeholder="Name A" style="flex:1">
           <input type="text" data-mu-ap placeholder="Price" style="width:5rem">
           <span class="muted">v</span>
           <input type="text" data-mu-b list="mu-players" placeholder="Name B" style="flex:1">
           <input type="text" data-mu-bp placeholder="Price" style="width:5rem">
           <button data-muadd="${m.id}">Add pairing</button>
           <datalist id="mu-players">${S.players.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
    </div>
    <div class="row">`
        : special
        ? `<input type="text" data-sp-name placeholder="Option, e.g. Yes" style="flex:1">
           <input type="text" data-sp-price placeholder="Price" style="width:5rem">
           <button data-spadd="${m.id}">Add</button>`
        : `<select data-fm-add><option value="">Add a player…</option>${addable.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
           <button data-futadd="${m.id}">Add</button>`}
      ${matchup ? '' : `<button class="danger" data-futrest="${m.id}" data-as="lost">Settle everyone left as lost</button>`}
      <button data-futrest="${m.id}" data-as="void">Void everyone left</button>
      ${!m.selections.some(x => x.bets) ? `<button class="danger" data-spdel="${m.id}">Delete</button>` : ''}
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
    ${playersPanel()}${playerPanel()}${reviewPanel()}${accountsPanel()}${allBetsPanel()}${boostsPanel()}${futuresPanel()}${fantasyTeamsPanel()}${fantasyPanel()}${fantasyScoringPanel()}${friendlyPanel()}${hubPanel()}${chatPanel()}${adminsPanel()}`;
  applyFolds();
  const f = app.querySelector('#p-filter');
  if (f && S.filter) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

// ---------------------------------------------------------------- folding

// Every panel can be folded away by tapping its heading, and each futures
// market inside the Futures panel too. What's open is remembered on this
// device. Out of the box only the everyday panels are open.
const FOLD_KEY = 'uosdarts:superFolds';
const OPEN_BY_DEFAULT = new Set(['Players', 'Friendlies to check']);
let FOLDS = {};
try { FOLDS = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') ?? {}; } catch { FOLDS = {}; }
const foldKey = h => (h.tagName === 'H3' ? 'market:' : '') + (h.dataset.fold ?? h.textContent.replace(/\s*\(\d+\)\s*$/, '').trim());

function applyFolds() {
  app.querySelectorAll('section.panel > h2, .fut-market > h3').forEach(h => {
    const key = foldKey(h);
    const open = key in FOLDS ? FOLDS[key] : (h.tagName === 'H2' && OPEN_BY_DEFAULT.has(key));
    h.classList.add('fold-head');
    h.setAttribute('role', 'button');
    h.setAttribute('aria-expanded', String(open));
    h.tabIndex = 0;
    h.parentElement.classList.toggle('folded', !open);
  });
}

function toggleFold(h) {
  const key = foldKey(h);
  const open = h.parentElement.classList.toggle('folded') === false;
  h.setAttribute('aria-expanded', String(open));
  FOLDS[key] = open;
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(FOLDS)); } catch { /* private mode */ }
}

app.addEventListener('click', e => {
  if (e.target.closest('button')) return;   // e.g. the ↑ ↓ buttons in a market heading
  const h = e.target.closest('.fold-head');
  if (h) toggleFold(h);
});
app.addEventListener('keydown', e => {
  const h = e.target.closest?.('.fold-head');
  if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleFold(h); }
});

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
  if (el.dataset.betvoid) {
    if (!confirm('Void this bet? The stake goes back and it shows as Bet void.')) return;
    await run(async () => check(await sb.rpc('super_void_bet', { p_bet: Number(el.dataset.betvoid) })), 'Bet void');
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
  if (el.dataset.linkfor !== undefined) {
    S.linkFor = el.dataset.linkfor || null;
    render();
    return;
  }
  if (el.dataset.linksave || el.dataset.linkquick) {
    const u = el.dataset.linksave || el.dataset.linkquick;
    const pid = el.dataset.linkquick ? el.dataset.player : (app.querySelector(`[data-linkpick="${u}"]`)?.value || null);
    S.linkFor = null;
    await run(async () => check(await sb.rpc('super_link_account', { p_user: u, p_player: pid })), pid ? 'Linked' : 'Unlinked');
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
  if (await boostsClick(el)) return;
  if (await futuresClick(el)) return;
  if (await fantasyClick(el)) return;
  if (await fantasyScoringClick(el)) return;
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
    case 'fm-create': {
      const title = val('#fm-new-title');
      if (!title) { toast('Give the market a title'); break; }
      const kind = val('#fm-new-kind');
      await run(async () => check(await sb.rpc('super_future_create', { p_title: title, p_category: Number(val('#fm-new-cat')), p_kind: kind })),
        `Created as a draft. Add the ${{ player: 'players', matchup: 'pairings' }[kind] ?? 'options'}.`);
      break;
    }
    case 'fc-create': {
      const name = val('#fc-new');
      if (!name) { toast('Name the category first'); break; }
      await run(async () => check(await sb.rpc('super_future_category', { p_id: null, p_name: name })), `${name} added`);
      break;
    }
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

async function fantasyScoringClick(el) {
  const box = el.closest('[data-fxs]');
  if (!box || !el.dataset.fxssave) return false;
  const pts = {};
  box.querySelectorAll('[data-fxs-pts]').forEach(i => {
    if (i.value.trim() !== '' && Number(i.value) !== Number(i.dataset.orig)) pts[i.dataset.fxsPts] = Math.round(Number(i.value));
  });
  if (!Object.keys(pts).length) { toast('Nothing changed'); return true; }
  if (!confirm('Save the scoring? Every week is rescored.')) return true;
  await run(async () => check(await sb.rpc('super_fantasy_set_scoring', { p_points: pts })), 'Scoring saved');
  return true;
}

async function fantasyClick(el) {
  const box = el.closest('[data-fx]');
  if (!box) return false;
  if (el.dataset.fxsugg) {
    let n = 0;
    box.querySelectorAll('[data-fx-price]').forEach(i => {
      if (!i.value.trim() && i.dataset.sugg) { i.value = i.dataset.sugg; i.classList.add('fut-changed'); n++; }
    });
    toast(n ? `Filled ${n}. Check them, then Save prices.` : 'Nothing empty to fill', !n);
    return true;
  }
  if (el.dataset.fxsave) {
    const prices = {};
    box.querySelectorAll('[data-fx-price]').forEach(i => {
      const v = i.value.trim();
      if (Number(v || NaN) !== Number(i.dataset.orig || NaN) && !(v === '' && i.dataset.orig === '')) prices[i.dataset.fxPrice] = v === '' ? null : Number(v);
    });
    if (!Object.keys(prices).length) { toast('No prices changed'); return true; }
    await run(async () => check(await sb.rpc('super_fantasy_set_prices', { p_prices: prices })),
      `${Object.keys(prices).length} price${Object.keys(prices).length === 1 ? '' : 's'} saved`);
    return true;
  }
  if (el.dataset.fxadd) {
    const pid = box.querySelector('[data-fx-add]').value;
    const v = Number(box.querySelector('[data-fx-addprice]').value);
    if (!pid || !v) { toast('Pick a player and give them a price'); return true; }
    await run(async () => check(await sb.rpc('super_fantasy_set_prices', { p_prices: { [pid]: v } })), 'Added');
    return true;
  }
  return false;
}

async function boostsClick(el) {
  const box = el.closest('[data-bx]');
  if (!box) return false;
  const q = sel => box.querySelector(sel);
  const id = box.dataset.bx === 'new' ? null : Number(box.dataset.bx);
  const b = S.boosts.find(x => x.id === id);
  if (el.dataset.bxsave != null) {
    const status = q('[data-bx-status]').value;
    if (status === 'open' && b?.status !== 'open' && !confirm('Open this superboost for betting?')) return true;
    const closes = q('[data-bx-closes]').value;
    const max = q('[data-bx-max]').value.trim();
    await run(async () => check(await sb.rpc('super_boost_save', {
      p_id: id, p_tournament: q('[data-bx-comp]').value || null, p_title: q('[data-bx-title]').value, p_detail: q('[data-bx-detail]').value,
      p_was: q('[data-bx-was]').value, p_price: q('[data-bx-price]').value, p_max: max ? Number(max) : null,
      p_status: status, p_closes_at: closes ? new Date(closes).toISOString() : null,
    })), id ? 'Superboost saved' : 'Superboost added');
    return true;
  }
  if (el.dataset.bxsettle != null) {
    const r = q('[data-bx-res]').value || null;
    const msg = r ? { won: `Settle as WON? ${b.bets} bet${b.bets === 1 ? '' : 's'} get paid.`, lost: 'Settle as lost?', void: 'Void it? Stakes go back.' }[r] : 'Unsettle it? Bets go back to open.';
    if (!confirm(msg)) return true;
    await run(async () => check(await sb.rpc('super_boost_settle', { p_boost: id, p_result: r })), 'Settled');
    return true;
  }
  if (el.dataset.bxdel != null) {
    if (!confirm('Delete this superboost? Nobody has bet on it.')) return true;
    await run(async () => check(await sb.rpc('super_boost_delete', { p_id: id })), 'Deleted');
    return true;
  }
  return false;
}

async function futuresClick(el) {
  if (el.dataset.fcmove || el.dataset.fmmove) {
    const what = el.dataset.fcmove ? 'category' : 'market';
    await run(async () => check(await sb.rpc('super_future_move', { p_what: what, p_id: Number(el.dataset.fcmove || el.dataset.fmmove), p_dir: Number(el.dataset.dir) })), 'Moved');
    return true;
  }
  if (el.dataset.fcsave) {
    const id = Number(el.dataset.fcsave);
    const name = document.querySelector(`[data-fc-name="${id}"]`).value.trim();
    await run(async () => check(await sb.rpc('super_future_category', { p_id: id, p_name: name })), 'Renamed');
    return true;
  }
  if (el.dataset.fcdel) {
    const c = S.futCats.find(x => x.id === Number(el.dataset.fcdel));
    if (!confirm(`Delete the "${c?.name}" category? It has no markets.`)) return true;
    await run(async () => check(await sb.rpc('super_future_category_delete', { p_id: c.id })), 'Category deleted');
    return true;
  }
  if (el.dataset.futsuggest) {
    await run(async () => check(await sb.rpc('super_future_suggest')), 'Suggestions updated');
    return true;
  }
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
      && !confirm(`Open "${market?.title}" for betting?`)) return true;
    const cat = Number(q('[data-fm-cat]')?.value) || null;
    await run(async () => {
      check(await sb.rpc('super_future_market', {
        p_market: mid, p_title: q('[data-fm-title]').value, p_rules: q('[data-fm-rules]').value,
        p_status: status, p_closes_at: closes ? new Date(closes).toISOString() : null,
      }));
      if (cat && cat !== market?.category_id) check(await sb.rpc('super_future_set_category', { p_market: mid, p_category: cat }));
    }, 'Market saved');
    return true;
  }
  if (el.dataset.futres) {
    const sid = Number(el.dataset.futres);
    const r = q(`[data-fs-res="${sid}"]`).value || null;
    const sel = market?.selections.find(x => x.id === sid);
    const what = r ? { won: 'a winner', lost: 'a loser', void: 'void (bets void, stakes back)' }[r] : 'unsettled (bets back to open)';
    if (!confirm(`Settle ${sel?.name ?? 'this'} as ${what}? (${sel?.bets ?? 0} bets)`)) return true;
    await run(async () => check(await sb.rpc('super_future_settle', { p_selection: sid, p_result: r })), 'Settled');
    return true;
  }
  if (el.dataset.futarrow) {
    const hide = el.dataset.hide === '1';
    await run(async () => check(await sb.rpc('super_future_hide_move', { p_selection: Number(el.dataset.futarrow), p_hide: hide })),
      hide ? 'Arrow hidden' : 'Arrow shown');
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
  if (el.dataset.futok) {
    await run(async () => check(await sb.rpc('super_future_approve', { p_selection: Number(el.dataset.futok) })), 'Price changed');
    return true;
  }
  if (el.dataset.futno) {
    await run(async () => check(await sb.rpc('super_future_reject', { p_selection: Number(el.dataset.futno) })), 'Suggestion dismissed');
    return true;
  }
  if (el.dataset.futapproveall) {
    if (!confirm(`Approve every suggested move in "${market?.title}"?`)) return true;
    await run(async () => check(await sb.rpc('super_future_approve_all', { p_market: mid })), 'Prices changed');
    return true;
  }
  if (el.dataset.spadd) {
    const name = q('[data-sp-name]').value.trim();
    if (!name) { toast('Type the option first'); return true; }
    await run(async () => check(await sb.rpc('super_special_add', { p_market: mid, p_name: name, p_price: q('[data-sp-price]').value.trim() || null })),
      `${name} added`);
    return true;
  }
  if (el.dataset.muadd) {
    const a = q('[data-mu-a]').value.trim(), b = q('[data-mu-b]').value.trim();
    if (!a || !b) { toast('Type both names'); return true; }
    await run(async () => check(await sb.rpc('super_matchup_add', {
      p_market: mid, p_a: a, p_a_price: q('[data-mu-ap]').value.trim() || null, p_b: b, p_b_price: q('[data-mu-bp]').value.trim() || null,
    })), `${a} v ${b} added`);
    return true;
  }
  if (el.dataset.murm) {
    if (!confirm('Remove this pairing?')) return true;
    await run(async () => check(await sb.rpc('super_matchup_remove', { p_market: mid, p_pair: Number(el.dataset.murm) })), 'Pairing removed');
    return true;
  }
  if (el.dataset.spdel) {
    if (!confirm(`Delete "${market?.title}"? Nobody has bet on it.`)) return true;
    await run(async () => check(await sb.rpc('super_special_delete', { p_market: mid })), 'Market deleted');
    return true;
  }
  if (el.dataset.futrest) {
    const left = market?.selections.filter(x => !x.result).length ?? 0;
    const as = el.dataset.as === 'void' ? 'void' : 'lost';
    const msg = as === 'void'
      ? `Void the other ${left} in "${market?.title}"? Their bets get their stakes back. Set any winners first.`
      : `Settle the other ${left} in "${market?.title}" as lost? Set winners and voids first.`;
    if (!confirm(msg)) return true;
    await run(async () => check(await sb.rpc('super_future_settle_rest', { p_market: mid, p_result: as })), 'Market settled');
    return true;
  }
  return false;
}

app.addEventListener('input', e => {
  if (e.target.dataset?.fxsPts !== undefined) {
    e.target.classList.toggle('fut-changed', e.target.value.trim() !== e.target.dataset.orig);
    return;
  }
  if (e.target.dataset?.fxPrice !== undefined) {
    e.target.classList.toggle('fut-changed', e.target.value.trim() !== e.target.dataset.orig);
    return;
  }
  if (e.target.dataset?.fsPrice !== undefined) {
    e.target.classList.toggle('fut-changed', e.target.value.trim() !== e.target.dataset.orig);
    return;
  }
  if (e.target.id === 'p-filter') { S.filter = e.target.value; redraw(e.target, playersPanel); }
  if (e.target.id === 'bet-q') { S.betQ = e.target.value; redraw(e.target, allBetsPanel); }
  if (e.target.id === 'acc-q') { S.accQ = e.target.value; redraw(e.target, accountsPanel); }
});

// Typing in a search box redraws only that panel, not the whole page.
function redraw(input, panel) {
  const id = input.id;
  const section = input.closest('section.panel');
  if (!section) { render(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = panel();
  const fresh = tmp.firstElementChild;
  section.replaceWith(fresh);
  applyFolds();
  const box = app.querySelector(`#${id}`);
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

async function load() {
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}

load();
