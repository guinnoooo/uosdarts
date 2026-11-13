import { sb, showLoadError, qs, esc, fmtDate, debounce, roundName, MATCH_SELECT } from '../db.js';
import { standings } from '../fixtures.js';
import { matchCard } from '../ui.js';

const app = document.getElementById('app');
const id = qs('id');

let S = {
  t: null, entrants: [], matches: [], tab: location.hash.slice(1) || 'matches',
  players: new Map(),   // player id -> { id, name }, so realtime rows can resolve names locally
};
let subscribed = false;

async function loadInner() {
  const [t, e, m] = await Promise.all([
    sb.from('tournaments').select('*, champion:players!tournaments_champion_id_fkey(id,name)').eq('id', id).single(),
    sb.from('tournament_players').select('*, players(id,name)').eq('tournament_id', id),
    sb.from('matches').select(MATCH_SELECT).eq('tournament_id', id)
      .order('stage').order('round').order('slot'),
  ]);
  const err = t.error || e.error || m.error;
  if (err) {
    app.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  S.t = t.data;
  S.entrants = e.data;
  S.matches = m.data;
  S.players = new Map(e.data.map(x => [x.player_id, x.players]));
  render();
}

// A realtime row carries the match's own columns but not the joined player
// names, so they're filled in from the entrant list already in memory.
function withNames(row) {
  return { ...row, p1: S.players.get(row.player1_id) ?? null, p2: S.players.get(row.player2_id) ?? null };
}

// Updating the row in place avoids refetching every match in the tournament
// each time a dart is thrown.
function applyMatchRow(row) {
  const i = S.matches.findIndex(m => m.id === row.id);
  if (i === -1) return false;
  S.matches[i] = withNames({ ...S.matches[i], ...row });
  return true;
}

// Several matches can update in the same instant, so coalesce into one redraw.
let frame = null;
function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = null; render(); });
}

function koRounds() {
  return Math.max(0, ...S.matches.filter(m => m.stage === 'knockout').map(m => m.round));
}

function tabs() {
  const list = [['matches', 'Matches']];
  if (S.t.format !== 'knockout') list.push(['groups', 'Groups']);
  if (S.matches.some(m => m.stage === 'knockout')) list.push(['bracket', 'Bracket']);
  if (!list.some(([k]) => k === S.tab)) S.tab = 'matches';
  return `<div class="tabs">${list.map(([k, label]) =>
    `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}

function matchesTab() {
  const kr = koRounds();
  const live = S.matches.filter(m => m.status === 'live');
  const next = S.matches.filter(m => m.status === 'pending' && m.player1_id && m.player2_id);
  const done = S.matches.filter(m => m.status === 'complete' && m.player1_id && m.player2_id)
    .sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
  const block = (title, list, empty) => `<section><h2>${title}</h2>
    ${list.length ? `<div class="m-grid">${list.map(m => matchCard(m, kr)).join('')}</div>`
      : `<p class="muted">${empty}</p>`}</section>`;
  if (!S.matches.length) return '<p class="muted">Fixtures haven\'t been drawn yet.</p>';
  return block('Live now', live, 'No matches in progress.') +
    block('Up next', next, 'No matches waiting to start.') +
    block('Results', done, 'No results yet.');
}

function groupsTab() {
  const labels = [...new Set(S.entrants.map(e => e.group_label).filter(Boolean))].sort();
  if (!labels.length) return '<p class="muted">Groups haven\'t been drawn yet.</p>';
  return labels.map(g => {
    const players = S.entrants.filter(e => e.group_label === g).map(e => e.players);
    const gm = S.matches.filter(m => m.stage === 'group' && m.group_label === g);
    const table = standings(players, gm);
    const q = S.t.format === 'groups_knockout' ? S.t.advance_per_group : 0;
    return `<section class="group"><h2>Group ${esc(g)}</h2>
      <table class="standings"><thead><tr><th></th><th class="l">Player</th><th>P</th><th>W</th><th>L</th><th>LF</th><th>LA</th><th>+/-</th><th>Pts</th></tr></thead>
      <tbody>${table.map((r, i) => `<tr class="${i < q ? 'qualify' : ''}">
        <td>${i + 1}</td><td class="l">${esc(r.name)}</td><td>${r.P}</td><td>${r.W}</td><td>${r.L}</td>
        <td>${r.LF}</td><td>${r.LA}</td><td>${r.LF - r.LA}</td><td><b>${r.Pts}</b></td></tr>`).join('')}</tbody></table>
      <div class="m-grid">${gm.map(m => matchCard(m, 0)).join('')}</div>
    </section>`;
  }).join('');
}

function bracketTab() {
  const kr = koRounds();
  const cols = [];
  for (let r = 1; r <= kr; r++) {
    const ms = S.matches.filter(m => m.stage === 'knockout' && m.round === r);
    cols.push(`<div class="b-col"><h3>${roundName(r, kr)}</h3>
      <div class="b-matches">${ms.map(m => matchCard(m, kr)).join('')}</div></div>`);
  }
  return `<div class="ko-bracket">${cols.join('')}</div>`;
}

function render() {
  const t = S.t;
  const body = S.tab === 'groups' ? groupsTab() : S.tab === 'bracket' ? bracketTab() : matchesTab();
  app.innerHTML = `
    ${t.champion ? `<div class="champ-banner">🏆 <b>${esc(t.champion.name)}</b> wins ${esc(t.name)}</div>` : ''}
    <div class="t-head">
      <h1>${esc(t.name)}</h1>
      <p class="muted">${fmtDate(t.starts_at)} · ${S.entrants.length} players · ${t.start_score}
        ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}</p>
    </div>
    ${tabs()}
    <div class="tab-body">${body}</div>`;
}

app.addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  history.replaceState(null, '', `#${S.tab}`);
  render();
});

const reload = debounce(load, 250);

load();

sb.channel(`t-${id}`)
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'matches', filter: `tournament_id=eq.${id}` },
    ({ new: row }) => {
      if (applyMatchRow(row)) scheduleRender();
      else reload();   // a match we don't know about yet
    })
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'matches', filter: `tournament_id=eq.${id}` },
    () => reload())
  .on('postgres_changes',
    { event: 'DELETE', schema: 'public', table: 'matches', filter: `tournament_id=eq.${id}` },
    () => reload())
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${id}` },
    () => reload())
  .subscribe(status => {
    // On the first subscribe the initial load covers us. On a reconnect we may
    // have missed messages while offline, so pull the full picture again.
    if (status !== 'SUBSCRIBED') return;
    if (subscribed) reload();
    subscribed = true;
  });

// Safety nets against a missed message leaving a score stale.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reload();
});
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, 120000);

// Entry point: never leaves the page sitting on "Loading…".
async function load() {
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}
