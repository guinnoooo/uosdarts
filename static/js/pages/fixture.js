import { sb, showLoadError, showMissing, validId, qs, esc, fmtDate, debounce, toast, currentUserId, HUBS, MATCH_SELECT } from '../db.js';
import { matchCard, setWatching } from '../ui.js';

// A UDUK or Franny team match: the two teams, the score in games won, and
// every game in order. Each game opens on the match page, where its players
// are picked and it's scored.
const app = document.getElementById('app');
const id = qs('id');
const S = { t: null, games: [], admin: false, uid: null };

const TYPE = { singles: 'Singles', doubles: 'Doubles', trebles: 'Trebles' };

// Games won by each side: legs (or sets) decide each finished game.
function score() {
  let home = 0, away = 0;
  for (const g of S.games) {
    if (g.status !== 'complete') continue;
    const h = g.sets_to_win ? g.p1_sets : g.p1_legs, a = g.sets_to_win ? g.p2_sets : g.p2_legs;
    if (h > a) home++; else if (a > h) away++;
  }
  return { home, away };
}

// Consecutive games of the same type and length share a heading.
function blocks() {
  const out = [];
  for (const g of S.games) {
    const key = `${g.game_type}-${g.legs_to_win}-${g.start_score}`;
    if (out.at(-1)?.key === key) out.at(-1).games.push(g);
    else out.push({ key, g, games: [g] });
  }
  return out;
}

function render() {
  const t = S.t, hub = HUBS[t.kind];
  const { home, away } = score();
  const done = S.games.filter(g => g.status === 'complete').length;
  const canDelete = S.admin || (S.uid && t.created_by === S.uid);
  app.innerHTML = `
    <a class="back-link plain" href="/${t.kind}/">‹ ${hub.name} hub</a>
    <div class="fx-head">
      <div class="fx-team home">${esc(t.home_team)}</div>
      <div class="fx-big">${home}<span>–</span>${away}</div>
      <div class="fx-team away">${esc(t.away_team)}</div>
    </div>
    <p class="muted center small">${hub.name}${t.competition ? ` ${t.competition}` : ''} · ${fmtDate(t.created_at)} ·
      ${t.status === 'complete' ? 'Full time' : `${done} of ${S.games.length} games played`}
      ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}</p>
    ${blocks().map(b => `<section class="fx-block">
        <h2>${TYPE[b.g.game_type] ?? 'Games'} <span class="muted small">best of ${b.g.legs_to_win * 2 - 1} · ${b.g.start_score}</span></h2>
        <div class="m-grid">${b.games.map(g => matchCard(g, 1)).join('')}</div>
      </section>`).join('')}
    <p class="muted small">Tap a game to pick its players and score it. ${hub.name} games need the team match password.</p>
    ${canDelete && t.status !== 'complete' ? '<p><button data-act="delete" class="link danger-link">Delete this match</button></p>' : ''}`;
}

async function loadInner() {
  if (!validId(id)) { showMissing(app, "match"); return; }
  const [t, g] = await Promise.all([
    sb.from('tournaments').select('*').eq('id', id).maybeSingle(),
    sb.from('matches').select(MATCH_SELECT).eq('tournament_id', id).order('slot'),
  ]);
  if (t.error) throw t.error;
  if (g.error) throw g.error;
  if (!t.data || t.data.deleted_at) { showMissing(app, "match"); return; }
  if (!t.data.kind) { location.replace(`/tournament/?id=${id}`); return; }
  S.t = t.data;
  S.games = g.data;
  document.title = `${S.t.home_team} v ${S.t.away_team} · ${HUBS[S.t.kind].name}`;
  render();
}

app.addEventListener('click', async e => {
  if (e.target.closest('[data-act="delete"]')) {
    if (!confirm('Delete this match and every game in it?')) return;
    const { error } = await sb.rpc('delete_fixture', { p_tournament: id });
    if (error) { toast(error.message); return; }
    location.href = `/${S.t.kind}/`;
  }
});

const reload = debounce(load, 300);
sb.channel(`fixture-${id}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${id}` }, reload)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${id}` }, reload)
  .subscribe();

// How many are watching each game (match pages announce it on this channel).
const watchCh = sb.channel(`watch-${id}`);
watchCh.on('presence', { event: 'sync' }, () => {
  const counts = new Map();
  for (const metas of Object.values(watchCh.presenceState())) {
    const meta = metas.find(x => x.match && !x.scorer);
    if (meta) counts.set(meta.match, (counts.get(meta.match) ?? 0) + 1);
  }
  setWatching(counts);
  if (S.t) render();
}).subscribe();

load();
(async () => {
  S.uid = await currentUserId().catch(() => null);
  S.admin = !!(await sb.rpc('my_admin_role')).data;
  if (S.t) render();
})();

async function load() {
  try { await loadInner(); } catch (e) { showLoadError(app, e); }
}
