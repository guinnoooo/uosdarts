import { sb, showLoadError, debounce } from '../db.js';
import { kindOf, anyCard, cardData, europaVisible } from '../events.js';

// Everything coming up: tournaments and booked UDUK and Franny matches,
// soonest first, grouped by month and then by day.
const app = document.getElementById('app');

const thisYear = new Date().getFullYear();
const monthKey = d => {
  const x = new Date(d);
  return x.toLocaleDateString('en-GB', x.getFullYear() === thisYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
};
const dayKey = d => new Date(d).toDateString();

async function loadInner() {
  const { data, error } = await sb.from('tournaments')
    .select('*, champion:players!tournaments_champion_id_fkey(id,name)')
    .in('status', ['upcoming', 'live']).is('deleted_at', null)
    .order('starts_at', { ascending: true, nullsFirst: false });
  if (error) throw error;
  const list = data.filter(t => t.status === 'upcoming' && kindOf(t) !== 'friendly').filter(europaVisible(data));
  const extra = await cardData(list.filter(t => t.kind));

  // months: [{ name, days: [{ date, items }] }], with undated events last.
  const months = [];
  const undated = [];
  for (const t of list) {
    if (!t.starts_at) { undated.push(t); continue; }
    const m = monthKey(t.starts_at);
    if (months.at(-1)?.name !== m) months.push({ name: m, days: [] });
    const days = months.at(-1).days;
    if (days.at(-1)?.key === dayKey(t.starts_at)) days.at(-1).items.push(t);
    else days.push({ key: dayKey(t.starts_at), date: new Date(t.starts_at), items: [t] });
  }

  const dayRow = d => `<div class="cal-row">
      <div class="cal-date"><span>${d.date.toLocaleDateString('en-GB', { weekday: 'short' })}</span><b>${d.date.getDate()}</b></div>
      <div class="t-grid cal-items">${d.items.map(t => anyCard(t, extra)).join('')}</div>
    </div>`;

  app.innerHTML = `
    <a class="back-link plain" href="/">‹ Match Hub</a>
    <div class="page-head"><h1>Calendar</h1></div>
    ${months.map(m => `<section class="cal-month"><h2>${m.name}</h2>${m.days.map(dayRow).join('')}</section>`).join('')}
    ${undated.length ? `<section class="cal-month"><h2>Date to be confirmed</h2>
        <div class="t-grid">${undated.map(t => anyCard(t, extra)).join('')}</div></section>` : ''}
    ${list.length ? '' : '<p class="muted">Nothing scheduled yet.</p>'}`;
}

async function load() {
  try { await loadInner(); } catch (e) { showLoadError(app, e); }
}

const reload = debounce(load, 400);
sb.channel('calendar')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, reload)
  .subscribe();

load();
