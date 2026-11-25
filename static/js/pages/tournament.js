import { sb, showLoadError, showMissing, validId, qs, esc, fmtDate, debounce, roundName, hasPlayers, MATCH_SELECT } from '../db.js';
import { standings } from '../fixtures.js';
import { matchCard, setWatching } from '../ui.js';
import { oomScore } from '../winprob.js';
import { outrightOdds, outrightPrice } from '../outright.js';
import { loadAccount, slipHtml, slipEvent, myBetsOn, myBetsHtml, quoteSlip, accaBarHtml } from '../betting.js';

const app = document.getElementById('app');
const id = qs('id');

let S = {
  t: null, entrants: [], matches: [], tab: location.hash.slice(1) || 'matches',
  players: new Map(),   // player id -> { id, name }, so realtime rows can resolve names locally
};
let subscribed = false;

async function loadInner() {
  const [t, e, m, kids] = await Promise.all([
    sb.from('tournaments').select('*, champion:players!tournaments_champion_id_fkey(id,name)').eq('id', id).single(),
    sb.from('tournament_players').select('*, players(id,name)').eq('tournament_id', id),
    sb.from('matches').select(MATCH_SELECT).eq('tournament_id', id)
      .order('stage').order('round').order('slot'),
    sb.from('tournaments').select('id,name,status').eq('parent_id', id),
  ]);
  const err = t.error || e.error || m.error;
  if (err) {
    app.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  S.t = t.data;
  // UDUK and Franny matches have their own page.
  if (S.t.kind) { location.replace(`/fixture/?id=${id}`); return; }
  // A finished tournament opens on its summary unless a tab was asked for.
  if (S.t.status === 'complete' && !S.t.is_friendly && !S.tabPicked && !location.hash.slice(1)) S.tab = 'summary';
  S.summary = null;
  if (S.t.status === 'complete' && !S.t.is_friendly) {
    const [sum, ma, bl] = await Promise.all([
      sb.rpc('tournament_summary', { p_tournament: id }),
      sb.rpc('tournament_match_averages', { p_tournament: id }),
      sb.rpc('tournament_best_legs', { p_tournament: id, p_limit: 5 }),
    ]);
    S.summary = sum.error ? { error: sum.error.message } : sum.data;
    S.matchAvgs = ma.error ? [] : ma.data;
    // Each leg on its own, so one player can fill several places.
    S.bestLegs = bl.error ? null : bl.data;
  }
  S.europa = kids.data?.[0] ?? null;
  S.parent = null;
  if (S.t.parent_id) {
    const p = await sb.from('tournaments').select('id,name').eq('id', S.t.parent_id).maybeSingle();
    S.parent = p.data ?? null;
  }
  S.entrants = e.data;
  S.matches = m.data;
  S.players = new Map(e.data.map(x => [x.player_id, x.players]));
  await loadOdds();
  // Your outright bets: fetched once, and again when the tournament finishes.
  if (S.betsFor !== S.t.status) {
    S.betsFor = S.t.status;
    if (S.myBets === undefined) S.myBets = [];
    loadAccount().then(a => (a ? refreshBets().then(() => render()) : null)).catch(() => {});
  }
  render();
}

// ---------------------------------------------------------------- outright odds

// Each entrant's figures, fetched with the page. The odds themselves are
// worked out here in the browser and refreshed as results come in.
async function loadOdds() {
  S.odds = null;
  if (S.t.status === 'complete' || S.t.is_friendly || !S.matches.length) return;
  const [fig, oom] = await Promise.all([
    sb.rpc('tournament_odds_data', { p_tournament: id }),
    sb.rpc('oom_table'),
  ]);
  if (fig.error) return;
  const rows = oom.data ?? [];
  S.oddsData = {
    figures: fig.data ?? [],
    oom: new Map(S.entrants.map(x => [x.player_id, oomScore(rows, x.players?.name)])),
  };
  computeOdds();
}

function computeOdds() {
  if (!S.oddsData) return;
  try {
    S.odds = outrightOdds({ ...S.oddsData, t: S.t, entrants: S.entrants, matches: S.matches.map(m => ({ ...m })) });
  } catch {
    S.odds = null;
  }
  S.oddsAt = Date.now();
}

// Later updates are worked out in a background worker, so the page never
// stalls while the run-throughs happen. Without one, they run here instead.
let worker = null, job = 0;
try {
  worker = new Worker(new URL(`../outright-worker.js${new URL(import.meta.url).search}`, import.meta.url), { type: 'module' });
  worker.onmessage = e => {
    if (e.data.job !== job) return;
    if (e.data.odds) S.odds = e.data.odds;
    S.oddsAt = Date.now();
    scheduleRender();
  };
  worker.onerror = () => { worker = null; };
} catch { worker = null; }

function refreshOdds() {
  if (!S.oddsData) return;
  if (!worker) { computeOdds(); scheduleRender(); return; }
  job++;
  worker.postMessage({ job, args: { ...S.oddsData, t: S.t, entrants: S.entrants, matches: S.matches.map(m => ({ ...m })) } });
}

// A leg can finish on several boards a minute; the odds are redone at most
// every 10 seconds.
let oddsTimer = null;
function scheduleOdds() {
  if (!S.oddsData || oddsTimer) return;
  oddsTimer = setTimeout(() => { oddsTimer = null; refreshOdds(); }, Math.max(0, 10000 - (Date.now() - (S.oddsAt ?? 0))));
}

// Outright bets: open until the first match of the tournament starts.
const outrightOpen = () => !S.t.is_friendly && S.t.status !== 'complete' && S.matches.length > 0
  && !S.matches.some(m => m.status === 'live' || (m.status === 'complete' && m.player1_id && m.player2_id));

function oddsSection() {
  const list = S.odds ?? [];
  if (list.length < 2) return '';
  const shown = S.oddsAll ? list : list.slice(0, 5);
  const thin = shown.some(x => x.thin);
  const bet = outrightOpen();
  if (!bet) S.slip = null;
  const price = x => bet
    ? `<button class="odds-pick small-pick${S.slip?.player_id === x.id ? ' on' : ''}" data-obet="${x.id}"><b>${outrightPrice(x.p)}</b></button>`
    : `<b>${outrightPrice(x.p)}</b>`;
  return `<section class="outright"><h2>${bet ? 'Odds' : 'Live odds'} to win the tournament${thin ? '<sup class="odds-star">*</sup>' : ''}</h2>
    ${bet ? slipHtml(S.slip) : ''}
    ${myBetsHtml(S.myBets)}
    <table class="outright-list"><tbody>${shown.map((x, i) => `<tr>
      <td class="muted">${i + 1}</td><td class="l">${esc(x.name)}</td>
      <td>${price(x)}</td></tr>`).join('')}</tbody></table>
    ${list.length > 5 ? `<button data-act="odds-toggle" class="link">${S.oddsAll ? 'Show top 5' : `Show all ${list.length}`}</button>` : ''}
    ${thin ? '<p class="muted small odds-note">* Little data on some players, so these odds are rough</p>' : ''}
  </section>`;
}

// A realtime row carries the match's own columns but not the joined player
// names, so they're filled in from the entrant list already in memory.
function withNames(row) {
  return { ...row, p1: S.players.get(row.player1_id) ?? null, p2: S.players.get(row.player2_id) ?? null };
}

// Updating the row in place avoids refetching every match in the tournament
// each time a dart is thrown. The odds only move when a leg, set or match
// finishes, not with every visit.
const scoreKey = m => [m.status, m.p1_legs, m.p2_legs, m.p1_sets, m.p2_sets, m.winner_id].join('|');
function applyMatchRow(row) {
  const i = S.matches.findIndex(m => m.id === row.id);
  if (i === -1) return false;
  const before = scoreKey(S.matches[i]);
  S.matches[i] = withNames({ ...S.matches[i], ...row });
  if (scoreKey(S.matches[i]) !== before) scheduleOdds();
  return true;
}

// Several matches can update in the same instant, so coalesce into one redraw.
let frame = null;
// On a busy night the scores can change many times a second; this page is
// an overview, so it redraws at most every 400 ms.
let lastRender = 0;
function scheduleRender() {
  if (frame) return;
  const wait = Math.max(0, 400 - (performance.now() - lastRender));
  frame = setTimeout(() => requestAnimationFrame(() => { frame = null; lastRender = performance.now(); render(); }), wait);
}

function koRounds() {
  return Math.max(0, ...S.matches.filter(m => m.stage === 'knockout').map(m => m.round));
}

function tabs() {
  const list = S.t.status === 'complete' && !S.t.is_friendly ? [['summary', 'Summary'], ['matches', 'Matches']] : [['matches', 'Matches']];
  if (S.t.format !== 'knockout') list.push(['groups', 'Groups']);
  if (S.matches.some(m => m.stage === 'knockout')) list.push(['bracket', 'Bracket']);
  if (!list.some(([k]) => k === S.tab)) S.tab = 'matches';
  return `<div class="tabs">${list.map(([k, label]) =>
    `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}

function matchesTab() {
  const kr = koRounds();
  const live = S.matches.filter(m => m.status === 'live');
  const ready = S.matches.filter(m => m.status === 'pending' && hasPlayers(m));
  // Matches the admin has sent to a board, in board order.
  const called = ready.filter(m => m.called_at)
    .sort((a, b) => String(a.board ?? '').localeCompare(String(b.board ?? ''), undefined, { numeric: true }));
  const next = ready.filter(m => !m.called_at);
  const done = S.matches.filter(m => m.status === 'complete' && hasPlayers(m))
    .sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
  const block = (title, list, empty) => `<section><h2>${title}</h2>
    ${list.length ? `<div class="m-grid">${list.map(m => matchCard(m, kr)).join('')}</div>`
      : `<p class="muted">${empty}</p>`}</section>`;
  if (!S.matches.length) return '<p class="muted">Fixtures haven\'t been drawn yet.</p>';
  return block('Live now', live, 'No matches in progress.') +
    (called.length ? block('Board calls', called, '') : '') +
    block('Up next', next, 'No matches waiting to start.') +
    block('Results', done, 'No results yet.') +
    oddsSection();
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

// Matches go in pairs that feed the same match in the next round, so lines
// can join each pair to it. Every slot takes an equal share of the column's
// height, which keeps each match level with the middle of the two before it.
function bracketTab() {
  const kr = koRounds();
  const cols = [];
  for (let r = 1; r <= kr; r++) {
    const ms = S.matches.filter(m => m.stage === 'knockout' && m.round === r).sort((a, b) => a.slot - b.slot);
    const pairs = [];
    for (let i = 0; i < ms.length; i += 2) pairs.push(ms.slice(i, i + 2));
    cols.push(`<div class="b-col${r === 1 ? ' b-first' : ''}${r === kr ? ' b-last' : ''}"><h3>${roundName(r, kr)}</h3>
      <div class="b-matches">${pairs.map(p => `<div class="b-pair${p.length === 2 ? ' two' : ''}">
        ${p.map(m => `<div class="b-slot">${matchCard(m, kr)}</div>`).join('')}</div>`).join('')}</div></div>`);
  }
  return `<div class="ko-bracket">${cols.join('')}</div>`;
}

// On a computer the bracket can be dragged sideways with the mouse. A drag
// that moves more than a few pixels doesn't count as a click on a match.
const drag = { on: false, x: 0, left: 0, moved: false };
app.addEventListener('pointerdown', e => {
  const kb = e.target.closest('.ko-bracket');
  if (!kb || e.pointerType !== 'mouse' || e.button !== 0) return;
  Object.assign(drag, { on: true, x: e.clientX, left: kb.scrollLeft, moved: false, el: kb });
});
window.addEventListener('pointermove', e => {
  if (!drag.on) return;
  const dx = e.clientX - drag.x;
  if (!drag.moved && Math.abs(dx) > 5) { drag.moved = true; drag.el.classList.add('dragging'); }
  if (drag.moved) { drag.el.scrollLeft = drag.left - dx; e.preventDefault(); }
});
window.addEventListener('pointerup', () => {
  if (!drag.on) return;
  drag.on = false;
  drag.el?.classList.remove('dragging');
});
app.addEventListener('click', e => {
  if (drag.moved && e.target.closest('.ko-bracket')) { e.preventDefault(); e.stopPropagation(); drag.moved = false; }
}, true);
app.addEventListener('dragstart', e => { if (e.target.closest?.('.ko-bracket')) e.preventDefault(); });

// ---------------------------------------------------------------- summary

const avg3 = (scored, darts) => (darts ? (scored / darts) * 3 : null);

function leaderboard(title, rows, fmt, empty = 'Nothing yet.', sub = null) {
  return `<div class="sum-card"><h3>${title}</h3>
    ${rows.length ? `<ol class="sum-list">${rows.map(r => `<li>
      <span class="sum-name">${esc(r.player_name)}${sub ? `<span class="sum-sub">${sub(r)}</span>` : ''}</span><span class="sum-val">${fmt(r)}</span></li>`).join('')}</ol>`
      : `<p class="muted small">${empty}</p>`}
  </div>`;
}

function runnerUp() {
  const ko = S.matches.filter(m => m.stage === 'knockout');
  if (!ko.length) return null;
  const last = Math.max(...ko.map(m => m.round));
  const final = ko.find(m => m.round === last && m.status === 'complete' && m.winner_id);
  if (!final) return null;
  return final.winner_id === final.player1_id ? final.p2 : final.p1;
}

function summaryTab() {
  if (!S.summary) return '<p class="muted">Loading the summary…</p>';
  if (S.summary.error) return `<p class="muted">The summary isn't available yet. ${esc(S.summary.error)}</p>`;
  const rows = S.summary.map(r => ({
    ...r, avg: avg3(r.scored, r.darts), f9: avg3(r.first9_scored, r.first9_darts),
  }));
  const top = (list, key, dir = -1, n = 5) => list.filter(r => r[key] != null && r[key] > 0)
    .sort((a, b) => dir * (a[key] - b[key]) || a.player_name.localeCompare(b.player_name)).slice(0, n);
  // Averages need a fair sample, otherwise one lucky visit tops the list.
  const enough = rows.filter(r => r.darts >= 9);
  const sum = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const ru = runnerUp();
  const t = S.t;

  // Best averages in a single match. Nine darts is the minimum, so a quick
  // walkover leg can't top the list.
  const matchAvgs = (S.matchAvgs ?? []).filter(r => r.darts >= 9)
    .map(r => ({ ...r, avg: avg3(r.scored, r.darts) }))
    .sort((a, b) => b.avg - a.avg).slice(0, 5);
  const matchesPlayed = S.matches.filter(m => m.status === 'complete' && m.player1_id && m.player2_id).length;

  return `<section class="summary">
    <div class="sum-podium">
      <div class="sum-winner"><span class="muted small">Winner</span><b>${esc(t.champion?.name ?? 'Not set')}</b></div>
      ${ru ? `<div class="sum-runner"><span class="muted small">Runner-up</span><b>${esc(ru.name)}</b></div>` : ''}
    </div>
    <div class="sum-totals">
      <div><b>${matchesPlayed}</b><span>matches</span></div>
      <div><b>${sum('sheet_legs')}</b><span>sheet legs</span></div>
      <div><b>${sum('s180')}</b><span>180s</span></div>
      <div><b>${sum('ton_checkouts')}</b><span>100+ C/Os</span></div>
    </div>
    <div class="sum-grid">
      ${leaderboard('Top averages', top(enough, 'avg'), r => r.avg.toFixed(2))}
      ${leaderboard('Best match averages', matchAvgs, r => r.avg.toFixed(2), 'Nothing yet.', r => `v ${esc(r.opponent)}`)}
      ${leaderboard('Highest checkouts', top(rows, 'hi_checkout'), r => r.hi_checkout)}
      ${leaderboard('Best legs', S.bestLegs ?? top(rows, 'best_leg', 1).map(r => ({ ...r, darts: r.best_leg })),
        r => `${r.darts} darts`)}
      ${leaderboard('180s', top(rows, 's180'), r => r.s180)}
      ${leaderboard('140+', top(rows, 's140'), r => r.s140)}
    </div>
  </section>`;
}

function render() {
  const t = S.t;
  // The bracket scrolls sideways on a phone. Redrawing it for a score update
  // would jump back to the first round, so keep where the viewer had got to.
  const kb = app.querySelector('.ko-bracket');
  const keepX = kb ? kb.scrollLeft : null;
  const body = S.tab === 'summary' ? summaryTab() : S.tab === 'groups' ? groupsTab() : S.tab === 'bracket' ? bracketTab() : matchesTab();
  app.innerHTML = `
    ${t.champion ? `<div class="champ-banner">🏆 <b>${esc(t.champion.name)}</b> wins ${esc(t.name)}</div>` : ''}
    <div class="t-head">
      <h1>${esc(t.name)}</h1>
      <p class="muted">${fmtDate(t.starts_at)} · ${S.entrants.length} players · ${t.start_score}
        ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}</p>
      ${S.parent ? `<p class="muted small">For players knocked out of <a href="/tournament/?id=${S.parent.id}">${esc(S.parent.name)}</a> before the last 16.</p>` : ''}
      ${S.europa && S.t.status !== 'upcoming' ? `<p class="muted small">Out before the last 16? You're in <a href="/tournament/?id=${S.europa.id}">${esc(S.europa.name)}</a>.</p>` : ''}
    </div>
    ${S.tab === 'matches' && (S.odds?.length ?? 0) >= 2 ? '' : myBetsHtml(S.myBets)}
    ${tabs()}
    <div class="tab-body">${body}</div>
    ${accaBarHtml()}`;
  if (keepX) {
    const nb = app.querySelector('.ko-bracket');
    if (nb) nb.scrollLeft = keepX;
  }
}

const refreshBets = async () => { S.myBets = await myBetsOn({ tournamentId: id }); };
const slipCtx = { slip: () => S.slip, set: v => { S.slip = v; }, render: () => render(), changed: refreshBets };
app.addEventListener('input', e => { slipEvent(e, slipCtx); });
app.addEventListener('click', async e => {
  if (e.target.closest('[data-act="odds-toggle"]')) { S.oddsAll = !S.oddsAll; render(); return; }
  const ob = e.target.closest('[data-obet]');
  if (ob) {
    const x = (S.odds ?? []).find(o => o.id === ob.dataset.obet);
    if (!x) return;
    S.slip = { kind: 'outright', tournament_id: id, player_id: x.id, selection: x.name, price: outrightPrice(x.p), stake: S.slip?.stake ?? 100 };
    loadAccount().then(() => render(), () => render());
    render();
    quoteSlip(S.slip, slipCtx);
    return;
  }
  if (await slipEvent(e, slipCtx)) return;
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  S.tabPicked = true;
  history.replaceState(null, '', `#${S.tab}`);
  render();
});

const reload = debounce(load, 250);

// Spectator counts. Match pages announce which match they're watching on this
// channel; this page only listens, so it isn't counted itself.
const watchCh = sb.channel(`watch-${id}`);
watchCh.on('presence', { event: 'sync' }, () => {
  const counts = new Map();
  for (const metas of Object.values(watchCh.presenceState())) {
    const meta = metas.find(x => x.match && !x.scorer);
    if (meta) counts.set(meta.match, (counts.get(meta.match) ?? 0) + 1);
  }
  setWatching(counts);
  if (S.t) scheduleRender();
}).subscribe();

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
  if (!validId(id)) { showMissing(app, 'tournament'); return; }
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}
