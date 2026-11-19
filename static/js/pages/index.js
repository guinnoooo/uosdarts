import { sb, showLoadError, esc, debounce, jittered, HUBS } from '../db.js';
import { kindOf, tournamentCard, anyCard, cardData, section, europaVisible } from '../events.js';

// The Match Hub: what's on now, what's coming up, ways in to the UDUK and
// Franny hubs and friendlies, and the latest results.
const app = document.getElementById('app');

const SELECT = '*, champion:players!tournaments_champion_id_fkey(id,name)';

const hoursAgo = t => (Date.now() - new Date(t.created_at).getTime()) / 3600000;
const isTeamMatch = t => ['uduk', 'franny'].includes(kindOf(t));
// A UDUK or Franny match booked for later than the next hour.
const scheduledLater = t => isTeamMatch(t) && t.status === 'upcoming'
  && new Date(t.starts_at).getTime() > Date.now() + 3600 * 1000;

async function loadInner() {
  const [open, done, friendlyOn, hubsOn] = await Promise.all([
    sb.from('tournaments').select(SELECT).in('status', ['upcoming', 'live']).is('deleted_at', null)
      .order('starts_at', { ascending: true, nullsFirst: false }),
    // Plenty to find the latest three of each kind.
    sb.from('tournaments').select(SELECT).eq('status', 'complete').is('deleted_at', null)
      .order('starts_at', { ascending: false, nullsFirst: false }).limit(60),
    sb.rpc('friendlies_enabled'),
    sb.rpc('hub_enabled', { p_kind: 'uduk' }),
  ]);
  if (open.error) throw open.error;
  if (done.error) throw done.error;
  const all = [...open.data, ...done.data];

  // Tournaments.
  const tours = open.data.filter(t => kindOf(t) === 'tournament').filter(europaVisible(all));
  const liveTours = tours.filter(t => t.status === 'live');
  // Upcoming tournaments, plus UDUK and Franny matches booked for later.
  const upcoming = [...tours.filter(t => t.status === 'upcoming'), ...open.data.filter(scheduledLater)]
    .sort((a, b) => (a.starts_at ? Date.parse(a.starts_at) : Infinity) - (b.starts_at ? Date.parse(b.starts_at) : Infinity));

  // Everything else that's on: being played, or set up in the last 12 hours.
  // A scheduled team match joins this list an hour before it starts.
  const onNow = open.data.filter(t => kindOf(t) !== 'tournament' && !scheduledLater(t)
    && (t.status === 'live' || hoursAgo(t) < 12
      || (isTeamMatch(t) && Date.now() - new Date(t.starts_at).getTime() < 12 * 3600 * 1000)))
    .sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1)
      || new Date(b.created_at) - new Date(a.created_at));

  // The latest three results of each kind.
  const recent = {};
  for (const t of done.data) {
    const k = kindOf(t);
    (recent[k] ??= []).length < 3 && recent[k].push(t);
  }
  const extra = await cardData([...onNow, ...upcoming.slice(0, 3).filter(isTeamMatch), ...Object.values(recent).flat()]);

  const onGroups = ['uduk', 'franny', 'friendly']
    .map(k => [k, onNow.filter(t => kindOf(t) === k)])
    .filter(([, list]) => list.length);
  const groupTitle = { uduk: 'UDUK', franny: 'Franny', friendly: 'Friendlies' };

  const resultGroups = [['tournament', 'Tournaments'], ['uduk', 'UDUK'], ['franny', 'Franny'], ['friendly', 'Friendlies']]
    .filter(([k]) => recent[k]?.length);

  app.innerHTML =
    section('Live tournaments', liveTours.map(tournamentCard), 'No tournaments live right now.') +
    `<section id="live-matches"><h2>Live matches</h2>
      ${onGroups.length ? onGroups.map(([k, list]) => `<div class="hub-group" id="${k === 'friendly' ? 'friendlies' : k}">
          <h3>${groupTitle[k]}</h3>
          <div class="t-grid">${list.map(t => anyCard(t, extra)).join('')}</div>
        </div>`).join('')
        : '<p class="muted">No UDUK, Franny or friendly matches on at the moment.</p>'}
    </section>` +
    section('Upcoming', upcoming.slice(0, 3).map(t => anyCard(t, extra)), 'Nothing scheduled yet.') +
    (upcoming.length > 3 ? '<p><a class="button-link" href="/calendar/">View more</a></p>' : '') +
    `<section class="hub-links"><h2>Hubs</h2>
      <div class="hub-buttons">
        <a class="hub-button" href="/uduk/"><b>UDUK</b><span>${esc(HUBS.uduk.blurb)}</span></a>
        <a class="hub-button" href="/franny/"><b>Franny</b><span>${esc(HUBS.franny.blurb)}</span></a>
        ${friendlyOn.data ? '<a class="hub-button" href="/friendly/"><b>Start a friendly</b><span>A one-off 1v1</span></a>' : ''}
      </div>
      ${hubsOn.data === false ? '<p class="muted small">Starting UDUK and Franny matches is switched off at the moment.</p>' : ''}
    </section>` +
    `<section class="recent-results"><h2>Recent results</h2>
      ${resultGroups.length ? resultGroups.map(([k, title]) => `<div class="hub-group">
          <h3>${title}</h3>
          <div class="t-grid">${recent[k].map(t => anyCard(t, extra)).join('')}</div>
        </div>`).join('') : '<p class="muted">No results yet.</p>'}
      <p><a class="button-link" href="/archive/">Show more results</a></p>
    </section>`;
}

load();
sb.channel('tournaments')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, debounce(jittered(load)))
  .subscribe();

// Entry point: never leaves the page sitting on "Loading…".
async function load() {
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}
