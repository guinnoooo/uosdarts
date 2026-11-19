import { sb, showLoadError, esc, qs, debounce } from '../db.js';
import { anyCard, cardData } from '../events.js';

// Every finished tournament, team match and friendly, newest first, with
// filters for the kind of game, a date range and a name search.
const app = document.getElementById('app');
const PAGE = 24;
const TYPES = [['', 'Everything'], ['tournament', 'Tournaments'], ['uduk', 'UDUK'], ['franny', 'Franny'], ['friendly', 'Friendlies']];

const S = {
  type: TYPES.some(([v]) => v === qs('type')) ? qs('type') : '',
  from: '', to: '', q: '',
  rows: [], extra: { match: new Map(), score: new Map() }, more: false, loading: false,
};

function query(offset) {
  let q = sb.from('tournaments').select('*, champion:players!tournaments_champion_id_fkey(id,name)')
    .eq('status', 'complete').is('deleted_at', null)
    .order('starts_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + PAGE);   // one extra row tells us if there's another page
  if (S.type === 'tournament') q = q.is('kind', null).eq('is_friendly', false);
  else if (S.type === 'friendly') q = q.eq('is_friendly', true);
  else if (S.type) q = q.eq('kind', S.type);
  if (S.from) q = q.gte('starts_at', `${S.from}T00:00:00`);
  if (S.to) q = q.lte('starts_at', `${S.to}T23:59:59`);
  if (S.q) q = q.ilike('name', `%${S.q.replace(/[%_,()]/g, ' ')}%`);
  return q;
}

async function fetchPage(reset) {
  S.loading = true;
  drawList();
  const { data, error } = await query(reset ? 0 : S.rows.length);
  S.loading = false;
  if (error) throw error;
  const page = data.slice(0, PAGE);
  S.more = data.length > PAGE;
  const extra = await cardData(page);
  if (reset) {
    S.rows = page;
    S.extra = extra;
  } else {
    S.rows.push(...page);
    for (const [k, v] of extra.match) S.extra.match.set(k, v);
    for (const [k, v] of extra.score) S.extra.score.set(k, v);
  }
  drawList();
}

function drawList() {
  const box = app.querySelector('#archive-list');
  if (!box) return;
  box.innerHTML = S.rows.length
    ? `<div class="t-grid">${S.rows.map(t => anyCard(t, S.extra)).join('')}</div>
       ${S.more ? `<p class="center"><button data-act="more" ${S.loading ? 'disabled' : ''}>${S.loading ? 'Loading…' : 'Show more'}</button></p>` : ''}`
    : `<p class="muted">${S.loading ? 'Loading…' : 'No results match those filters.'}</p>`;
}

function render() {
  app.innerHTML = `
    <div class="page-head"><h1>Results</h1></div>
    <form class="archive-filters panel" onsubmit="return false">
      <div class="seg archive-types" role="radiogroup" aria-label="Type">
        ${TYPES.map(([v, label]) => `<label><input type="radio" name="type" value="${v}" ${S.type === v ? 'checked' : ''}> ${label}</label>`).join('')}
      </div>
      <div class="row">
        <label>From <input type="date" name="from" value="${S.from}"></label>
        <label>To <input type="date" name="to" value="${S.to}"></label>
        <label class="grow">Search <input type="search" name="q" placeholder="Name or team" value="${esc(S.q)}"></label>
      </div>
    </form>
    <div id="archive-list"></div>`;
  drawList();
}

const refetch = debounce(() => fetchPage(true).catch(e => showLoadError(app, e)), 300);

app.addEventListener('change', e => {
  const { name, value } = e.target;
  if (name === 'type' || name === 'from' || name === 'to') {
    S[name] = value;
    if (name === 'type') history.replaceState(null, '', value ? `?type=${value}` : location.pathname);
    refetch();
  }
});
app.addEventListener('input', e => {
  if (e.target.name === 'q') { S.q = e.target.value.trim(); refetch(); }
});
app.addEventListener('click', e => {
  if (e.target.closest('[data-act="more"]') && !S.loading) fetchPage(false).catch(err => showLoadError(app, err));
});

render();
fetchPage(true).catch(e => showLoadError(app, e));
