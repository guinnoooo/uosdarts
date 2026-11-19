import { sb, showLoadError, showMissing, validId, qs, esc, fmtDate, debounce, toast, currentUserId, ensureSignedIn, HUBS, MATCH_SELECT } from '../db.js';
import { matchCard, setWatching } from '../ui.js';

// A UDUK or Franny team match: the two teams, the score in games won, and
// every game in order. Each game opens on the match page, where its players
// are picked and it's scored.
const app = document.getElementById('app');
const id = qs('id');
const S = { t: null, games: [], admin: false, uid: null, bullEdit: false, timeEdit: false };
const PW_KEY = () => `uosdarts:pw:${id}`;
const savedPw = () => { try { return localStorage.getItem(PW_KEY()) ?? ''; } catch { return ''; } };

const TYPE = { singles: 'Singles', doubles: 'Doubles', trebles: 'Trebles', decider: 'Decider' };

// Who throws first. UDUK: the bull off winners in the odd games, counting
// every game in order. Franny: the away team in the odd games.
function throwPanel() {
  const t = S.t;
  if (t.kind === 'franny') {
    return `<p class="muted small center">${esc(t.away_team)} throw first in singles 1, 3 and 5 and doubles 2.</p>`;
  }
  const started = S.games.some(g => g.status !== 'pending');
  const team = n => n === 1 ? t.home_team : t.away_team;
  if (t.bull_winner && !S.bullEdit) {
    const odd = t.competition === 'cup'
      ? 'singles 1, 3, 5, 7, 9, doubles 2 and 4, second set singles 2, 4, 6, 8 and any decider'
      : 'trebles 1, doubles 1 and 3, and singles 2, 4 and 6';
    return `<p class="muted small center">${esc(team(t.bull_winner))} won the bull off, so they throw first in ${odd}.
      ${started ? '' : '<button data-act="bull-edit" class="link">Change</button>'}</p>`;
  }
  return `<div class="panel narrow center fx-bull">
      <h3>Who won the bull off?</h3>
      <p class="muted small">The winners throw first in the odd numbered games.</p>
      ${savedPw() ? '' : '<input id="bull-pw" type="password" autocomplete="off" placeholder="Scoring password for this match">'}
      <div class="modal-btns">
        <button data-bull="1" class="primary">${esc(t.home_team)}</button>
        <button data-bull="2" class="primary">${esc(t.away_team)}</button>
      </div>
      ${S.bullEdit ? '<button data-act="bull-cancel" class="link">Cancel</button>' : ''}
    </div>`;
}

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

// For a datetime-local box: the time in the viewer's own timezone.
const localValue = d => {
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

// A match that hasn't started can be moved by whoever set it up, an admin,
// or anyone with its scoring password.
function timePanel() {
  const t = S.t;
  if (t.status !== 'upcoming') return '';
  if (!S.timeEdit) {
    const future = new Date(t.starts_at) > new Date();
    return `<p class="muted small center">${future ? `Starts ${esc(fmtDate(t.starts_at))}. ` : ''}<button data-act="time-edit" class="link">${future ? 'Change time' : 'Schedule for later'}</button></p>`;
  }
  const mine = S.admin || (S.uid && t.created_by === S.uid) || savedPw();
  return `<div class="panel narrow center fx-time">
      <h3>When does it start?</h3>
      <input id="fx-when" type="datetime-local" value="${localValue(t.starts_at)}">
      ${mine ? '' : '<input id="time-pw" type="password" autocomplete="off" placeholder="Scoring password for this match">'}
      <div class="modal-btns">
        <button data-act="time-save" class="primary">Save</button>
        <button data-act="time-cancel">Cancel</button>
      </div>
    </div>`;
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
    <p class="muted center small">${hub.name}${t.competition ? ` ${t.competition}` : ''} · ${fmtDate(t.starts_at ?? t.created_at)} ·
      ${t.status === 'complete' ? 'Full time' : `${done} of ${S.games.length} games played`}
      ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}</p>
    ${timePanel()}
    ${throwPanel()}
    ${blocks().map(b => `<section class="fx-block">
        <h2>${TYPE[b.g.game_type] ?? 'Games'} <span class="muted small">best of ${b.g.legs_to_win * 2 - 1} · ${b.g.start_score}</span></h2>
        ${b.g.game_type === 'decider' ? '<p class="muted small">The match finished level. One leg of 1001, with every player in both squads throwing in turn.</p>' : ''}
        <div class="m-grid">${b.games.map(g => matchCard(g, 1)).join('')}</div>
      </section>`).join('')}
    <p class="muted small">Tap a game to pick its players and score it, using the scoring password set when this match was started.</p>
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
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'time-edit') { S.timeEdit = true; render(); return; }
  if (act === 'time-cancel') { S.timeEdit = false; render(); return; }
  if (act === 'time-save') {
    const v = app.querySelector('#fx-when')?.value;
    if (!v) { toast('Pick a start time'); return; }
    const typed = app.querySelector('#time-pw')?.value.trim();
    const btn = e.target.closest('button');
    btn.disabled = true;
    try {
      await ensureSignedIn();
      const { error } = await sb.rpc('set_fixture_time', { p_tournament: id, p_password: typed || savedPw() || null, p_starts_at: new Date(v).toISOString() });
      if (error) throw error;
      if (typed) { try { localStorage.setItem(PW_KEY(), typed); } catch { /* private mode */ } }
      S.timeEdit = false;
      await load();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
    return;
  }
  if (act === 'bull-edit') { S.bullEdit = true; render(); return; }
  if (act === 'bull-cancel') { S.bullEdit = false; render(); return; }
  const bull = e.target.closest('[data-bull]');
  if (bull) {
    const typed = app.querySelector('#bull-pw')?.value.trim();
    const pw = typed || savedPw();
    if (!pw && !S.admin) { toast('Enter the scoring password for this match'); return; }
    bull.disabled = true;
    try {
      await ensureSignedIn();
      const { error } = await sb.rpc('set_fixture_bull', { p_tournament: id, p_password: pw, p_side: Number(bull.dataset.bull) });
      if (error) throw error;
      if (typed) { try { localStorage.setItem(PW_KEY(), typed); } catch { /* private mode */ } }
      S.bullEdit = false;
      await load();
    } catch (err) {
      toast(err.message);
      bull.disabled = false;
    }
    return;
  }
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
