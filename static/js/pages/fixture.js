import { sb, showLoadError, showMissing, validId, qs, esc, fmtDate, debounce, toast, currentUserId, ensureSignedIn, HUBS, MATCH_SELECT } from '../db.js';
import { matchCard, setWatching } from '../ui.js';
import { venuePicker, bindVenue, readVenue } from '../events.js';
import { teamPreview, matchChance, pctPair } from '../winprob.js';

// A UDUK or Franny team match: the two teams, the score in games won, and
// every game in order. Each game opens on the match page, where its players
// are picked and it's scored.
const app = document.getElementById('app');
const id = qs('id');
const S = { t: null, games: [], admin: false, uid: null, bullEdit: false, timeEdit: false, edit: false };
const HUB_PW_KEY = 'uosdarts:hubpw';
const savedHubPw = () => { try { return localStorage.getItem(HUB_PW_KEY) ?? ''; } catch { return ''; } };
const PW_KEY = () => `uosdarts:pw:${id}`;
const savedPw = () => { try { return localStorage.getItem(PW_KEY()) ?? ''; } catch { return ''; } };

const TYPE = { singles: 'Singles', doubles: 'Doubles', trebles: 'Trebles', decider: 'Decider' };

// Who throws first. UDUK: the bull off winners in the odd games, counting
// every game in order. Franny: the away team in the odd games.
function throwPanel() {
  const t = S.t;
  if (t.kind === 'franny') return '';
  const started = S.games.some(g => g.status !== 'pending');
  const team = n => n === 1 ? t.home_team : t.away_team;
  if (t.bull_winner && !S.bullEdit) {
    return `<p class="muted small center">${esc(team(t.bull_winner))} won the bull.
      ${started ? '' : '<button data-act="bull-edit" class="link">Change</button>'}</p>`;
  }
  return `<div class="panel narrow center fx-bull">
      <h3>Who won the bull off?</h3>
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

// ---------------------------------------------------------------- win chart

// Once a team match is over: how each team's chance of winning it moved,
// game by game. Each game's chance comes from its players, the same way as
// the match odds, with anyone not on the site counted as an average player.
// The team match chance is then every way the games still to come could go.
const isHomeWin = g => (g.sets_to_win ? g.p1_sets > g.p2_sets : g.p1_legs > g.p2_legs);

async function loadChart() {
  if (S.t.status !== 'complete' || S.chance) return;
  const [fp, oom] = await Promise.all([sb.rpc('fixture_preview', { p_tournament: id }), sb.rpc('oom_table')]);
  if (fp.error) return;
  S.chance = new Map(S.games.map(g => {
    const pv = teamPreview(fp.data?.[g.id], oom.data ?? [], true);
    return [g.id, pv ? matchChance(pv, g) : 0.5];
  }));
}

function homeChance(regular, done, decider) {
  let h = 0, a = 0, dist = [1];
  for (const g of regular) {
    if (done.has(g.id)) { if (isHomeWin(g)) h++; else a++; continue; }
    const p = S.chance.get(g.id) ?? 0.5;
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((q, k) => { next[k + 1] += q * p; next[k] += q * (1 - p); });
    dist = next;
  }
  const rem = dist.length - 1;
  return dist.reduce((t, q, k) => {
    const H = h + k, A = a + rem - k;
    return t + (H > A ? q : H === A ? q * decider : 0);
  }, 0);
}

function chartPoints() {
  const regular = S.games.filter(g => g.game_type !== 'decider');
  const dec = S.games.find(g => g.game_type === 'decider');
  const decChance = dec ? (dec.status === 'complete' ? (isHomeWin(dec) ? 1 : 0) : S.chance.get(dec.id) ?? 0.5) : 0.5;
  const order = regular.filter(g => g.status === 'complete')
    .sort((a, b) => new Date(a.finished_at ?? 0) - new Date(b.finished_at ?? 0) || a.slot - b.slot);
  const done = new Set();
  let h = 0, a = 0;
  const pts = [{ p: homeChance(regular, done, dec ? (S.chance.get(dec.id) ?? 0.5) : 0.5), label: 'Before the first game' }];
  for (const g of order) {
    done.add(g.id);
    if (isHomeWin(g)) h++; else a++;
    const last = done.size === regular.length && !dec;
    pts.push({ p: homeChance(regular, done, dec ? (S.chance.get(dec.id) ?? 0.5) : 0.5), label: `After ${g.game_label ?? 'game'} · ${h}–${a}`, last });
  }
  if (dec?.status === 'complete') pts.push({ p: decChance, label: `After the decider · ${h + (decChance ? 1 : 0)}–${a + (decChance ? 0 : 1)}`, last: true });
  return pts;
}

function winChart() {
  if (S.t.status !== 'complete' || !S.chance) return '';
  const pts = chartPoints();
  if (pts.length < 2) return '';
  const { home, away } = score();
  const homeTop = home >= away;
  const top = homeTop ? S.t.home_team : S.t.away_team, bottom = homeTop ? S.t.away_team : S.t.home_team;
  const ys = pts.map(x => (homeTop ? x.p : 1 - x.p));
  const W = 600, H = 180, n = ys.length - 1;
  const xAt = i => (i / n) * W;
  const line = ys.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${((1 - p) * H).toFixed(1)}`).join(' ');
  return `<section class="win-chart">
    <h2>Win probability</h2>
    <div class="wc-frame fx-wc" data-ys="${esc(JSON.stringify(ys.map(p => Math.round(p * 10000) / 10000)))}"
         data-labels="${esc(JSON.stringify(pts.map(x => x.label)))}" data-top="${esc(top)}" data-bottom="${esc(bottom)}">
      <span class="wc-name top">${esc(top)}</span>
      <div class="wc-guide" hidden></div><div class="wc-dot" hidden></div><div class="wc-tip" hidden></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Win probability game by game, ending with ${esc(top)} winning">
        <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="wc-mid" vector-effect="non-scaling-stroke"/>
        ${ys.slice(1, -1).map((_, i) => `<line x1="${xAt(i + 1)}" x2="${xAt(i + 1)}" y1="0" y2="${H}" class="wc-leg" vector-effect="non-scaling-stroke"/>`).join('')}
        <path d="${line} L${W},${H / 2} L0,${H / 2} Z" class="wc-area"/>
        <path d="${line}" class="wc-line" vector-effect="non-scaling-stroke"/>
      </svg>
      <span class="wc-name bottom">${esc(bottom)}</span>
    </div>
  </section>`;
}

// Hover with a mouse, or tap (and slide) on a phone, to read it after any game.
function chartAt(frame, clientX) {
  const ys = JSON.parse(frame.dataset.ys), labels = JSON.parse(frame.dataset.labels);
  const r = frame.getBoundingClientRect();
  const n = ys.length - 1;
  const i = Math.max(0, Math.min(n, Math.round(((clientX - r.left) / r.width) * n)));
  const xPct = (i / n) * 100;
  const [g, d, tip] = ['.wc-guide', '.wc-dot', '.wc-tip'].map(s => frame.querySelector(s));
  g.style.left = d.style.left = `${xPct}%`;
  d.style.top = `${(1 - ys[i]) * 100}%`;
  const [a, b] = pctPair(ys[i], i === n);
  tip.innerHTML = `<b>${esc(frame.dataset.top)} ${a}%</b><span>${esc(frame.dataset.bottom)} ${b}%</span><small>${esc(labels[i])}</small>`;
  tip.style.left = xPct > 55 ? '' : `calc(${xPct}% + 10px)`;
  tip.style.right = xPct > 55 ? `calc(${100 - xPct}% + 10px)` : '';
  g.hidden = d.hidden = tip.hidden = false;
}
const chartOff = f => f.querySelectorAll('.wc-guide, .wc-dot, .wc-tip').forEach(el => { el.hidden = true; });
app.addEventListener('pointermove', e => {
  const f = e.target.closest?.('.fx-wc');
  if (f && (e.pointerType === 'mouse' || e.buttons)) chartAt(f, e.clientX);
});
app.addEventListener('pointerdown', e => {
  const f = e.target.closest?.('.fx-wc');
  if (f) chartAt(f, e.clientX); else app.querySelectorAll('.fx-wc').forEach(chartOff);
});
app.addEventListener('pointerout', e => {
  const f = e.target.closest?.('.fx-wc');
  if (f && e.pointerType === 'mouse' && !f.contains(e.relatedTarget)) chartOff(f);
});

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

// Change the teams, venue, time, scoring password or (before any game has
// started) the UDUK competition. Needs the team match password.
function editForm() {
  const t = S.t, hub = HUBS[t.kind];
  const started = S.games.some(g => g.status !== 'pending');
  return `<form class="panel narrow hub-form fx-edit" data-form="edit">
    <h2>Edit match</h2>
    <datalist id="our-teams">${hub.teams.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <div class="row hub-teams">
      <label>Home <input name="home" list="our-teams" maxlength="40" required value="${esc(t.home_team)}"></label>
      <label>Away <input name="away" list="our-teams" maxlength="40" required value="${esc(t.away_team)}"></label>
    </div>
    ${t.kind === 'uduk' ? `<div class="seg" role="radiogroup" aria-label="Competition">
      <label><input type="radio" name="competition" value="league" ${t.competition === 'league' ? 'checked' : ''} ${started ? 'disabled' : ''}> League</label>
      <label><input type="radio" name="competition" value="cup" ${t.competition === 'cup' ? 'checked' : ''} ${started ? 'disabled' : ''}> Cup</label>
    </div>
    <p class="muted small">${started ? 'Games have started, so the competition is fixed.' : 'Changing the competition sets up the games again and clears any players picked.'}</p>` : ''}
    ${venuePicker(t.venue)}
    ${t.status === 'upcoming' ? `<label>Start time <input name="when" type="datetime-local" value="${localValue(t.starts_at)}"></label>` : ''}
    <label>New scoring password <input name="spw" type="text" autocomplete="off" minlength="4" maxlength="40" placeholder="Leave blank to keep the current one"></label>
    <label>Team match password <input name="pw" type="password" autocomplete="off" value="${esc(savedHubPw())}" ${S.admin ? '' : 'required'}></label>
    <div class="modal-btns">
      <button class="primary">Save changes</button>
      <button type="button" data-act="edit-cancel">Cancel</button>
    </div>
  </form>`;
}

function render() {
  const t = S.t, hub = HUBS[t.kind];
  if (S.edit) {
    app.innerHTML = `<a class="back-link plain" href="/${t.kind}/">‹ ${hub.name} hub</a>${editForm()}`;
    return;
  }
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
    <p class="muted center small">${hub.name}${t.competition ? ` ${t.competition}` : ''} · ${fmtDate(t.starts_at ?? t.created_at)}${t.venue ? ` · ${esc(t.venue)}` : ''} ·
      ${t.status === 'complete' ? 'Full time' : `${done} of ${S.games.length} games played`}
      ${t.status === 'live' ? '<span class="badge live">Live</span>' : ''}</p>
    ${timePanel()}
    ${throwPanel()}
    ${blocks().map(b => `<section class="fx-block">
        <h2>${TYPE[b.g.game_type] ?? 'Games'} <span class="muted small">best of ${b.g.legs_to_win * 2 - 1} · ${b.g.start_score}</span></h2>
        ${b.g.game_type === 'decider' ? '<p class="muted small">The match finished level. One leg of 1001, with every player in both squads throwing in turn.</p>' : ''}
        <div class="m-grid">${b.games.map(g => matchCard(g, 1)).join('')}</div>
      </section>`).join('')}
    ${winChart()}
    ${t.status === 'complete' ? '' : '<p class="muted small">Tap a game to pick players and score it.</p>'}
    <p class="fx-actions"><button data-act="edit" class="link">Edit match</button>
    ${canDelete && t.status !== 'complete' ? '<button data-act="delete" class="link danger-link">Delete this match</button>' : ''}</p>`;
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
  await loadChart();
  document.title = `${S.t.home_team} v ${S.t.away_team} · ${HUBS[S.t.kind].name}`;
  render();
}

app.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'edit') { S.edit = true; render(); return; }
  if (act === 'edit-cancel') { S.edit = false; render(); return; }
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

bindVenue(app);
app.addEventListener('submit', async e => {
  if (!e.target.matches('[data-form="edit"]')) return;
  e.preventDefault();
  const f = new FormData(e.target);
  const comp = S.t.kind === 'uduk' ? (f.get('competition') ?? S.t.competition) : null;
  if (comp !== S.t.competition && !confirm('Changing the competition sets up the games again and clears any players picked. Carry on?')) return;
  const btn = e.target.querySelector('button.primary');
  btn.disabled = true;
  try {
    await ensureSignedIn();
    const pw = String(f.get('pw') ?? '').trim();
    const spw = String(f.get('spw') ?? '').trim();
    const when = f.get('when');
    const { error } = await sb.rpc('update_fixture', {
      p_tournament: id, p_password: pw, p_home: String(f.get('home')).trim(), p_away: String(f.get('away')).trim(),
      p_competition: comp, p_venue: readVenue(e.target), p_scoring_password: spw || null,
      // Only sent when changed, so an unstarted match from earlier today can still be edited.
      p_starts_at: when && when !== localValue(S.t.starts_at) ? new Date(String(when)).toISOString() : null,
    });
    if (error) throw error;
    try {
      if (pw) localStorage.setItem(HUB_PW_KEY, pw);
      if (spw) localStorage.setItem(PW_KEY(), spw);
    } catch { /* private mode */ }
    S.edit = false;
    toast('Match updated');
    await load();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

// Don't redraw over the edit form while someone's filling it in.
const reload = debounce(() => { if (!S.edit) load(); }, 300);
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
  if (S.t && !S.edit) render();
}).subscribe();

load();
(async () => {
  S.uid = await currentUserId().catch(() => null);
  S.admin = !!(await sb.rpc('my_admin_role')).data;
  if (S.t && !S.edit) render();
})();

async function load() {
  try { await loadInner(); } catch (e) { showLoadError(app, e); }
}
