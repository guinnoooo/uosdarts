import { sb, showLoadError, esc, toast, debounce, ensureSignedIn, HUBS } from '../db.js';
import { fixtureCard, cardData, section } from '../events.js';

// The UDUK hub (Wednesday uni matches) and the Franny hub (Thursday
// Franchise League) share this page; the layout says which one it is.
const app = document.getElementById('app');
const KIND = app.dataset.kind;
const HUB = HUBS[KIND];
const PW_KEY = 'uosdarts:hubpw';
const savedPw = () => { try { return localStorage.getItem(PW_KEY) ?? ''; } catch { return ''; } };
const rememberPw = v => { try { localStorage.setItem(PW_KEY, v); } catch { /* private mode */ } };

const S = { form: { home: HUB.teams[0], homeOther: '', away: '', awayOther: '', competition: 'league', bull: '', later: false, when: '' } };

// A team box: our own teams to pick from, or "Another team" to type one in.
function teamPicker(side, label) {
  const f = S.form;
  const v = f[side];
  return `<label>${label}
    <select data-team="${side}">
      ${HUB.teams.map(t => `<option ${v === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      <option value="" ${HUB.teams.includes(v) ? '' : 'selected'}>Another team…</option>
    </select>
    <input data-other="${side}" maxlength="40" placeholder="Team name" value="${esc(f[`${side}Other`])}"
      ${HUB.teams.includes(v) ? 'hidden' : ''}>
  </label>`;
}

function startForm(enabled) {
  if (!enabled) return '<p class="muted">Starting matches here is switched off at the moment.</p>';
  return `<form class="panel narrow hub-form" data-form="start">
    <h2>Start a match</h2>
    <div class="row hub-teams">${teamPicker('home', 'Home')}${teamPicker('away', 'Away')}</div>
    ${KIND === 'uduk' ? `<div class="seg" role="radiogroup" aria-label="Competition">
      <label><input type="radio" name="competition" value="league" ${S.form.competition === 'league' ? 'checked' : ''}> League</label>
      <label><input type="radio" name="competition" value="cup" ${S.form.competition === 'cup' ? 'checked' : ''}> Cup</label>
    </div>` : ''}
    <p class="muted small hub-format">${formatLine()}</p>
    ${KIND === 'uduk' ? `<fieldset class="hub-bull"><legend>Who won the bull off?</legend>
      <div class="seg" role="radiogroup" aria-label="Bull off">
        <label><input type="radio" name="bull" value="1" ${S.form.bull === '1' ? 'checked' : ''}> Home</label>
        <label><input type="radio" name="bull" value="2" ${S.form.bull === '2' ? 'checked' : ''}> Away</label>
        <label><input type="radio" name="bull" value="" ${S.form.bull === '' ? 'checked' : ''}> Not yet</label>
      </div>
      <p class="muted small">The winners throw first in the odd numbered games. If you haven't done it yet, you can enter it on the match page.</p>
    </fieldset>` : '<p class="muted small">The away team throws first in singles 1, 3 and 5 and doubles 2.</p>'}
    <div class="hub-when">
      <div class="seg" role="radiogroup" aria-label="When">
        <label><input type="radio" name="later" value="" ${S.form.later ? '' : 'checked'}> Start now</label>
        <label><input type="radio" name="later" value="1" ${S.form.later ? 'checked' : ''}> Later</label>
      </div>
      <input name="when" type="datetime-local" value="${esc(S.form.when)}" ${S.form.later ? 'required' : 'hidden'}>
    </div>
    <label>Team match password <input name="pw" type="password" autocomplete="off" value="${esc(savedPw())}" required></label>
    <label>Scoring password for this match
      <input name="spw" type="text" autocomplete="off" minlength="4" maxlength="40" required placeholder="At least 4 characters">
    </label>
    <p class="muted small">Everyone scoring or picking players for this match's games uses the scoring password, so you can share it with the other team.</p>
    <button class="primary big" data-submit>${S.form.later ? 'Schedule match' : 'Start match'}</button>
  </form>`;
}

function formatLine() {
  if (KIND === 'franny') return '5 singles (best of 5, 501), then 2 doubles (best of 3, 701).';
  return S.form.competition === 'cup'
    ? '9 singles (best of 5, 501), 4 doubles (best of 3, 701), then 9 more singles (best of 5, 501).'
    : '2 trebles (best of 3, 701), 3 doubles (best of 3, 701), then 6 singles (best of 3, 501).';
}

async function loadInner() {
  const [list, on] = await Promise.all([
    sb.from('tournaments').select('*').eq('kind', KIND).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(40),
    sb.rpc('hub_enabled', { p_kind: KIND }),
  ]);
  if (list.error) throw list.error;
  const all = list.data;
  const live = all.filter(t => t.status === 'live');
  const waiting = all.filter(t => t.status === 'upcoming')
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const done = all.filter(t => t.status === 'complete').slice(0, 6);
  const extra = await cardData([...live, ...waiting, ...done]);
  const cards = l => l.map(t => fixtureCard(t, extra.score.get(t.id)));

  app.innerHTML = `
    <div class="page-head"><h1>${HUB.name}</h1><p class="muted">${esc(HUB.blurb)}</p></div>
    ${section('Live', cards(live), 'Nothing being played right now.')}
    ${waiting.length ? section('Coming up', cards(waiting), '') : ''}
    ${startForm(!!on.data)}
    ${section('Recent results', cards(done), 'No results yet.')}
    <p><a class="button-link" href="/archive/?type=${KIND}">All ${HUB.name} results</a></p>`;
}

// Keep the form's choices when the page redraws.
app.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.team) {
    S.form[t.dataset.team] = t.value;
    const other = app.querySelector(`[data-other="${t.dataset.team}"]`);
    other.hidden = t.value !== '';
    if (!other.hidden) other.focus();
  } else if (t.name === 'later') {
    S.form.later = !!t.value;
    const w = app.querySelector('[name=when]');
    w.hidden = !S.form.later;
    w.required = S.form.later;
    if (S.form.later) w.focus();
    app.querySelector('[data-submit]').textContent = S.form.later ? 'Schedule match' : 'Start match';
  } else if (t.name === 'when') {
    S.form.when = t.value;
  } else if (t.name === 'bull') {
    S.form.bull = t.value;
  } else if (t.name === 'competition') {
    S.form.competition = t.value;
    app.querySelector('.hub-format').textContent = formatLine();
  }
});
app.addEventListener('input', e => {
  if (e.target.dataset.other) S.form[`${e.target.dataset.other}Other`] = e.target.value;
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const team = side => (S.form[side] || S.form[`${side}Other`]).trim();
  const home = team('home'), away = team('away');
  if (!home || !away) { toast('Pick or type both teams'); return; }
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await ensureSignedIn();
    const pw = String(f.get('pw')).trim();
    const spw = String(f.get('spw')).trim();
    if (spw.length < 4) { toast('The scoring password needs at least 4 characters'); btn.disabled = false; return; }
    const when = S.form.later ? String(f.get('when') ?? '') : '';
    if (S.form.later && !when) { toast('Pick when the match starts'); btn.disabled = false; return; }
    const { data: id, error } = await sb.rpc('create_fixture', {
      p_kind: KIND, p_password: pw, p_home: home, p_away: away,
      p_competition: KIND === 'uduk' ? S.form.competition : null,
      p_scoring_password: spw,
      ...(when ? { p_starts_at: new Date(when).toISOString() } : {}),
    });
    if (error) throw error;
    rememberPw(pw);
    if (KIND === 'uduk' && S.form.bull) {
      const r = await sb.rpc('set_fixture_bull', { p_tournament: id, p_password: spw, p_side: Number(S.form.bull) });
      if (r.error) toast(r.error.message);
    }
    // Whoever set it up isn't asked for the match's password again on this phone.
    try { localStorage.setItem(`uosdarts:pw:${id}`, spw); } catch { /* private mode */ }
    location.href = `/fixture/?id=${id}`;
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

const reload = debounce(load, 400);
sb.channel(`hub-${KIND}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `kind=eq.${KIND}` }, reload)
  .subscribe();

load();
async function load() {
  // Don't redraw over a half-filled form.
  if (app.contains(document.activeElement) && document.activeElement.matches('input, select')) { reload(); return; }
  try { await loadInner(); } catch (e) { showLoadError(app, e); }
}
