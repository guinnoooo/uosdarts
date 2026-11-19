import { sb, showLoadError, debounce } from '../db.js';
import { kindOf, anyCard, cardData, europaVisible } from '../events.js';

// Everything coming up: tournaments and booked UDUK and Franny matches,
// soonest first, under a heading for each day.
const app = document.getElementById('app');

const dayKey = d => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

async function loadInner() {
  const { data, error } = await sb.from('tournaments')
    .select('*, champion:players!tournaments_champion_id_fkey(id,name)')
    .in('status', ['upcoming', 'live']).is('deleted_at', null)
    .order('starts_at', { ascending: true, nullsFirst: false });
  if (error) throw error;
  const list = data.filter(t => t.status === 'upcoming' && kindOf(t) !== 'friendly').filter(europaVisible(data));
  const extra = await cardData(list.filter(t => t.kind));

  const days = [];
  for (const t of list) {
    const key = t.starts_at ? dayKey(t.starts_at) : 'Date to be confirmed';
    if (days.at(-1)?.key === key) days.at(-1).items.push(t);
    else days.push({ key, items: [t] });
  }

  app.innerHTML = `
    <a class="back-link plain" href="/">‹ Match Hub</a>
    <div class="page-head"><h1>Calendar</h1></div>
    ${days.length ? days.map(d => `<section class="cal-day"><h2>${d.key}</h2>
        <div class="t-grid">${d.items.map(t => anyCard(t, extra)).join('')}</div>
      </section>`).join('') : '<p class="muted">Nothing scheduled yet.</p>'}`;
}

async function load() {
  try { await loadInner(); } catch (e) { showLoadError(app, e); }
}

const reload = debounce(load, 400);
sb.channel('calendar')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, reload)
  .subscribe();

load();
