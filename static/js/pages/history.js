// The history page: Dartsity, the trophy cabinet, Dartsity records, the
// internal roll of honour, and committees and awards by year. Everything
// comes from data/history, so a new season is one new file.

import { esc } from '../db.js';
import { loadHistory, people, matchResult, varsityRecords, opponentRecords } from '../history.js';

const app = document.getElementById('app');
const TABS = [['dartsity', 'Dartsity'], ['trophies', 'Trophy cabinet'], ['records', 'Dartsity records'],
  ['internal', 'Roll of honour'], ['years', 'Committees and awards']];
let H = null;
let tab = TABS.some(([k]) => k === location.hash.slice(1)) ? location.hash.slice(1) : 'dartsity';
let year = null;

// A name, linked to their profile on the order of merit when they have one.
const who = name => {
  if (!name) return '<span class="muted">unknown</span>';
  return people(name).map(n => H.hasProfile(n)
    ? `<a href="/order-of-merit/#player-${esc(H.slugOf(n))}">${esc(n)}</a>` : esc(n)).join(' &amp; ');
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function dartsityTab() {
  const list = H.seasons.filter(s => s.varsity).reverse();
  const done = list.filter(s => s.varsity.result !== 'cancelled');
  const wins = done.filter(s => s.varsity.result === 'won').length;
  return `<section class="panel">
    <h2>Dartsity roll of honour</h2>
    <p class="hist-big"><b>${wins}</b> wins from ${done.length}</p>
    <div class="hist-list">${list.map(s => {
      const v = s.varsity;
      const res = { won: 'Won', lost: 'Lost', cancelled: 'Cancelled' }[v.result] ?? '';
      const meta = [v.name !== 'Dartsity' ? v.name : null, v.venue, v.attendance ? `crowd ${v.attendance}` : null, v.title ? `title ${v.title}` : null].filter(Boolean);
      return `<details class="hist-year">
        <summary><span class="hist-season">${esc(s.season)}</span>
          <span class="hist-res hist-${esc(v.result)}">${res}${v.score ? ` ${esc(v.score)}` : ''}</span>
          ${v.captain ? `<span class="muted small">Captain ${esc(v.captain)}</span>` : ''}</summary>
        ${meta.length ? `<p class="small muted">${meta.map(esc).join(' · ')}</p>` : ''}
        ${v.matches ? `<table class="points-list hist-matches"><tbody>${v.matches.map(mt => {
          const r = matchResult(mt);
          return `<tr><td class="l">${who(mt.us)}</td>
            <td class="hist-score ${r === 'W' ? 'hist-w' : r === 'L' ? 'hist-l' : ''}">${esc(mt.score ?? (r === 'W' ? 'Won' : r === 'L' ? 'Lost' : '–'))}</td>
            <td class="r">${mt.them ? esc(mt.them) : '<span class="muted">Hallam</span>'}${mt.note ? ` <span class="muted small">${esc(mt.note)}</span>` : ''}</td></tr>`;
        }).join('')}</tbody></table>` : ''}
        ${v.picks ? `<p class="small"><b>Picks</b> ${[v.captain ? `${who(v.captain)} (c)` : null, ...v.picks.map(who)].filter(Boolean).join(', ')}</p>` : ''}
        ${(v.qualifiers ?? []).map(q => `<p class="small"><b>${esc(q.name)}</b> ${who(q.winner)}${q.runner_up ? `, runner-up ${who(q.runner_up)}` : ''}</p>`).join('')}
        ${v.note ? `<p class="small muted">${esc(v.note)}</p>` : ''}
        ${(v.highlights ?? []).length ? `<ul class="small hist-notes">${v.highlights.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </details>`;
    }).join('')}</div>
  </section>`;
}

function trophiesTab() {
  const all = H.seasons.flatMap(s => (s.trophies ?? []).map(t => ({ ...t, season: s.season })));
  const group = (kind, title) => {
    const list = all.filter(t => t.kind === kind).reverse();
    if (!list.length) return '';
    return `<h3>${title}</h3><ul class="hist-trophies">${list.map(t => `<li>
      <span class="hist-cup" aria-hidden="true">🏆</span>
      <div><b>${esc(t.title)}</b> <span class="muted">${esc(t.season)}</span>
        ${t.winners?.length ? `<div class="small">${t.winners.map(n => who(n) + (t.captain === n ? ' (c)' : '')).join(', ')}</div>` : ''}
        ${t.detail ? `<div class="small muted">${esc(t.detail)}</div>` : ''}</div></li>`).join('')}</ul>`;
  };
  const dartsity = H.seasons.filter(s => s.varsity?.result === 'won').map(s => s.season).reverse();
  return `<section class="panel">
    <h2>Trophy cabinet</h2>
    <h3>Dartsity</h3>
    <p><span class="hist-cup" aria-hidden="true">🏆</span> <b>${dartsity.length} titles</b> <span class="muted small">${dartsity.map(esc).join(', ')}</span></p>
    ${group('team', 'Team')}
    ${group('individual', 'Individual')}
    ${group('society', 'Society')}
    ${notableHtml()}
  </section>`;
}

function notableHtml() {
  const list = H.seasons.flatMap(s => (s.notable ?? []).map(n => ({ n, season: s.season }))).reverse();
  if (!list.length) return '';
  return `<h3>Notable moments</h3><ul class="hist-notes">${list.map(x => `<li>${esc(x.n)} <span class="muted small">${esc(x.season)}</span></li>`).join('')}</ul>`;
}

function recordsTab() {
  const rec = varsityRecords(H);
  const opp = opponentRecords(H).sort((a, b) => b.played - a.played || b.theyWon - a.theyWon);
  const apps = [...rec].sort((a, b) => b.seasons.length - a.seasons.length || b.won - a.won).filter(x => x.seasons.length > 1);
  const best = rec.filter(x => x.played >= 3).sort((a, b) => b.won / b.played - a.won / a.played || b.played - a.played);
  const unbeaten = rec.filter(x => x.played >= 2 && !x.lost).sort((a, b) => b.played - a.played);
  const done = H.seasons.filter(s => s.varsity && s.varsity.result !== 'cancelled' && s.varsity.score);
  const margin = s => { const [a, b] = s.varsity.score.split('-').map(Number); return a - b; };
  const biggest = [...done].sort((a, b) => margin(b) - margin(a))[0];
  const crowd = H.seasons.filter(s => s.varsity?.attendance).sort((a, b) => parseInt(b.varsity.attendance, 10) - parseInt(a.varsity.attendance, 10))[0];
  const caps = H.seasons.filter(s => s.varsity?.captain).reverse();
  const table = (rows, cols) => `<table class="points-list"><tbody>${rows.map(r => `<tr>${cols.map(c => c(r)).join('')}</tr>`).join('')}</tbody></table>`;
  return `<section class="panel">
    <h2>Dartsity records</h2>
    <ul class="hist-facts">
      ${biggest ? `<li>Biggest win <b>${esc(biggest.varsity.score)}</b> <span class="muted">${esc(biggest.season)}</span></li>` : ''}
      ${crowd ? `<li>Biggest crowd <b>${esc(crowd.varsity.attendance)}</b> <span class="muted">${esc(crowd.varsity.venue ?? '')} ${esc(crowd.season)}</span></li>` : ''}
    </ul>
    <h3>Most appearances</h3>
    ${table(apps.slice(0, 10), [r => `<td class="l">${who(r.name)}</td>`, r => `<td>${plural(r.seasons.length, 'year')}</td>`,
      r => `<td class="small muted">${r.won}–${r.lost}</td>`])}
    ${unbeaten.length ? `<h3>Never beaten <span class="muted small">(2+ matches)</span></h3>
    ${table(unbeaten, [r => `<td class="l">${who(r.name)}</td>`, r => `<td>${r.won}–0</td>`])}` : ''}
    <h3>Hallam players we keep meeting</h3>
    ${table(opp, [r => `<td class="l">${esc(r.name)}</td>`, r => `<td>${r.theyWon}–${r.played - r.theyWon}</td>`,
      r => `<td class="small muted">${r.beaten.length ? `beat ${r.beaten.map(esc).join(', ')}` : ''}${r.beaten.length && r.lostTo.length ? '; ' : ''}${r.lostTo.length ? `lost to ${r.lostTo.map(esc).join(', ')}` : ''}</td>`])}
    <p class="small muted">Their record against us, wins first.</p>
    <h3>Captains</h3>
    ${table(caps, [r => `<td class="l">${esc(r.season)}</td>`, r => `<td class="l">${who(r.varsity.captain)}</td>`,
      r => `<td class="small hist-${esc(r.varsity.result)}">${{ won: 'Won', lost: 'Lost', cancelled: 'Cancelled' }[r.varsity.result]}${r.varsity.score ? ` ${esc(r.varsity.score)}` : ''}</td>`])}
  </section>`;
}

function internalTab() {
  const events = new Map();
  for (const s of H.seasons) for (const e of s.internal ?? []) {
    const a = events.get(e.event) ?? [];
    a.push({ ...e, season: s.season });
    events.set(e.event, a);
  }
  const wins = new Map();
  for (const list of events.values()) for (const e of list) for (const n of people(e.winner)) wins.set(n, (wins.get(n) ?? 0) + 1);
  const most = [...wins.entries()].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1]);
  // The current majors first, then the rest by how long they've run.
  const ORDER = ['Ham Cup', 'Premier League', 'Easter Egg Cup', 'Players Championship Finals', 'Pears Pairs Trophy'];
  const names = [...events.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return events.get(b).length - events.get(a).length;
  });
  return `<section class="panel">
    <h2>Roll of honour</h2>
    <h3>Most titles</h3>
    <table class="points-list"><tbody>${most.map(([n, c]) => `<tr><td class="l">${who(n)}</td><td>${c}</td></tr>`).join('')}</tbody></table>
    ${names.map(name => {
      const list = [...events.get(name)].reverse();
      return `<details class="hist-year"${ORDER.slice(0, 1).includes(name) ? ' open' : ''}>
        <summary><b>${esc(name)}</b> <span class="muted small">${plural(list.length, 'edition')}</span></summary>
        <table class="points-list"><tbody>${list.map(e => `<tr>
          <td class="l small">${esc(e.season)}</td>
          <td class="l"><b>${who(e.winner)}</b>${e.runner_up ? `<span class="muted small" style="display:block">beat ${who(e.runner_up)}</span>` : ''}</td>
          <td class="small muted">${e.high_checkout ? `High c/o ${esc(e.high_checkout)}` : ''}${e.note ? ` ${esc(e.note)}` : ''}</td>
        </tr>`).join('')}</tbody></table>
      </details>`;
    }).join('')}
  </section>`;
}

function yearsTab() {
  const list = H.seasons.filter(s => s.committee || s.awards || s.notable).reverse();
  if (!year || !list.some(s => s.season === year)) year = list[0]?.season;
  const s = list.find(x => x.season === year);
  return `<section class="panel">
    <h2>Committees and awards</h2>
    <label>Season <select id="hist-year">${list.map(x => `<option${x.season === year ? ' selected' : ''}>${esc(x.season)}</option>`).join('')}</select></label>
    ${s?.committee ? `<h3>Committee</h3><table class="points-list"><tbody>${s.committee.map(c =>
      `<tr><td class="l small muted">${esc(c.role)}</td><td class="l">${who(c.name)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${s?.awards ? `<h3>End of year awards</h3><table class="points-list"><tbody>${s.awards.map(a =>
      `<tr><td class="l small muted">${esc(a.award)}</td><td class="l">${esc(a.name)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${s?.notable ? `<h3>Notable</h3><ul class="hist-notes">${s.notable.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function render() {
  const body = { dartsity: dartsityTab, trophies: trophiesTab, records: recordsTab, internal: internalTab, years: yearsTab }[tab]();
  app.innerHTML = `<nav class="hist-tabs">${TABS.map(([k, label]) =>
    `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${label}</button>`).join('')}</nav>${body}`;
}

app.addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  history.replaceState(null, '', `#${tab}`);
  render();
});
app.addEventListener('change', e => {
  if (e.target.id === 'hist-year') { year = e.target.value; render(); }
});

loadHistory(app.dataset.history).then(h => { H = h; render(); },
  err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
