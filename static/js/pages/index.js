import { sb, showLoadError, esc, fmtDate, debounce, scoreText, winnerSide } from '../db.js';

const app = document.getElementById('app');

const FORMAT = {
  knockout: 'Knockout',
  groups: 'Round robin',
  groups_knockout: 'Groups + knockout',
};

function card(t) {
  return `<a class="t-card ${t.status}" href="/tournament/?id=${t.id}">
    <div class="t-name">${esc(t.name)}</div>
    <div class="t-meta">${fmtDate(t.starts_at)} · ${FORMAT[t.format]} · ${t.start_score}</div>
    ${t.champion ? `<div class="t-champ">🏆 ${esc(t.champion.name)}</div>` : ''}
    ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}
  </a>`;
}

// Every PC has a Europa waiting behind it. An unstarted one only shows up on
// the night (its PC is live, or finished within the last day), otherwise the
// upcoming list would be full of empty Europas.
function europaVisible(all) {
  const byId = new Map(all.map(t => [t.id, t]));
  return t => {
    if (!t.parent_id || t.status !== 'upcoming') return true;
    const pc = byId.get(t.parent_id);
    if (!pc) return false;
    if (pc.status === 'live') return true;
    return pc.status === 'complete' && Date.now() - new Date(pc.starts_at).getTime() < 36 * 3600 * 1000;
  };
}

// A friendly is a one-match tournament, so its card links straight to the match.
function friendlyCard(t, m) {
  const score = m.status === 'pending' ? 'Not started' : scoreText(m);
  const winner = t.status === 'complete' ? (winnerSide({ ...m, status: 'complete' }) === 1 ? m.p1_name : m.p2_name) : null;
  const length = m.sets_to_win ? `first to ${m.sets_to_win} sets` : `first to ${t.knockout_legs_to_win}`;
  return `<a class="t-card ${t.status}" href="/match/?id=${m.id}">
    <div class="t-name">${esc(m.p1_name)} v ${esc(m.p2_name)}</div>
    <div class="t-meta">Friendly · ${score} · ${length} · ${t.start_score}</div>
    ${winner ? `<div class="t-champ">🏆 ${esc(winner)}</div>` : ''}
    ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}
  </a>`;
}

function section(title, cards, empty, id = '') {
  return `<section${id ? ` id="${id}"` : ''}><h2>${title}</h2>
    ${cards.length ? `<div class="t-grid">${cards.join('')}</div>` : `<p class="muted">${empty}</p>`}
  </section>`;
}

async function loadInner() {
  const [{ data, error }, enabledRes] = await Promise.all([
    sb.from('tournaments').select('*, champion:players!tournaments_champion_id_fkey(id,name)')
      .order('starts_at', { ascending: true, nullsFirst: false }),
    sb.rpc('friendlies_enabled'),
  ]);
  if (error) {
    app.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    return;
  }
  const enabled = !!enabledRes.data;

  const list = data.filter(t => !t.is_friendly).filter(europaVisible(data));
  const live = list.filter(t => t.status === 'live');
  const upcoming = list.filter(t => t.status === 'upcoming');
  const done = list.filter(t => t.status === 'complete');

  // Friendlies: anything being played or set up in the last 12 hours shows
  // as live; anything finished in the last day goes in with the results.
  const hours = t => (Date.now() - new Date(t.created_at).getTime()) / 3600000;
  const fr = data.filter(t => t.is_friendly && (t.status === 'live'
    || (t.status === 'upcoming' && hours(t) < 12)
    || (t.status === 'complete' && hours(t) < 24)));
  let fm = [];
  if (fr.length) {
    const r = await sb.from('matches').select('*')
      .in('tournament_id', fr.map(t => t.id));
    fm = r.data ?? [];
  }
  const withMatch = t => ({ t, m: fm.find(x => x.tournament_id === t.id) });
  const liveFr = fr.filter(t => t.status !== 'complete').map(withMatch).filter(x => x.m)
    .sort((a, b) => (a.t.status === 'live' ? 0 : 1) - (b.t.status === 'live' ? 0 : 1)
      || new Date(b.t.created_at) - new Date(a.t.created_at));

  // Results: finished tournaments and today's finished friendlies, newest first.
  const results = done.map(t => ({ when: new Date(t.starts_at ?? t.created_at), html: card(t) }))
    .concat(fr.filter(t => t.status === 'complete').map(withMatch).filter(x => x.m)
      .map(({ t, m }) => ({ when: new Date(t.created_at), html: friendlyCard(t, m) })))
    .sort((a, b) => b.when - a.when).slice(0, 12).map(x => x.html);

  app.innerHTML =
    section('Live tournaments', live.map(card), 'No tournaments live right now.') +
    section('Live friendlies', liveFr.map(({ t, m }) => friendlyCard(t, m)), 'No friendlies on at the moment.', 'friendlies') +
    (enabled ? `<section class="start-friendly"><h2>Start a friendly</h2>
      <a class="button-link" href="/friendly/">Start a friendly</a></section>` : '') +
    section('Upcoming tournaments', upcoming.map(card), 'No tournaments scheduled yet.') +
    section('Recent results', results, 'No results yet.');
}

load();
sb.channel('tournaments')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, debounce(load))
  .subscribe();

// Entry point: never leaves the page sitting on "Loading…".
async function load() {
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}
