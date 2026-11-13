import {
  sb, showLoadError, showMissing, validId, qs, esc, debounce, toast, ensureSignedIn, currentUserId, matchLabel, MATCH_SELECT,
} from '../db.js';
import { checkout, minDarts, isValidVisit, playerStats, QUICK_SCORES } from '../darts.js';

const app = document.getElementById('app');
const id = qs('id');

const S = {
  match: null, legs: [], visits: [], koRounds: 0, uid: null,
  entry: '', busy: false, pendingCheckout: null, pendingDoubles: null, askPw: false,
  shotTimer: null,
};

// ---------------------------------------------------------------- data

async function loadInner() {
  const [m, l, v] = await Promise.all([
    sb.from('matches').select(`${MATCH_SELECT}, tournament:tournaments(id,name,requires_password)`).eq('id', id).single(),
    sb.from('legs').select('*').eq('match_id', id).order('leg_no'),
    sb.from('visits').select('*').eq('match_id', id).order('id'),
  ]);
  const err = m.error || l.error || v.error;
  if (err) {
    app.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  S.match = m.data;
  S.legs = l.data;
  S.visits = v.data;
  S.uid = await currentUserId();

  if (S.match.stage === 'knockout' && !S.koRounds) {
    const r = await sb.from('matches').select('round').eq('tournament_id', S.match.tournament_id)
      .eq('stage', 'knockout').order('round', { ascending: false }).limit(1);
    S.koRounds = r.data?.[0]?.round ?? 1;
  }
  render();
}
const reload = debounce(load, 120);

// Pulls only the visits recorded since the last one we hold, instead of the
// whole match every time a dart is thrown. Returns false when a plain top-up
// can't be trusted, in which case the caller does a full reload.
async function topUp(row) {
  const prev = S.match;
  if (!prev || row.id !== prev.id) return false;
  // Scores going backwards means an undo or an admin edit: refetch properly.
  if (row.p1_legs + row.p2_legs < prev.p1_legs + prev.p2_legs) return false;
  if (row.status !== prev.status) return false;

  // A leg has been won, so the legs table has changed underneath us: the old
  // leg gained a winner and a new one was inserted.
  const legWon = (row.p1_legs + row.p2_legs) > (prev.p1_legs + prev.p2_legs);

  const lastId = S.visits.length ? S.visits[S.visits.length - 1].id : 0;
  const { data, error } = await sb.from('visits').select('*')
    .eq('match_id', id).gt('id', lastId).order('id');
  if (error) return false;

  // Two updates can describe the same visit, so never add one twice.
  const known = new Set(S.visits.map(v => v.id));
  const fresh = data.filter(v => !known.has(v.id));

  // Nothing new and no leg change, but the row moved anyway: reload properly.
  if (!fresh.length && !legWon) return false;
  S.visits.push(...fresh);

  if (legWon || fresh.some(v => !S.legs.some(l => l.id === v.leg_id))) {
    const legs = await sb.from('legs').select('*').eq('match_id', id).order('leg_no');
    if (legs.error) return false;
    S.legs = legs.data;
  }

  S.match = { ...prev, ...row, p1: prev.p1, p2: prev.p2, tournament: prev.tournament };
  render();
  return true;
}

// Realtime updates are handled one at a time. record_visit can emit two row
// updates for a single visit, and letting them overlap used to fetch the same
// visit twice and count its darts at double twice.
let queue = Promise.resolve();
async function onMatchRow(row) {
  if (S.busy) return;                       // our own write, load() follows it
  const prev = S.match;
  const legWon = prev && (row.p1_legs + row.p2_legs) > (prev.p1_legs + prev.p2_legs);
  const winner = legWon ? (row.p1_legs > prev.p1_legs ? 1 : 2) : null;
  const legNo = row.p1_legs + row.p2_legs;

  if (!await topUp(row)) await load();

  // Spectators get a brief confirmation, then the next leg. The scorer already
  // knows, having just entered it, and the end of the match has its own banner.
  if (legWon && !isScorer() && row.status !== 'complete') {
    showGameShot(winner, legNo);
  }
}

// Lives on <body>, outside the markup render() replaces. Keeping it inside
// meant the second update for the same leg rebuilt the node and restarted its
// fade-in, which looked like the card flashing twice.
function showGameShot(player, legNo) {
  clearTimeout(S.shotTimer);
  let el = document.getElementById('game-shot');
  if (!el) {
    el = document.createElement('div');
    el.id = 'game-shot';
    el.className = 'modal shot';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="shot-box">
    <div class="shot-title">Game shot</div>
    <div class="shot-name">${esc(nameOf(player))}</div>
    <div class="shot-leg">wins leg ${legNo}</div>
  </div>`;
  S.shotTimer = setTimeout(() => el.remove(), 2600);
}

function derive() {
  const m = S.match;
  const leg = S.legs[S.legs.length - 1] ?? null;
  const legVisits = leg ? S.visits.filter(v => v.leg_id === leg.id) : [];
  const rem = { 1: m.start_score, 2: m.start_score };
  for (const v of legVisits) rem[v.player] = v.remaining;
  const turn = m.status === 'live' && leg && !leg.winner
    ? (legVisits.length % 2 === 0 ? leg.starter : 3 - leg.starter)
    : null;
  return { leg, legVisits, rem, turn };
}

const nameOf = n => (n === 1 ? S.match.p1?.name : S.match.p2?.name) ?? 'TBC';
const isScorer = () => !!S.match.scorer_id && S.match.scorer_id === S.uid;

// ---------------------------------------------------------------- rendering

function playerPanel(n, d) {
  const m = S.match;
  const st = playerStats(S.visits, S.legs, n);
  const rem = d.rem[n];
  const co = d.turn === n ? checkout(rem) : null;
  const legDarts = d.legVisits.filter(v => v.player === n).reduce((a, v) => a + v.darts, 0);
  return `<div class="pp${d.turn === n ? ' on' : ''}${m.winner_id && m.winner_id === (n === 1 ? m.player1_id : m.player2_id) ? ' won' : ''}">
    <div class="pp-name">${d.leg?.starter === n && m.status === 'live' ? '<span class="dot" title="Threw first this leg"></span>' : ''}${esc(nameOf(n))}</div>
    <div class="pp-legs">${n === 1 ? m.p1_legs : m.p2_legs}</div>
    <div class="pp-rem">${m.status === 'pending' ? m.start_score : rem}</div>
    <div class="pp-co">${co ? co.join(' ') : '&nbsp;'}</div>
    <div class="pp-stats">Avg ${st.avg ? st.avg.toFixed(2) : '–'} · Darts ${legDarts}${st.dblAt ? ` · D ${st.dblPct.toFixed(0)}%` : ''}</div>
  </div>`;
}

function legTable(d) {
  if (!d.leg) return '';
  const starter = d.leg.starter;
  const a = d.legVisits.filter(v => v.player === starter);
  const b = d.legVisits.filter(v => v.player !== starter);
  // Chronological order: the first visit of the leg is the top row and each new
  // one is appended underneath, the way a paper scoresheet reads.
  const rows = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const byPlayer = { [starter]: a[i], [3 - starter]: b[i] };
    const cell = v => (v
      ? `<td class="${v.is_bust ? 'bust' : v.score >= 100 ? 'ton' : ''}">${v.is_bust ? 'BUST' : v.score}</td><td class="rem">${v.remaining}</td>`
      : '<td></td><td></td>');
    rows.push(`<tr>${cell(byPlayer[1])}<td class="darts">${(i + 1) * 3}</td>${cell(byPlayer[2])}</tr>`);
  }
  return `<section><h2>Leg ${d.leg.leg_no}</h2>
    <table class="leg"><thead><tr><th colspan="2">${esc(nameOf(1))}</th><th></th><th colspan="2">${esc(nameOf(2))}</th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="5" class="muted">No darts thrown yet</td></tr>'}</tbody></table></section>`;
}

function statsTable() {
  if (!S.visits.length) return '';
  const a = playerStats(S.visits, S.legs, 1);
  const b = playerStats(S.visits, S.legs, 2);
  const row = (label, x, y) => `<tr><td>${x ?? '–'}</td><th>${label}</th><td>${y ?? '–'}</td></tr>`;
  return `<section><h2>Match stats</h2><table class="stats">
    ${row('3-dart average', a.avg?.toFixed(2), b.avg?.toFixed(2))}
    ${row('100+', a.ton, b.ton)}
    ${row('140+', a.ton40, b.ton40)}
    ${row('180s', a.max, b.max)}
    ${row('High checkout', a.hiCheckout, b.hiCheckout)}
    ${row('Best leg (darts)', a.bestLeg, b.bestLeg)}
    ${row('Doubles', a.dblAt ? `${a.dblHit}/${a.dblAt} (${a.dblPct.toFixed(0)}%)` : null,
                     b.dblAt ? `${b.dblHit}/${b.dblAt} (${b.dblPct.toFixed(0)}%)` : null)}
  </table></section>`;
}

function keypad(d) {
  const rem = d.rem[d.turn];
  const canFinish = minDarts(rem) !== null;
  return `<div class="pad">
    <div class="pad-top">
      <div class="pad-turn">${esc(nameOf(d.turn))} to throw · <b>${rem}</b> left</div>
      <div class="pad-entry">${S.entry || '<span class="muted">Enter score</span>'}</div>
    </div>
    <div class="quick">${QUICK_SCORES.map(q => `<button data-quick="${q}">${q}</button>`).join('')}</div>
    <div class="keys">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => `<button data-key="${k}">${k}</button>`).join('')}
      <button data-key="back" class="muted-btn">⌫</button>
      <button data-key="0">0</button>
      <button data-act="enter" class="primary">Enter</button>
    </div>
    <div class="pad-actions">
      <button data-act="noscore">No score</button>
      ${canFinish ? `<button data-act="checkout" class="good">Checkout ${rem}</button>` : ''}
      <button data-act="undo">Undo</button>
    </div>
    <button data-act="release" class="link">Stop scoring this match</button>
  </div>`;
}

// Two questions on a checkout: total darts thrown, then how many of those
// were aimed at a double. The second one gives the doubles percentage.
function checkoutModal() {
  const { min, darts } = S.pendingCheckout;
  if (darts === null) {
    return `<div class="modal"><div class="modal-box">
      <h3>Game shot!</h3>
      <p class="modal-q">How many darts?</p>
      <div class="modal-btns">${[1, 2, 3].filter(n => n >= min)
        .map(n => `<button data-codarts="${n}" class="primary">${n}</button>`).join('')}</div>
      <button data-act="cancel-co" class="link">Cancel</button>
    </div></div>`;
  }
  return `<div class="modal"><div class="modal-box">
    <h3>${darts} dart${darts > 1 ? 's' : ''} thrown</h3>
    <p class="modal-q">How many darts at double?</p>
    <div class="modal-btns">${Array.from({ length: darts }, (_, i) => i + 1)
      .map(n => `<button data-codbl="${n}" class="primary">${n}</button>`).join('')}</div>
    <button data-act="back-co" class="link">Back</button>
  </div></div>`;
}

// Asked after a visit that left the player still on a finish, so misses count
// towards the doubles percentage rather than being invisible.
function doublesModal() {
  const { wasOn } = S.pendingDoubles;
  return `<div class="modal"><div class="modal-box">
    <h3>Was on ${wasOn}</h3>
    <p class="modal-q">How many darts at double?</p>
    <div class="modal-btns">${[0, 1, 2, 3]
      .map(n => `<button data-missdbl="${n}" class="primary">${n}</button>`).join('')}</div>
  </div></div>`;
}

function actionZone(d) {
  const m = S.match;
  const ready = m.player1_id && m.player2_id;

  if (m.status === 'complete') {
    const w = m.winner_id === m.player1_id ? 1 : 2;
    return `<div class="banner">${esc(nameOf(w))} wins ${Math.max(m.p1_legs, m.p2_legs)}–${Math.min(m.p1_legs, m.p2_legs)}</div>
      ${isScorer() ? '<div class="center"><button data-act="undo">Undo last visit</button></div>' : ''}`;
  }
  if (isScorer() && m.status === 'pending') {
    return `<div class="panel center"><h3>Who won the bull?</h3>
      <div class="modal-btns">
        <button data-first="1" class="primary">${esc(nameOf(1))}</button>
        <button data-first="2" class="primary">${esc(nameOf(2))}</button>
      </div>
      <button data-act="release" class="link">Cancel, I'm not scoring</button></div>`;
  }
  if (isScorer() && m.status === 'live') return keypad(d);
  if (!m.scorer_id && ready) {
    if (S.askPw) {
      return `<div class="panel center pw-panel">
        <h3>Scoring password</h3>
        <p class="muted">Ask whoever is running the tournament.</p>
        <input id="pw-input" type="password" autocomplete="off" placeholder="Password" autofocus>
        <div class="modal-btns">
          <button data-act="pw-submit" class="primary">Start scoring</button>
          <button data-act="pw-cancel">Cancel</button>
        </div></div>`;
    }
    return `<div class="panel center">
      <p>${m.status === 'live' ? 'This match has lost its scorer.' : 'This match needs a scorer.'}</p>
      <button data-act="claim" class="primary big">Score this match</button>
      ${m.tournament?.requires_password ? '<p class="muted small">A scoring password is needed.</p>' : ''}
      </div>`;
  }
  if (m.scorer_id) return '<p class="muted center">Being scored live. Updates appear automatically.</p>';
  return '<p class="muted center">Waiting for both players to be decided.</p>';
}

function render() {
  const m = S.match;
  const d = derive();
  const scoring = isScorer() && m.status === 'live';
  app.innerHTML = `
    <div class="m-head">
      <a href="/tournament/?id=${m.tournament_id}">${esc(m.tournament?.name)}</a>
      <span>${esc(matchLabel(m, S.koRounds))} · First to ${m.legs_to_win} legs${m.board ? ` · Board ${esc(m.board)}` : ''}</span>
    </div>
    <div class="scoreboard">${playerPanel(1, d)}${playerPanel(2, d)}</div>
    ${actionZone(d)}
    ${scoring ? '' : legTable(d)}
    ${scoring ? '' : statsTable()}
    ${S.pendingCheckout ? checkoutModal() : S.pendingDoubles ? doublesModal() : ''}`;
  if (S.askPw) app.querySelector('#pw-input')?.focus();
}

// ---------------------------------------------------------------- actions

async function rpc(fn, args) {
  if (S.busy) return false;
  S.busy = true;
  try {
    const { error } = await sb.rpc(fn, args);
    if (error) throw error;
    await load();
    return true;
  } catch (e) {
    toast(e.message);
    await load();
    return false;
  } finally {
    S.busy = false;
  }
}

async function submit(score) {
  const d = derive();
  const rem = d.rem[d.turn];
  if (!isValidVisit(score)) {
    toast(`${score} isn't a possible score`);
    S.entry = '';
    render();
    return;
  }

  if (score === rem) {
    const min = minDarts(rem);
    if (!min) { toast(`${rem} can't be checked out in one visit`); return; }
    S.entry = '';
    S.pendingCheckout = { score, min, darts: null };
    render();
    return;
  }

  if (rem - score < 2 && !confirm(`${score} from ${rem} is a bust. Record it as a bust?`)) return;
  S.entry = '';

  // If they were on a finish and didn't take it, ask how many darts they used
  // at the double so the percentage counts the misses.
  if (minDarts(rem) !== null) {
    S.pendingDoubles = { score, wasOn: rem };
    render();
    return;
  }
  await rpc('record_visit', { p_match: id, p_score: score, p_darts: 3, p_doubles: 0 });
}

// The password is remembered per tournament so a scorer types it once a night.
function pwKey() { return `uosdarts:pw:${S.match.tournament_id}`; }
function savedPw() { try { return localStorage.getItem(pwKey()) ?? ''; } catch { return ''; } }
function rememberPw(v) { try { localStorage.setItem(pwKey(), v); } catch { /* private mode */ } }
function forgetPw() { try { localStorage.removeItem(pwKey()); } catch { /* private mode */ } }

async function claim(password = null) {
  try {
    await ensureSignedIn();
    S.uid = await currentUserId();
  } catch (e) {
    toast(`Couldn't sign in: ${e.message}`);
    return;
  }
  const ok = await rpc('claim_match', { p_match: id, p_password: password });
  if (ok && password) rememberPw(password);
  if (!ok && password) {
    forgetPw();
    S.askPw = true;
    render();
  }
}

// Try a remembered password first, only ask if there isn't one.
async function startClaim() {
  if (!S.match.tournament?.requires_password) return claim(null);
  const saved = savedPw();
  if (saved) return claim(saved);
  S.askPw = true;
  render();
}

app.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;
  const { key, quick, act, first, codarts, codbl, missdbl } = el.dataset;

  if (key) {
    if (key === 'back') S.entry = S.entry.slice(0, -1);
    else if (S.entry.length < 3) S.entry = (S.entry + key).replace(/^0+(?=\d)/, '');
    render();
  } else if (quick) {
    await submit(Number(quick));
  } else if (first) {
    await rpc('start_match', { p_match: id, p_first: Number(first) });
  } else if (codarts) {
    S.pendingCheckout = { ...S.pendingCheckout, darts: Number(codarts) };
    render();
  } else if (codbl) {
    const { score, darts } = S.pendingCheckout;
    S.pendingCheckout = null;
    S.entry = '';
    await rpc('record_visit', { p_match: id, p_score: score, p_darts: darts, p_doubles: Number(codbl) });
  } else if (missdbl !== undefined) {
    const { score } = S.pendingDoubles;
    S.pendingDoubles = null;
    S.entry = '';
    await rpc('record_visit', { p_match: id, p_score: score, p_darts: 3, p_doubles: Number(missdbl) });
  } else if (act === 'enter') {
    if (S.entry !== '') await submit(Number(S.entry));
  } else if (act === 'noscore') {
    await submit(0);
  } else if (act === 'checkout') {
    const d = derive();
    await submit(d.rem[d.turn]);
  } else if (act === 'undo') {
    S.entry = '';
    await rpc('undo_visit', { p_match: id });
  } else if (act === 'claim') {
    await startClaim();
  } else if (act === 'pw-submit') {
    const input = app.querySelector('#pw-input');
    const v = input?.value.trim() ?? '';
    if (!v) { toast('Enter the scoring password'); return; }
    S.askPw = false;
    await claim(v);
  } else if (act === 'pw-cancel') {
    S.askPw = false;
    render();
  } else if (act === 'release') {
    if (confirm('Stop scoring? Someone else will be able to take over.')) {
      await rpc('release_match', { p_match: id });
    }
  } else if (act === 'cancel-co') {
    S.pendingCheckout = null;
    render();
  } else if (act === 'back-co') {
    S.pendingCheckout = { ...S.pendingCheckout, darts: null };
    render();
  }
});

// Physical keyboard support for scorers on a laptop
document.addEventListener('keydown', async e => {
  if (S.askPw) {
    if (e.key === 'Enter') {
      const v = app.querySelector('#pw-input')?.value.trim() ?? '';
      if (v) { S.askPw = false; await claim(v); }
    }
    return;
  }
  if (!S.match || !isScorer() || S.match.status !== 'live' || S.pendingCheckout || S.pendingDoubles) return;
  if (/^\d$/.test(e.key) && S.entry.length < 3) {
    S.entry = (S.entry + e.key).replace(/^0+(?=\d)/, '');
    render();
  } else if (e.key === 'Backspace') {
    S.entry = S.entry.slice(0, -1);
    render();
  } else if (e.key === 'Enter' && S.entry !== '') {
    await submit(Number(S.entry));
  }
});

load();
let subscribed = false;
sb.channel(`m-${id}`)
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${id}` },
    ({ new: row }) => { queue = queue.then(() => onMatchRow(row)).catch(() => reload()); })
  .subscribe(status => {
    if (status !== 'SUBSCRIBED') return;
    if (subscribed) reload();          // reconnected, so catch up on anything missed
    subscribed = true;
  });

// Backstop in case a realtime message never arrives.
setInterval(() => {
  if (document.visibilityState === 'visible' && S.match?.status === 'live' && !S.busy) load();
}, 120000);

// Phones drop websocket connections when the screen locks; catch up on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reload();
});

// Entry point: never leaves the page sitting on "Loading…".
async function load() {
  if (!validId(id)) { showMissing(app, 'match'); return; }
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}
