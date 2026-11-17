import { sb, showLoadError, esc, fmtDate, debounce } from '../db.js';

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

// Friendlies live in their own section: anything being played, anything set
// up in the last 12 hours, and results from the last day. Each friendly is a
// one-match tournament, so the card links straight to the match.
async function friendliesSection(all) {
  const hours = t => (Date.now() - new Date(t.created_at).getTime()) / 3600000;
  const shown = all.filter(t => t.status === 'live'
    || (t.status === 'upcoming' && hours(t) < 12)
    || (t.status === 'complete' && hours(t) < 24));
  const { data: enabled } = await sb.rpc('friendlies_enabled');
  if (!shown.length && !enabled) return '';
  let matches = [];
  if (shown.length) {
    const r = await sb.from('matches').select('id,tournament_id,status,p1_name,p2_name,p1_legs,p2_legs')
      .in('tournament_id', shown.map(t => t.id));
    matches = r.data ?? [];
  }
  const order = { live: 0, upcoming: 1, complete: 2 };
  const cards = shown.sort((a, b) => order[a.status] - order[b.status] || new Date(b.created_at) - new Date(a.created_at))
    .map(t => {
      const m = matches.find(x => x.tournament_id === t.id);
      if (!m) return '';
      const score = m.status === 'pending' ? 'Not started' : `${m.p1_legs}–${m.p2_legs}`;
      return `<a class="t-card ${t.status}" href="/match/?id=${m.id}">
        <div class="t-name">${esc(m.p1_name)} v ${esc(m.p2_name)}</div>
        <div class="t-meta">${score} · first to ${t.knockout_legs_to_win} · ${t.start_score}</div>
        ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}
      </a>`;
    }).join('');
  return `<section id="friendlies"><h2>Friendlies</h2>
    ${cards ? `<div class="t-grid">${cards}</div>` : '<p class="muted">No friendlies on at the moment.</p>'}
    ${enabled ? '<p><a class="button-link" href="/friendly/">Start a friendly</a></p>' : ''}
  </section>`;
}

function section(title, list, empty) {
  return `<section><h2>${title}</h2>
    ${list.length ? `<div class="t-grid">${list.map(card).join('')}</div>` : `<p class="muted">${empty}</p>`}
  </section>`;
}

async function loadInner() {
  const { data, error } = await sb.from('tournaments').select('*, champion:players!tournaments_champion_id_fkey(id,name)')
    .order('starts_at', { ascending: true, nullsFirst: false });
  if (error) {
    app.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    return;
  }
  const list = data.filter(t => !t.is_friendly).filter(europaVisible(data));
  const live = list.filter(t => t.status === 'live');
  const upcoming = list.filter(t => t.status === 'upcoming');
  const done = list.filter(t => t.status === 'complete').reverse().slice(0, 12);
  app.innerHTML =
    section('Live now', live, 'Nothing live right now.') +
    section('Upcoming', upcoming, 'No tournaments scheduled yet.') +
    section('Recent results', done, 'No finished tournaments yet.') +
    await friendliesSection(data.filter(t => t.is_friendly));
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
