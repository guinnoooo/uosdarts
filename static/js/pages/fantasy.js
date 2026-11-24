// Fantasy darts: five starters, each in a role, and one bench player, within a
// budget. Points come from every PC and major in the week. All the rules
// are checked again in the database (fantasy_save).

import { sb, esc, toast } from '../db.js';
import { loadAccount } from '../betting.js';

const app = document.getElementById('app');
const S = { team: null, market: [], board: [], squad: [null, null, null, null, null, null], name: '', q: '', view: null, open: null, pick: null };

// The five roles, then the bench. Slot order matters: it's what's saved.
const ROLES = [
  { name: 'Captain', note: 'Double points' },
  { name: 'Power Scorer', note: 'Triple for 180s and 140+' },
  { name: 'Big Finisher', note: 'Triple for 100+ checkouts' },
  { name: 'Dark Horse', note: 'Triple for upset wins' },
  { name: 'Europa Specialist', note: 'Also scores in the Europa' },
  { name: 'Bench', note: 'Covers a starter who doesn\'t play' },
];

// The OoM photo, or their initials if there isn't one.
const initials = n => esc(String(n ?? '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
const photo = (slug, name, cls = 'fx-photo') => slug
  ? `<img class="${cls}" src="/images/players/${esc(slug)}.jpg" alt="" loading="lazy" decoding="async"
      onerror="this.onerror=null;this.outerHTML='&lt;span class=&quot;${cls} fx-initials&quot;&gt;${initials(name)}&lt;/span&gt;'">`
  : `<span class="${cls} fx-initials">${initials(name)}</span>`;

// Prices in millions, the fantasy football way: 14.0 shows as £14.0m.
const money = n => { const v = Number(n ?? 0); return `${v < 0 ? '−' : ''}£${Math.abs(v).toFixed(1)}m`; };
const when = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const gwLabel = d => `w/c ${new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
const byId = id => S.market.find(p => p.id === id);

async function load() {
  // Fills in who was the underdog for any finished match that still needs it
  // (for the Dark Horse role). Quick, and harmless if it fails.
  if (!S.asked) { S.asked = true; sb.functions.invoke('place-bet', { body: { kind: 'prematch' } }).catch(() => null); }
  const [acc, market, board, gws, pts] = await Promise.all([loadAccount(), sb.rpc('fantasy_market'), sb.rpc('fantasy_leaderboard'), sb.rpc('fantasy_gws'), sb.rpc('fantasy_scoring_list')]);
  S.points = pts.data ?? [];
  S.market = market.data ?? [];
  S.curGw = (gws.data ?? []).filter(g => g.locks_at && new Date(g.locks_at) <= new Date()).map(g => g.gw).at(-1) ?? null;
  S.board = board.data ?? [];
  S.account = acc;
  if (acc) {
    const { data } = await sb.rpc('fantasy_my_team');
    S.team = data;
    S.name = data?.name ?? acc.display_name ?? '';
    const sq = data?.squad ?? [];
    S.squad = [1, 2, 3, 4, 5, 6].map(n => sq.find(x => x.slot === n)?.player_id ?? null);
    for (const x of sq) if (!byId(x.player_id)) S.market.push({ id: x.player_id, name: x.name, slug: x.slug, price: x.price, season: 0, last: 0 });
  }
}

const cost = () => S.squad.reduce((t, id) => t + Number(byId(id)?.price ?? 0), 0);
const changes = () => {
  if (!S.team || S.team.first_squad) return 0;
  const prev = new Set(S.team.previous ?? []);
  return S.squad.filter(id => id && !prev.has(id)).length;
};

function squadHtml() {
  const t = S.team;
  if (!S.account) return `<section class="panel"><div class="fx-head"><h2>Your team</h2>${scoringButton}</div><p><a href="/account/?next=/fantasy/">Log in</a> to pick a team.</p></section>`;
  if (!t?.next_gw) return `<section class="panel"><div class="fx-head"><h2>Your team</h2>${scoringButton}</div><p class="muted">No PC or major coming up.</p></section>`;
  const left = Number(t.budget) - cost();
  const ch = changes();
  const hit = Math.max(0, ch - 1) * t.hit;
  const slot = (id, i) => {
    const p = byId(id);
    const role = ROLES[i];
    const sel = S.pick === i ? ' picking' : '';
    const head = `<span class="fx-role"><b>${role.name}</b><span class="muted small">${role.note}</span></span>`;
    if (!id) {
      return `<li class="fx-slot empty${sel}${i === 5 ? ' bench' : ''}" data-slot="${i}">${photo(null, '+', 'fx-photo')}${head}
        <span class="muted small">${S.pick !== null && S.squad[S.pick] && S.pick !== i ? 'Move here' : 'Tap to pick'}</span></li>`;
    }
    return `<li class="fx-slot${sel}${i === 5 ? ' bench' : ''}" data-slot="${i}">
      ${photo(p?.slug, p?.name)}
      ${head}
      <span class="fx-who"><b>${esc(p?.name ?? '?')}</b> <span class="muted">${money(p?.price)}</span></span>
      <span class="fx-slot-btns">
        <button class="link" data-move="${i}">${S.pick === i ? 'Cancel' : 'Move'}</button>
        <button class="link" data-drop="${i}" title="Remove">✕</button>
      </span></li>`;
  };
  return `<section class="panel">
    <div class="fx-head"><h2>Your team</h2>${scoringButton}</div>
    <label>Team name <input id="fx-name" maxlength="30" value="${esc(S.name)}"></label>
    <p class="small muted">Locks ${when(t.locks_at)}</p>
    ${S.pick !== null && S.squad[S.pick] ? `<p class="small fx-hint">Tap a role to move ${esc(byId(S.squad[S.pick])?.name ?? 'them')}.</p>` : ''}
    <ol class="fx-squad">${S.squad.map(slot).join('')}</ol>
    <p class="small"><b class="${left < 0 ? 'error' : ''}">${money(left)}</b> left of ${money(t.budget)}
      ${t.first_squad ? '' : ` · ${ch} change${ch === 1 ? '' : 's'}${hit ? `, <span class="error">−${hit} points</span>` : ' (1 free)'}`}</p>
    <button class="primary" data-act="save">Save team</button>
  </section>`;
}

function marketHtml() {
  const q = S.q.toLowerCase();
  const list = q ? S.market.filter(p => p.name.toLowerCase().includes(q)) : S.market;
  const inSquad = new Set(S.squad.filter(Boolean));
  const full = S.squad.every(Boolean);
  return `<section class="panel">
    <h2>Players</h2>
    <input id="fx-q" placeholder="Search players" value="${esc(S.q)}" autocomplete="off">
    ${S.market.length ? `<table class="lb-table fx-market"><thead><tr><th class="l">Player</th><th>Price</th><th>Pts</th><th title="Share of teams that have them">Pick</th><th></th></tr></thead>
    <tbody>${list.map(p => `<tr>
      <td class="l"><span class="fx-name">${photo(p.slug, p.name, 'fx-thumb')}${esc(p.name)}</span></td><td>${money(p.price)}</td><td title="Season points (last week ${p.last})">${p.season}</td><td>${p.picked ?? 0}%</td>
      <td>${S.account && S.team?.next_gw ? (inSquad.has(p.id) ? '<span class="muted small">In</span>'
        : `<button class="small-pick odds-pick" data-add="${p.id}"${full ? ' disabled' : ''}>Add</button>`) : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted">Prices aren\'t set yet.</p>'}
  </section>`;
}

function historyHtml() {
  const h = S.team?.history ?? [];
  if (!h.length) return '';
  return `<section class="panel"><h2>Your weeks</h2>${h.map(teamWeekHtml).join('')}</section>`;
}

function teamWeekHtml(w) {
  const det = d => d ? Object.entries(d).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') : '';
  return `<details class="fx-week"><summary><b>${gwLabel(w.gw)}</b> · ${w.total} points${w.hits ? ` (−${w.hits} for changes)` : ''}</summary>
    <ul class="fx-week-list">${w.starters.map(s => `<li>${photo(s.slug, s.name, 'fx-thumb')}
      <span><span class="muted small">${esc(s.role)}</span> ${esc(s.name)}: <b>${s.points}</b>
      <span class="muted small" style="display:block">${s.played ? esc(det(s.detail)) : 'didn\'t play'}${s.europa ? ` · Europa: ${s.europa} (${esc(det(s.europa_detail))})` : ''}</span></span></li>`).join('')}
      ${w.bench_name ? `<li class="muted">${photo(w.bench_slug, w.bench_name, 'fx-thumb')}<span>Bench: ${esc(w.bench_name)},
        ${w.bench_came_on ? `came on as ${esc(w.bench_role)}, <b>${w.bench_points}</b>` : 'not needed'}</span></li>` : ''}</ul>
  </details>`;
}

function boardHtml() {
  return `<section class="panel">
    <h2>Leaderboard</h2>
    ${S.board.length ? `<table class="lb-table"><thead><tr><th></th><th class="l">Team</th><th>Points</th></tr></thead>
      <tbody>${S.board.map((r, i) => `<tr class="${r.me ? 'me' : ''}">
        <td class="muted">${i + 1}</td>
        <td class="l"><button class="link" data-view="${r.user_id}">${esc(r.name)}</button><span class="muted small lb-play">${esc(r.manager)}</span></td>
        <td><b>${r.total}</b></td></tr>
        ${S.open === r.user_id && S.view ? `<tr><td colspan="3">${teamWeekHtml(S.view)}</td></tr>` : ''}`).join('')}</tbody></table>`
      : '<p class="muted">No teams yet.</p>'}
  </section>`;
}

const scoringButton = '<button class="link" data-act="scoring">Explain the scoring</button>';

// What scores what, in a window over the page.
// What scores what, in a window over the page. The values come from the
// database, where a super admin sets them.
const scoringHtml = () => `<dialog id="fx-scoring" class="fx-dialog">
  <div class="fx-dialog-head"><h2>Scoring</h2><button class="link" data-act="close-scoring" aria-label="Close">✕</button></div>
  <p class="small muted">PCs and majors count. Europa matches only count for your Europa Specialist.</p>
  <table class="fx-points"><tbody>${S.points.map(x => `<tr><td>${esc(x.label)}</td><td>${x.points}</td></tr>`).join('')}</tbody></table>
  <p class="small muted">Averages: highest band only, per match.</p>
  <h3>Roles</h3>
  <ul class="small fx-rules">
    <li><b>Captain</b>: all their points double.</li>
    <li><b>Power Scorer</b>: 180s and 140+ score triple.</li>
    <li><b>Big Finisher</b>: 100+ checkouts score triple.</li>
    <li><b>Dark Horse</b>: when they win a match as the underdog in the odds, the win and their legs in it score triple.</li>
    <li><b>Europa Specialist</b>: also scores for their Europa matches.</li>
    <li><b>Bench</b>: plays the role of the first starter who doesn't play that week.</li>
  </ul>
  <h3>Rules</h3>
  <ul class="small fx-rules">
    <li>Teams lock when the week's first PC or major starts.</li>
    <li>One free change a week, then ${S.team?.hit ?? 8} points per change.</li>
    <li>Prices move a little each week with form.</li>
  </ul>
</dialog>`;

function render() {
  app.innerHTML = `${squadHtml()}${historyHtml()}${boardHtml()}${marketHtml()}${scoringHtml()}
    <dialog id="fx-picker" class="fx-dialog">
      <div class="fx-dialog-head"><h2 class="fx-pick-role"></h2><button class="link" data-act="close-scoring" aria-label="Close">✕</button></div>
      <input id="fx-pq" type="search" placeholder="Search players" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="search">
      <div class="fx-pick-list"></div>
    </dialog>`;
}

app.addEventListener('input', e => {
  if (e.target.id === 'fx-name') { S.name = e.target.value; return; }
  if (e.target.id === 'fx-pq') {
    S.pq = e.target.value;
    app.querySelector('#fx-picker .fx-pick-list').innerHTML = pickerRows();
    return;
  }
  if (e.target.id === 'fx-q') {
    S.q = e.target.value;
    render();
    const box = app.querySelector('#fx-q');
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
});

// The player picker: a window with a search box, opened by tapping a role.
function pickerRows() {
  const slot = S.picker;
  const q = (S.pq ?? '').toLowerCase();
  const taken = new Set(S.squad.filter((id, i) => id && i !== slot));
  const room = Number(S.team?.budget ?? 0) - cost() + Number(byId(S.squad[slot])?.price ?? 0);
  const list = S.market.filter(p => !q || p.name.toLowerCase().includes(q));
  if (!list.length) return '<p class="muted small">No one matches.</p>';
  return list.map(p => {
    const over = Number(p.price) > room;
    const off = taken.has(p.id) || over;
    return `<button class="fx-pick-row${off ? ' off' : ''}" data-pickp="${p.id}"${off ? ' disabled' : ''}>
      ${photo(p.slug, p.name, 'fx-thumb')}<span class="fx-pick-name">${esc(p.name)}</span>
      <span class="muted small">${taken.has(p.id) ? 'In team' : over ? 'Over budget' : `${p.picked ?? 0}% · ${p.season} pts`}</span>
      <b>${money(p.price)}</b></button>`;
  }).join('');
}

// On a phone the window fills the screen and sits above the keyboard, so
// the search box and the list stay in view while typing.
const touch = matchMedia('(pointer: coarse)').matches;
function fitPicker() {
  const d = app.querySelector('#fx-picker');
  if (d && window.visualViewport) d.style.setProperty('--vvh', `${Math.round(visualViewport.height)}px`);
}
window.visualViewport?.addEventListener('resize', fitPicker);
window.visualViewport?.addEventListener('scroll', () => { if (app.querySelector('#fx-picker[open]')) window.scrollTo(0, window.scrollY); });

function openPicker(slot) {
  S.picker = slot;
  S.pq = '';
  const d = app.querySelector('#fx-picker');
  d.querySelector('.fx-pick-role').textContent = ROLES[slot].name;
  d.querySelector('#fx-pq').value = '';
  d.querySelector('.fx-pick-list').innerHTML = pickerRows();
  fitPicker();
  d.showModal();
  d.querySelector('.fx-pick-list').scrollTop = 0;
  // Opening the keyboard straight away on a phone hides the list; let them
  // see it first and tap the search box if they want it.
  if (!touch) d.querySelector('#fx-pq').focus();
}

// Enter in the search box: pick the only match, or just put the keyboard away.
app.addEventListener('keydown', e => {
  if (e.target.id !== 'fx-pq' || e.key !== 'Enter') return;
  e.preventDefault();
  const rows = [...app.querySelectorAll('#fx-picker .fx-pick-row:not(.off)')];
  if (rows.length === 1) rows[0].click();
  else e.target.blur();
});

app.addEventListener('click', async e => {
  // Picking a role: tap Move on a player, then tap the role they should go to.
  const li = e.target.closest('[data-slot]');
  const b = e.target.closest('button');
  if (li && !b) {
    const to = Number(li.dataset.slot);
    if (S.pick !== null && S.pick !== to) {
      [S.squad[S.pick], S.squad[to]] = [S.squad[to], S.squad[S.pick]];
      S.pick = null;
      render();
    } else {
      openPicker(to);   // choose (or replace) who plays this role
    }
    return;
  }
  if (!b) return;
  if (b.dataset.act === 'scoring') { app.querySelector('#fx-scoring')?.showModal(); return; }
  if (b.dataset.act === 'close-scoring') { b.closest('dialog')?.close(); return; }
  if (b.dataset.pickp) {
    S.squad[S.picker] = b.dataset.pickp;
    S.pick = null;
    app.querySelector('#fx-picker')?.close();
    render();
    return;
  }
  if (b.dataset.add) {
    const i = S.pick !== null && !S.squad[S.pick] ? S.pick : S.squad.indexOf(null);
    if (i < 0) { toast('Squad full'); return; }
    S.squad[i] = b.dataset.add;
    S.pick = null;
    render();
    return;
  }
  if (b.dataset.drop) {
    S.squad[Number(b.dataset.drop)] = null;
    S.pick = null;
    render();
    return;
  }
  if (b.dataset.move) {
    const i = Number(b.dataset.move);
    S.pick = S.pick === i ? null : i;
    render();
    return;
  }
  if (b.dataset.view) {
    const u = b.dataset.view;
    if (S.open === u) { S.open = null; S.view = null; render(); return; }
    const gw = S.curGw;
    if (!gw) { toast('Teams are shown once the first week starts'); return; }
    const { data, error } = await sb.rpc('fantasy_team_view', { p_user: u, p_gw: gw });
    if (error) { toast(error.message); return; }
    S.open = u; S.view = data;
    render();
    return;
  }
  if (b.dataset.act === 'save') {
    if (S.squad.some(x => !x)) { toast('Fill all five roles and the bench'); return; }
    const ch = changes();
    if (ch > 1 && !confirm(`${ch} changes costs ${(ch - 1) * S.team.hit} points. Save?`)) return;
    b.disabled = true;
    const { data, error } = await sb.rpc('fantasy_save', { p_name: S.name, p_players: S.squad });
    b.disabled = false;
    if (error) { toast(error.message); return; }
    toast('Team saved', false);
    await load();
    render();
  }
});

load().then(render, err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
