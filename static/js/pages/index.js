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
  const list = data.filter(europaVisible(data));
  const live = list.filter(t => t.status === 'live');
  const upcoming = list.filter(t => t.status === 'upcoming');
  const done = data.filter(t => t.status === 'complete').reverse().slice(0, 12);
  app.innerHTML =
    section('Live now', live, 'Nothing live right now.') +
    section('Upcoming', upcoming, 'No tournaments scheduled yet.') +
    section('Recent results', done, 'No finished tournaments yet.');
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
