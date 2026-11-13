import { sb, showLoadError, esc, toast, fmtDate, matchLabel, MATCH_SELECT } from '../db.js';
import { roundRobin, allocateGroups, buildBracket, standings, bracketPlan } from '../fixtures.js';

const app = document.getElementById('app');
const S = { players: [], tournaments: [], sel: null, entrants: [], matches: [], entrantsOpen: false, advOpen: false, picked: null, archiveOpen: false, pcsAll: false, editMatch: null,
  newLegs: { group: null, ko: {} },   // advanced settings on the create form
  editLegs: null };                   // advanced settings on the manage panel

const check = r => { if (r.error) throw r.error; return r.data; };

// ---------------------------------------------------------------- auth

async function initInner() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) return renderLogin(!!session?.user?.is_anonymous);
  const { data } = await sb.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
  if (!data) {
    app.innerHTML = `<div class="panel"><p>Signed in as ${esc(session.user.email)}, but this account isn't an admin.</p>
      <p class="muted">Add this user id to the admins table: <code>${session.user.id}</code></p>
      <div class="row"><a href="/">Back to the public site</a><button id="signout-2">Sign in as someone else</button></div></div>`;
    document.getElementById('signout-2').addEventListener('click', async () => {
      await sb.auth.signOut();
      location.reload();
    });
    return;
  }
  await refresh();
}

function renderLogin(asScorer = false) {
  app.innerHTML = `<form class="panel narrow" data-form="login">
    <h2>Committee sign in</h2>
    ${asScorer ? '<p class="muted small">You are currently signed in as a scorer. Signing in here will end that, so hand over any match you are scoring first.</p>' : ''}
    <label>Email <input name="email" type="email" required></label>
    <label>Password <input name="password" type="password" required></label>
    <button class="primary">Sign in</button>
    <a href="/" class="muted small">Back to the public site</a>
  </form>`;
}

async function signOut() {
  await sb.auth.signOut();
  location.reload();
}

// ---------------------------------------------------------------- data

async function refresh() {
  S.players = check(await sb.from('players').select('*').order('name'));
  S.tournaments = check(await sb.from('tournaments')
    .select('*, champion:players!tournaments_champion_id_fkey(id,name)')
    .order('starts_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false }));
  if (S.sel) {
    S.sel = S.tournaments.find(t => t.id === S.sel.id) ?? null;
  }
  if (S.sel) {
    S.entrants = check(await sb.from('tournament_players').select('*, players(id,name)').eq('tournament_id', S.sel.id));
    S.matches = check(await sb.from('matches').select(MATCH_SELECT).eq('tournament_id', S.sel.id)
      .order('stage').order('round').order('slot'));
  }
  render();
}

// ---------------------------------------------------------------- advanced settings

// How many players reach the knockout. For groups that's the qualifiers,
// not the whole entry list.
function koFieldSize(format, players, groupCount, advancePerGroup) {
  if (format === 'groups_knockout') return Math.max(0, groupCount * advancePerGroup);
  return players;
}

const PLURALS = { match: 'matches' };
function plural(n, word) {
  return `${n} ${n === 1 ? word : (PLURALS[word] ?? word + 's')}`;
}

const REACH_LABELS = [
  ['winner', 'Winner'], ['final', 'Runner-up'], ['semi', 'Semi-final'],
  ['quarter', 'Quarter-final'], ['last_16', 'Last 16'], ['last_32', 'Last 32'],
  ['last_64', 'Last 64'], ['groups', 'Group stage only'],
];

const PC_SCHEDULE = { winner: 1000, final: 700, semi: 400, quarter: 300, last_16: 200, last_32: 100, last_64: 50, groups: 0 };

// Order of merit points for one tournament, by how far a player got.
function pointsPanel(t) {
  const sched = { ...PC_SCHEDULE, ...(t?.points_schedule ?? {}) };
  const isNew = !t;
  return `<div class="oom-box">
    <label class="chk">
      <input type="checkbox" data-oom-counts ${isNew || t.counts_for_oom ? 'checked' : ''}>
      Counts towards the order of merit
    </label>
    <label class="chk">
      <input type="checkbox" data-oom-major ${t?.is_major ? 'checked' : ''}>
      Major (counts towards Major Best and Major Wins on player profiles)
    </label>
    ${t?.is_pc ? `<p class="muted small">Weekly PC ${t.pc_number ?? ''}: also counts towards the PC order of merit.</p>` : ''}
    <table class="points-plan">
      <thead><tr><th>Reached</th><th>Points</th></tr></thead>
      <tbody>${REACH_LABELS.map(([k, label]) => `<tr>
        <td>${label}</td>
        <td><input type="number" min="0" step="50" data-pts="${k}" value="${sched[k] ?? 0}"></td>
      </tr>`).join('')}</tbody>
    </table>
    ${isNew ? '<p class="muted small">Saved with the tournament when you press Create.</p>'
      : `<div class="row">
          <span class="muted small">Applied when you award points for this tournament.</span>
          <button data-act="save-points" class="primary">Save points</button>
        </div>`}
  </div>`;
}

// opts: { format, players, groupCount, advancePerGroup, legs, koDefault, groupDefault, idPrefix, countLabel }
function advBody(opts) {
  const { format, players, groupCount, advancePerGroup, legs, koDefault, groupDefault, countLabel } = opts;
  const size = koFieldSize(format, players, groupCount, advancePerGroup);
  const plan = bracketPlan(size);

  const groupRow = format === 'groups_knockout'
    ? `<tr><td>Group matches</td><td class="muted">${plural(groupCount, 'group')}, ${plural(advancePerGroup, 'qualifier')} each</td>
         <td><input type="number" min="1" data-legs="group" value="${legs.group ?? groupDefault}"></td></tr>`
    : '';

  if (!plan.length) {
    return `<p class="muted">${countLabel}. Add at least 2 players to see the rounds.</p>
      <table class="legs-plan"><tbody>${groupRow}</tbody></table>`;
  }

  return `<p class="muted">${countLabel}${format === 'groups_knockout'
      ? `, so ${size} reach the knockout` : ''}.</p>
    <table class="legs-plan">
      <thead><tr><th>Round</th><th>Matches</th><th>Legs to win</th></tr></thead>
      <tbody>
        ${plan.map(r => `<tr${r.isPrelim ? ' class="prelim"' : ''}>
          <td>${r.name}${r.isPrelim ? ' <span class="tag">preliminary round</span>' : ''}</td>
          <td class="muted">${r.isPrelim
            ? `${plural(r.contested, 'match')}, ${plural(r.byes, 'bye')}`
            : plural(r.slots, 'match')}</td>
          <td><input type="number" min="1" data-legs="${r.fromEnd}" value="${legs.ko?.[r.fromEnd] ?? koDefault}"></td>
        </tr>`).join('')}
        ${groupRow}
      </tbody></table>`;
}

function legsFrom(elId) {
  const el = document.getElementById(elId);
  return el ? collectLegs(el) : {};
}

// Reads the numbers currently on screen into the round_legs shape.
function collectLegs(scope) {
  const out = { ko: {} };
  scope.querySelectorAll('[data-legs]').forEach(i => {
    const v = parseInt(i.value, 10);
    if (!v || v < 1) return;
    if (i.dataset.legs === 'group') out.group = v;
    else out.ko[i.dataset.legs] = v;
  });
  return out;
}

// Reads the order of merit controls on the create form.
function createFlags() {
  const box = app.querySelector('[data-form="tournament"] .oom-box');
  if (!box) return {};
  const sched = {};
  box.querySelectorAll('[data-pts]').forEach(i => { sched[i.dataset.pts] = parseInt(i.value, 10) || 0; });
  return {
    points_schedule: sched,
    counts_for_oom: box.querySelector('[data-oom-counts]').checked,
    is_major: box.querySelector('[data-oom-major]').checked,
  };
}

function createFormOpts() {
  const f = app.querySelector('[data-form="tournament"]');
  if (!f) return null;
  const num = n => parseInt(f.querySelector(`[name=${n}]`).value, 10) || 0;
  const players = S.players.length;
  return {
    format: f.querySelector('[name=format]').value,
    players,
    groupCount: num('group_count'),
    advancePerGroup: num('advance_per_group'),
    legs: S.newLegs,
    koDefault: num('knockout_legs_to_win') || 3,
    groupDefault: num('group_legs_to_win') || 2,
    countLabel: `${plural(players, 'player')} on the list, and everyone plays by default`,
  };
}

function refreshCreateAdv() {
  const box = document.getElementById('adv-create');
  const opts = createFormOpts();
  if (box && opts) box.innerHTML = advBody(opts);
}

// ---------------------------------------------------------------- rendering

// The order of merit pages render a CSV at build time so the table is never
// blank. These download a fresh copy of that fallback to commit to the repo.
function snapshotSection() {
  return `<section class="panel"><h2>Published fallback</h2>
    <p class="muted small">The order of merit pages show live points. These files are what they fall back on
      before the live data arrives, or if Supabase is unreachable. Download them, drop them in
      <code>assets/data/</code> and push.</p>
    <div class="row">
      <button data-act="snap-main">Download rankings.csv</button>
      <button data-act="snap-pc">Download pc-rankings.csv</button>
    </div>
  </section>`;
}

async function downloadSnapshot(pcOnly) {
  const { data, error } = await sb.rpc('oom_table', { p_season: '2026/27', p_pc_only: pcOnly });
  if (error) throw error;
  const esc = v => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
  const csv = ['player_name,total_points']
    .concat(data.map(r => `${esc(r.player_name)},${Number(r.total_points)}`))
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = pcOnly ? 'pc-rankings.csv' : 'rankings.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function playersSection() {
  return `<section class="panel"><h2>Players (${S.players.length})</h2>
    <form data-form="player" class="inline">
      <input name="name" placeholder="Player name" required>
      <button class="primary">Add</button>
    </form>
    <div class="chips">${S.players.map(p => `<span class="chip">${esc(p.name)}</span>`).join('')}</div>
  </section>`;
}

function newTournamentSection() {
  return `<section class="panel"><h2>New tournament</h2>
    <form data-form="tournament" class="grid-form">
      <label>Name <input name="name" required></label>
      <label>Start <input name="starts_at" type="datetime-local"></label>
      <label>Format
        <select name="format">
          <option value="knockout">Straight knockout</option>
          <option value="groups_knockout">Groups into a knockout</option>
        </select></label>
      <label>Starting score <input name="start_score" type="number" value="501" min="101" step="100"></label>
      <label class="groups-only" hidden>Number of groups <input name="group_count" type="number" value="2" min="1"></label>
      <label class="groups-only" hidden>Qualifiers per group <input name="advance_per_group" type="number" value="2" min="1"></label>
      <label class="groups-only" hidden>Group legs to win <input name="group_legs_to_win" type="number" value="2" min="1"></label>
      <label>Knockout legs to win <input name="knockout_legs_to_win" type="number" value="3" min="1"></label>
      <label>Scoring password <input name="scoring_password" type="text" autocomplete="off" placeholder="Leave blank for none"></label>
      <details class="adv-box" ${S.advOpen ? 'open' : ''}>
        <summary>Advanced settings: legs per round, order of merit points, major</summary>
        <div class="adv-body">
          ${pointsPanel(null)}
          <hr>
          <div id="adv-create"></div>
        </div>
      </details>
      <button class="primary">Create</button>
    </form>
  </section>`;
}

function tournamentsSection() {
  const pcs = S.tournaments.filter(t => t.is_pc);
  const other = S.tournaments.filter(t => !t.is_pc);
  const live = other.filter(t => t.status === 'live').concat(pcs.filter(t => t.status === 'live'));
  const upcoming = other.filter(t => t.status === 'upcoming');
  const done = S.tournaments.filter(t => t.status === 'complete');

  const row = t => {
    const champ = t.champion?.name;
    return `<div class="t-row${S.sel?.id === t.id ? ' current' : ''}">
      <span class="t-row-main">
        <b>${esc(t.name)}</b>
        <span class="muted small">${fmtDate(t.starts_at)}${champ ? ` · won by ${esc(champ)}` : ''}</span>
      </span>
      <button data-manage="${t.id}">${S.sel?.id === t.id ? 'Managing' : 'Manage'}</button>
    </div>`;
  };

  return `
    ${live.length ? `<section class="panel live-panel">
      <h2>Running now</h2>
      ${live.map(row).join('')}
    </section>` : ''}

    ${pcSection(pcs)}

    <section class="panel">
      <h2>Other tournaments</h2>
      ${upcoming.length ? upcoming.map(row).join('') : '<p class="muted">Nothing else scheduled.</p>'}
      ${done.length ? `<details class="archive-box" ${S.archiveOpen ? 'open' : ''}>
        <summary>Archive <span class="count">${done.length}</span></summary>
        <div class="archive-body">${done.map(row).join('')}</div>
      </details>` : ''}
    </section>`;
}

// The weekly Monday fixtures. Numbers follow date order and are maintained
// by the database, so moving or cancelling one reshuffles the rest.
function pcSection(pcs) {
  const future = pcs.filter(t => t.status !== 'complete')
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const shown = S.pcsAll ? future : future.slice(0, 6);

  const row = t => {
    const cancelled = t.status === 'cancelled';
    const local = t.starts_at ? new Date(t.starts_at) : null;
    const value = local ? new Date(local.getTime() - local.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16) : '';
    return `<div class="t-row pc-row${cancelled ? ' cancelled' : ''}${S.sel?.id === t.id ? ' current' : ''}">
      <span class="pc-num">${cancelled ? '—' : (t.pc_number ?? '?')}</span>
      <span class="t-row-main">
        <b>${esc(cancelled ? 'Cancelled' : t.name)}</b>
        <span class="muted small">${fmtDate(t.starts_at)}${t.status === 'live' ? ' · live' : ''}</span>
      </span>
      <input type="datetime-local" data-move="${t.id}" value="${value}" title="Move this fixture">
      <button data-cancel="${t.id}" data-to="${cancelled ? 'false' : 'true'}">${cancelled ? 'Restore' : 'Cancel'}</button>
      <button data-manage="${t.id}">${S.sel?.id === t.id ? 'Managing' : 'Manage'}</button>
    </div>`;
  };

  return `<section class="panel pc-panel">
    <h2>Weekly PCs</h2>
    ${shown.length ? shown.map(row).join('')
      : '<p class="muted">No fixtures scheduled yet.</p>'}
    <div class="row">
      <span class="muted small">${future.length} scheduled. Mondays at 7pm; numbers follow the date order.</span>
      ${future.length > 6 ? `<button data-act="pcs-toggle">${S.pcsAll ? 'Show fewer' : `Show all ${future.length}`}</button>` : ''}
      <button data-act="schedule-pcs">Schedule more weeks</button>
    </div>
  </section>`;
}

function manageSection() {
  const t = S.sel;
  if (!t) return '';
  const hasFixtures = S.matches.length > 0;
  const groupMatches = S.matches.filter(m => m.stage === 'group');
  const koMatches = S.matches.filter(m => m.stage === 'knockout');
  const koRounds = Math.max(0, ...koMatches.map(m => m.round));
  const canDrawKo = t.format === 'groups_knockout' && groupMatches.length > 0 &&
    groupMatches.every(m => m.status === 'complete') && koMatches.length === 0;
  // Starts empty: players are added by name rather than unticked from everyone.
  const picked = S.picked ?? S.entrants.map(e => ({ player_id: e.player_id, seed: e.seed }));

  return `<section class="panel manage">
    <h2>${esc(t.name)}${t.is_pc && !/^PC \d+$/.test(t.name) ? ` <span class="tag">PC ${t.pc_number ?? '–'}</span>` : ''}</h2>
    <div class="row">
      <label>Status
        <select data-status>
          ${['upcoming', 'live', 'complete', 'cancelled'].map(x =>
            `<option ${t.status === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select></label>
      <a href="/tournament/?id=${t.id}" target="_blank">Open public page</a>
    </div>

    <div class="row pw-row">
      <label>Scoring password
        <input type="text" id="pw-set" autocomplete="off" placeholder="${t.requires_password ? 'Set: type to change' : 'None: anyone can score'}">
      </label>
      <span class="muted small">Scorers type this once before their first match.</span>
      <button data-act="set-pw" class="primary">Save password</button>
      ${t.requires_password ? '<button data-act="clear-pw">Remove</button>' : ''}
    </div>

    ${hasFixtures ? '' : `
      <div class="entrant-box">
        <div class="entrant-head">
          <b>Players in this tournament</b><span class="count">${picked.length}</span>
        </div>
        <div class="entrant-body">
          <div class="player-add">
            <input type="text" id="player-search" list="player-options" autocomplete="off"
                   placeholder="Type a name, then press Enter">
            <datalist id="player-options">
              ${S.players.filter(p => !picked.some(x => x.player_id === p.id))
                .map(p => `<option value="${esc(p.name)}"></option>`).join('')}
            </datalist>
            <button data-act="add-entrant" class="primary">Add</button>
          </div>
          <p class="muted small">Suggests from the ${S.players.length} players on file. A name that isn't on the list can be added as a new profile.</p>

          ${picked.length ? `<div class="picked">${picked.map(e => {
            const pl = S.players.find(x => x.id === e.player_id);
            return `<div class="picked-row">
              <span class="picked-name">${esc(pl?.name ?? 'Unknown')}</span>
              <input type="number" min="1" placeholder="seed" data-seed="${e.player_id}" value="${e.seed ?? ''}">
              <button data-drop="${e.player_id}" title="Remove">&times;</button>
            </div>`;
          }).join('')}</div>` : '<p class="muted">No players added yet.</p>'}

          <div class="row">
            <span class="muted small">Seeds are optional; 1 is the top seed, anyone without one is drawn at random.</span>
            <button data-act="save-entrants">Save selection</button>
          </div>
        </div>
      </div>`}

    <details class="adv-box" ${S.advOpen ? 'open' : ''}>
      <summary>Advanced settings</summary>
      <div class="adv-body" id="adv-manage">
        ${pointsPanel(t)}
        ${hasFixtures ? '' : `<hr>${advBody({
          format: t.format,
          players: picked.length,
          groupCount: t.group_count,
          advancePerGroup: t.advance_per_group,
          legs: S.editLegs ?? t.round_legs ?? {},
          koDefault: t.knockout_legs_to_win,
          groupDefault: t.group_legs_to_win,
          countLabel: `${plural(picked.length, 'player')} added`,
        })}`}
      </div>
    </details>

    ${hasFixtures ? '' : `<div class="row">
      <span class="muted">${picked.length < 2 ? 'Add at least 2 players.' : `Ready to draw with ${picked.length} players.`}</span>
      <button data-act="draw" class="primary" ${picked.length < 2 ? 'disabled' : ''}>Draw fixtures</button>
    </div>`}

    ${canDrawKo ? '<div class="row"><button data-act="draw-ko" class="primary">Group stage done: draw knockout</button></div>' : ''}

    ${hasFixtures ? `<h3>Matches</h3>
      <table class="admin-matches"><thead><tr><th>Match</th><th>Players</th><th>Legs</th><th>Status</th><th>Board</th><th>Scorer</th><th>Result</th></tr></thead>
      <tbody>${S.matches.map(m => matchRow(m, koRounds)).join('')}</tbody></table>
      <div class="row danger"><button data-act="reset">Delete all fixtures</button></div>` : ''}

    ${finishBlock()}

    <div class="row danger"><button data-act="delete">Delete tournament</button></div>
  </section>`;
}

function matchRow(m, koRounds) {
  const editing = S.editMatch === m.id;
  const main = `<tr${editing ? ' class="editing"' : ''}>
    <td>${esc(matchLabel(m, koRounds))}</td>
    <td><a href="/match/?id=${m.id}" target="_blank">${esc(m.p1?.name ?? 'TBC')} v ${esc(m.p2?.name ?? 'TBC')}</a></td>
    <td>${m.p1_legs}–${m.p2_legs}</td>
    <td>${m.status}</td>
    <td><input class="board" data-board="${m.id}" value="${esc(m.board ?? '')}" size="3"></td>
    <td>${m.scorer_id ? `<button data-release="${m.id}">Release</button>` : '<span class="muted">none</span>'}</td>
    <td><button data-edit="${m.id}">${editing ? 'Close' : 'Set'}</button></td>
  </tr>`;
  if (!editing) return main;

  const canEdit = m.player1_id && m.player2_id;
  return main + `<tr class="edit-row"><td colspan="7">
    ${canEdit ? `<div class="result-edit">
      <label>${esc(m.p1.name)} legs <input type="number" min="0" data-rlegs="1" value="${m.p1_legs}"></label>
      <label>${esc(m.p2.name)} legs <input type="number" min="0" data-rlegs="2" value="${m.p2_legs}"></label>
      <label>Winner
        <select data-rwinner>
          <option value="1" ${m.winner_id === m.player1_id ? 'selected' : ''}>${esc(m.p1.name)}</option>
          <option value="2" ${m.winner_id === m.player2_id ? 'selected' : ''}>${esc(m.p2.name)}</option>
          <option value="" ${!m.winner_id ? 'selected' : ''}>No winner</option>
        </select></label>
      <button data-setresult="${m.id}" class="primary">Save result</button>
      <button data-reopen="${m.id}">Reopen match</button>
      <p class="muted small">For forfeits, set the legs to the walkover score (for example 3–0) and pick the winner.
        Reopening wipes every dart recorded for this match.</p>
    </div>` : '<p class="muted">Both players need to be decided first.</p>'}
  </td></tr>`;
}

// Works out who won, so the admin only has to confirm it.
function likelyChampion() {
  const ko = S.matches.filter(m => m.stage === 'knockout');
  if (ko.length) {
    const last = Math.max(...ko.map(m => m.round));
    const final = ko.find(m => m.round === last && m.status === 'complete');
    if (final?.winner_id) return final.winner_id;
    return null;
  }
  const labels = [...new Set(S.entrants.map(e => e.group_label).filter(Boolean))].sort();
  if (labels.length === 1) {
    const table = standings(
      S.entrants.filter(e => e.group_label === labels[0]).map(e => e.players),
      S.matches.filter(m => m.stage === 'group'),
    );
    return table[0]?.id ?? null;
  }
  return null;
}

function finishBlock() {
  const t = S.sel;
  if (!S.matches.length) return '';

  if (t.status === 'complete') {
    const champ = S.entrants.find(e => e.player_id === t.champion_id)?.players?.name;
    return `<div class="row finished">
      <span>Finished${champ ? `. Winner: <b>${esc(champ)}</b>` : ', no winner recorded'}</span>
      <button data-act="unfinish">Reopen tournament</button>
    </div>
    <div class="row oom-award">
      <span class="muted small">${t.counts_for_oom
        ? `Awards points as <b>${esc(t.is_pc && t.pc_number ? 'pc' + t.pc_number : 'the tournament name')}</b>. Safe to run again after fixing a result.`
        : 'This tournament is set not to count towards the order of merit.'}</span>
      <button data-act="award" class="primary" ${t.counts_for_oom ? '' : 'disabled'}>Award order of merit points</button>
      <button data-act="clear-points">Remove its points</button>
    </div>`;
  }

  const left = S.matches.filter(m => m.status !== 'complete' && m.player1_id && m.player2_id).length;
  const guess = likelyChampion();
  return `<div class="row finish-box">
    <label>Winner
      <select data-champion>
        <option value="">Not set</option>
        ${S.entrants.map(e => `<option value="${e.player_id}" ${guess === e.player_id ? 'selected' : ''}>${esc(e.players.name)}</option>`).join('')}
      </select></label>
    <span class="muted">${left ? `${left} match${left > 1 ? 'es' : ''} still to play.` : 'All matches are done.'}</span>
    <button data-act="finish" class="primary">Confirm finished</button>
  </div>`;
}

function render() {
  app.innerHTML = `<div class="admin-head"><h1>Admin</h1><button data-act="signout" class="link">Sign out</button></div>${manageSection()}${tournamentsSection()}${newTournamentSection()}${playersSection()}${snapshotSection()}`;
  const form = app.querySelector('[data-form="tournament"]');
  if (form) syncFormatFields(form);
  refreshCreateAdv();
}

// ---------------------------------------------------------------- entrants

// Reads the tick boxes on screen. If the panel isn't rendered, everyone plays.
async function saveEntrants(t) {
  syncSeeds();
  const rows = (S.picked ?? S.entrants.map(e => ({ player_id: e.player_id, seed: e.seed })))
    .map(e => ({ tournament_id: t.id, player_id: e.player_id, seed: e.seed ?? null }));
  if (rows.length < 2) throw new Error('Add at least 2 players');
  check(await sb.from('tournament_players').delete().eq('tournament_id', t.id));
  check(await sb.from('tournament_players').insert(rows));
}

// Seeds live in the inputs until something needs them.
function syncSeeds() {
  if (!S.picked) return;
  app.querySelectorAll('[data-seed]').forEach(i => {
    const row = S.picked.find(e => e.player_id === i.dataset.seed);
    if (row) row.seed = parseInt(i.value, 10) || null;
  });
}

function currentPicked() {
  if (!S.picked) S.picked = S.entrants.map(e => ({ player_id: e.player_id, seed: e.seed }));
  return S.picked;
}

// Adds whoever is typed in the search box, creating the player if the name
// isn't one of the ones already on file.
async function addEntrant() {
  const input = app.querySelector('#player-search');
  const name = (input?.value ?? '').trim();
  if (!name) return;
  syncSeeds();

  const match = S.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  let id = match?.id;

  if (!id) {
    if (!confirm(`"${name}" isn't on the player list. Create a profile for them?`)) return;
    id = check(await sb.rpc('admin_add_player', { p_name: name }));
    S.players = check(await sb.from('players').select('*').order('name'));
  }
  const picked = currentPicked();
  if (picked.some(e => e.player_id === id)) {
    toast(`${name} is already in this tournament`);
    return;
  }
  picked.push({ player_id: id, seed: null });
  render();
  app.querySelector('#player-search')?.focus();
}

async function refreshSelection(t) {
  S.entrants = check(await sb.from('tournament_players').select('*, players(id,name)').eq('tournament_id', t.id));
}

// ---------------------------------------------------------------- fixture drawing

function orderedEntrantIds() {
  const seeded = S.entrants.filter(e => e.seed != null).sort((a, b) => a.seed - b.seed);
  const unseeded = S.entrants.filter(e => e.seed == null)
    .map(e => [Math.random(), e]).sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  return [...seeded, ...unseeded].map(e => e.player_id);
}

async function insertBracket(t, seededIds) {
  const { rows, rounds } = buildBracket(seededIds, {
    tournament_id: t.id, legs_to_win: t.knockout_legs_to_win, start_score: t.start_score,
  });
  // Per-round overrides from advanced settings, default for anything not set.
  // Keys count back from the final: 0 is the final, 1 the semi-finals.
  const perRound = t.round_legs?.ko ?? {};
  for (const r of rows) r.legs_to_win = perRound[rounds - r.round] ?? t.knockout_legs_to_win;
  // Insert later rounds first so next_match_id always points at an existing row
  for (let r = rounds; r >= 1; r--) {
    check(await sb.from('matches').insert(rows.filter(x => x.round === r)));
  }
  // Byes: a first-round match with one player is won automatically (the trigger advances them)
  for (const m of rows.filter(x => x.round === 1 && (!x.player1_id || !x.player2_id))) {
    check(await sb.from('matches').update({
      status: 'complete', winner_id: m.player1_id ?? m.player2_id, finished_at: new Date().toISOString(),
    }).eq('id', m.id));
  }
}

async function drawFixtures() {
  const t = S.sel;
  const ids = orderedEntrantIds();
  if (t.format === 'knockout') return insertBracket(t, ids);

  const groups = allocateGroups(ids, Math.min(t.group_count, Math.floor(ids.length / 2) || 1));
  const rows = [];
  for (const [gi, g] of groups.entries()) {
    const label = String.fromCharCode(65 + gi);
    check(await sb.from('tournament_players').update({ group_label: label })
      .eq('tournament_id', t.id).in('player_id', g));
    roundRobin(g).forEach((pairs, r) => pairs.forEach(([a, b], s) => rows.push({
      tournament_id: t.id, stage: 'group', group_label: label, round: r + 1, slot: s + 1,
      player1_id: a, player2_id: b,
      legs_to_win: t.round_legs?.group ?? t.group_legs_to_win,
      start_score: t.start_score,
    })));
  }
  check(await sb.from('matches').insert(rows));
}

async function drawKnockoutFromGroups() {
  const t = S.sel;
  const labels = [...new Set(S.entrants.map(e => e.group_label).filter(Boolean))].sort();
  const tables = labels.map(g => standings(
    S.entrants.filter(e => e.group_label === g).map(e => e.players),
    S.matches.filter(m => m.stage === 'group' && m.group_label === g),
  ));
  // Seed group winners first (A1, B1, ...), then runners-up, so groupmates avoid each other early
  const qualifiers = [];
  for (let pos = 0; pos < t.advance_per_group; pos++) {
    for (const tb of tables) if (tb[pos]) qualifiers.push(tb[pos].id);
  }
  await insertBracket(t, qualifiers);
}

// ---------------------------------------------------------------- events

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg, false);
  } catch (e) {
    toast(e.message);
  }
  await refresh();
}

app.addEventListener('keydown', async e => {
  if (e.target.id === 'player-search' && e.key === 'Enter') {
    e.preventDefault();
    await run(addEntrant);
  }
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const data = Object.fromEntries(new FormData(f));
  const kind = f.dataset.form;

  if (kind === 'login') {
    const { error } = await sb.auth.signInWithPassword({ email: data.email, password: data.password });
    if (error) toast(error.message); else init();
    return;
  }
  if (kind === 'player') {
    await run(async () => check(await sb.from('players').insert({ name: data.name.trim() })));
    return;
  }
  if (kind === 'tournament') {
    await run(async () => {
      const row = check(await sb.from('tournaments').insert({
        name: data.name.trim(),
        format: data.format,
        starts_at: data.starts_at ? new Date(data.starts_at).toISOString() : null,
        start_score: Number(data.start_score),
        group_count: Number(data.group_count),
        advance_per_group: Number(data.advance_per_group),
        group_legs_to_win: Number(data.group_legs_to_win),
        knockout_legs_to_win: Number(data.knockout_legs_to_win),
        round_legs: legsFrom('adv-create'),
        ...createFlags(),
      }).select().single());
      if (data.scoring_password?.trim()) {
        check(await sb.rpc('admin_set_scoring_password', {
          p_tournament: row.id, p_password: data.scoring_password.trim(),
        }));
      }
      S.sel = row;
      S.picked = [];
      S.newLegs = { group: null, ko: {} };
    }, 'Tournament created');
  }
});

app.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el || el.closest('form')) return;
  const t = S.sel;

  if (el.dataset.manage) {
    S.sel = S.tournaments.find(x => x.id === el.dataset.manage);
    S.picked = null;   // rebuilt from whatever that tournament already has
    await refresh();
    return;
  }
  if (el.dataset.release) {
    await run(async () => check(await sb.rpc('release_match', { p_match: el.dataset.release })), 'Scorer released');
    return;
  }
  if (el.dataset.drop) {
    syncSeeds();
    S.picked = currentPicked().filter(e => e.player_id !== el.dataset.drop);
    render();
    return;
  }
  if (el.dataset.cancel) {
    const to = el.dataset.to === 'true';
    if (to && !confirm('Cancel this fixture? The ones after it will move up a number.')) return;
    await run(async () => check(await sb.rpc('admin_set_cancelled', {
      p_tournament: el.dataset.cancel, p_cancelled: to,
    })), to ? 'Fixture cancelled' : 'Fixture restored');
    return;
  }
  if (el.dataset.edit) {
    S.editMatch = S.editMatch === el.dataset.edit ? null : el.dataset.edit;
    render();
    return;
  }
  if (el.dataset.setresult) {
    const box = el.closest('.result-edit');
    const legs = n => parseInt(box.querySelector(`[data-rlegs="${n}"]`).value, 10) || 0;
    const w = box.querySelector('[data-rwinner]').value;
    await run(async () => {
      check(await sb.rpc('admin_set_result', {
        p_match: el.dataset.setresult,
        p_p1_legs: legs(1),
        p_p2_legs: legs(2),
        p_winner: w === '' ? null : Number(w),
      }));
      S.editMatch = null;
    }, 'Result saved');
    return;
  }
  if (el.dataset.reopen) {
    if (confirm('Reopen this match? Every dart recorded for it will be deleted.')) {
      await run(async () => {
        check(await sb.rpc('admin_reopen_match', { p_match: el.dataset.reopen }));
        S.editMatch = null;
      }, 'Match reopened');
    }
    return;
  }

  switch (el.dataset.act) {
    case 'add-entrant':
      await run(addEntrant);
      break;
    case 'save-entrants':
      await run(() => saveEntrants(t), 'Selection saved');
      break;
    case 'draw':
      if (confirm('Draw fixtures now? This locks in who is playing.')) {
        await run(async () => {
          await saveEntrants(t);   // whatever is ticked on screen, including the default of everyone
          const legs = S.editLegs ?? legsFrom('adv-manage');
          check(await sb.from('tournaments').update({ round_legs: legs }).eq('id', t.id));
          S.editLegs = null;
          await refreshSelection(t);
          S.sel = check(await sb.from('tournaments').select('*').eq('id', t.id).single());
          await drawFixtures();
        }, 'Fixtures drawn');
      }
      break;
    case 'draw-ko':
      await run(drawKnockoutFromGroups, 'Knockout drawn');
      break;
    case 'set-pw': {
      const v = app.querySelector('#pw-set')?.value.trim() ?? '';
      if (!v) { toast('Type a password first, or press Remove'); break; }
      await run(async () => check(await sb.rpc('admin_set_scoring_password', {
        p_tournament: t.id, p_password: v,
      })), 'Password saved');
      break;
    }
    case 'clear-pw':
      if (confirm('Remove the password? Anyone will be able to score this tournament.')) {
        await run(async () => check(await sb.rpc('admin_set_scoring_password', {
          p_tournament: t.id, p_password: null,
        })), 'Password removed');
      }
      break;
    case 'signout':
      await signOut();
      break;
    case 'snap-main':
      await run(() => downloadSnapshot(false), 'rankings.csv downloaded');
      break;
    case 'snap-pc':
      await run(() => downloadSnapshot(true), 'pc-rankings.csv downloaded');
      break;
    case 'pcs-toggle':
      S.pcsAll = !S.pcsAll;
      render();
      break;
    case 'schedule-pcs': {
      const weeks = parseInt(prompt('How many more weeks of Monday PCs?', '12'), 10);
      if (!weeks || weeks < 1) break;
      await run(async () => {
        const added = check(await sb.rpc('admin_schedule_pcs', { p_weeks: weeks }));
        toast(added ? `${added} fixture${added > 1 ? 's' : ''} added` : 'Those weeks already have fixtures', false);
      });
      break;
    }
    case 'save-points': {
      const box = app.querySelector('.oom-box');
      const sched = {};
      box.querySelectorAll('[data-pts]').forEach(i => {
        sched[i.dataset.pts] = parseInt(i.value, 10) || 0;
      });
      await run(async () => check(await sb.from('tournaments').update({
        points_schedule: sched,
        counts_for_oom: box.querySelector('[data-oom-counts]').checked,
        is_major: box.querySelector('[data-oom-major]').checked,
      }).eq('id', t.id)), 'Points saved');
      break;
    }
    case 'award':
      await run(async () => {
        const n = check(await sb.rpc('admin_award_tournament', { p_tournament: t.id }));
        toast(`Points awarded to ${n} player${n === 1 ? '' : 's'}`, false);
      });
      break;
    case 'clear-points':
      if (confirm('Remove this tournament\'s order of merit points?')) {
        await run(async () => check(await sb.rpc('admin_clear_points', { p_tournament: t.id })), 'Points removed');
      }
      break;
    case 'finish': {
      const champ = app.querySelector('[data-champion]')?.value || null;
      const left = S.matches.filter(m => m.status !== 'complete' && m.player1_id && m.player2_id).length;
      if (left && !confirm(`${left} match(es) are still unfinished. Close the tournament anyway?`)) break;
      if (!champ && !confirm('No winner selected. Close it without recording one?')) break;
      await run(async () => check(await sb.rpc('admin_finish_tournament', {
        p_tournament: t.id, p_champion: champ,
      })), 'Tournament finished');
      break;
    }
    case 'unfinish':
      await run(async () => check(await sb.rpc('admin_unfinish_tournament', { p_tournament: t.id })), 'Tournament reopened');
      break;
    case 'reset':
      if (confirm('Delete every match and score in this tournament?')) {
        await run(async () => {
          check(await sb.from('matches').delete().eq('tournament_id', t.id));
          check(await sb.from('tournament_players').update({ group_label: null }).eq('tournament_id', t.id));
        }, 'Fixtures deleted');
      }
      break;
    case 'delete':
      if (confirm(`Delete ${t.name} completely?`)) {
        await run(async () => {
          check(await sb.from('tournaments').delete().eq('id', t.id));
          S.sel = null;
        }, 'Tournament deleted');
      }
      break;
  }
});

app.addEventListener('toggle', e => {
  if (e.target.matches('details.entrant-box')) S.entrantsOpen = e.target.open;
  if (e.target.matches('details.adv-box')) S.advOpen = e.target.open;
  if (e.target.matches('details.archive-box')) S.archiveOpen = e.target.open;
}, true);

function syncFormatFields(form) {
  const groups = form.querySelector('[name=format]').value === 'groups_knockout';
  form.querySelectorAll('.groups-only').forEach(el => { el.hidden = !groups; });
}

// Typing in the create form reshapes the round plan, so redraw just that part.
app.addEventListener('input', e => {
  const inCreate = e.target.closest('[data-form="tournament"]');
  if (!inCreate) return;
  if (e.target.matches('[data-legs]')) {
    S.newLegs = legsFrom('adv-create');
  } else if (e.target.matches('[name=group_count], [name=advance_per_group], [name=knockout_legs_to_win], [name=group_legs_to_win]')) {
    refreshCreateAdv();
  }
});

app.addEventListener('change', async e => {
  if (e.target.matches('[name=format]')) {
    syncFormatFields(e.target.closest('form'));
    refreshCreateAdv();
  } else if (e.target.matches('#adv-manage [data-legs]')) {
    S.editLegs = legsFrom('adv-manage');
  } else if (e.target.matches('[data-status]')) {
    await run(async () => check(await sb.from('tournaments').update({ status: e.target.value }).eq('id', S.sel.id)));
  } else if (e.target.matches('[data-move]')) {
    const v = e.target.value;
    if (!v) return;
    await run(async () => check(await sb.rpc('admin_move_tournament', {
      p_tournament: e.target.dataset.move,
      p_starts_at: new Date(v).toISOString(),
    })), 'Fixture moved');
  } else if (e.target.matches('[data-board]')) {
    await run(async () => check(await sb.from('matches')
      .update({ board: e.target.value.trim() || null }).eq('id', e.target.dataset.board)));
  }
});

init();

async function init() {
  try {
    await initInner();
  } catch (e) {
    showLoadError(app, e);
  }
}
