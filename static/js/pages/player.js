// A player's own page: /player/?p=<slug>. Season stats, their average at
// each event as a chart, every event this season, recent matches and their
// honours. One database call plus the history file.

import { sb, esc, qs } from '../db.js';
import { loadHistory, honoursFor, honoursHtml } from '../history.js';

const app = document.getElementById('app');
const season = app.dataset.season;
const slug = qs('p') ?? '';
let YAML = {};
try { YAML = JSON.parse(document.getElementById('yaml-players')?.textContent || '{}') ?? {}; } catch { YAML = {}; }

const REACHED = { winner: 'Winner', final: 'Final', semi: 'Semis', quarter: 'Quarters', last_16: 'Last 16',
  last_32: 'Last 32', last_64: 'Last 64', group: 'Groups' };
const reached = r => REACHED[r] ?? (r ? String(r).replace(/_/g, ' ') : '');
const day = d => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
const num = v => (v === null || v === undefined || v === '') ? '–' : v;
const KIND = { pc: 'PC', major: 'Major', event: 'Event', external: 'Away' };

function statsHtml(d) {
  const y = YAML[slug] ?? {};
  const s = d.stats ?? {};
  const c = d.career ?? {};
  // Counts from before live scoring sit in the player's yaml file.
  const plus = (k) => (Number(y[k]) || 0) + (Number(s[k]) || 0);
  const tile = (label, value, note = '') => `<div class="pp-tile"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
  return `<div class="pp-tiles">
    ${tile('Average', num(c.avg))}
    ${tile('First 9', num(c.first9))}
    ${tile('Doubles', num(c.dbl_pct))}
    ${tile('180s', plus('hit_180s'))}
    ${tile('100+ checkouts', plus('checkouts_100_plus'))}
    ${tile('High checkout', num(s.high_checkout))}
    ${tile('Sheet legs', plus('sheet_legs'))}
    ${tile('PC wins', num(s.pc_wins ?? y.pc_wins), s.pc_best && s.pc_best !== 'Winner' ? `Best: ${esc(s.pc_best)}` : '')}
    ${tile('Major wins', num(s.major_wins ?? y.major_wins), s.major_best && s.major_best !== 'Winner' ? `Best: ${esc(s.major_best)}` : '')}
  </div>`;
}

// Their average at each event this season, oldest first, with the season
// average as a dashed line. One series, so no legend: the heading names it.
function chartHtml(events, seasonAvg) {
  const pts = events.filter(e => e.avg != null && e.day).map(e => ({ ...e, avg: Number(e.avg) }));
  if (pts.length < 2) return '';
  // Drawn at the width it's shown at, so the labels stay readable on a phone.
  const W = Math.max(300, Math.min(760, (app.clientWidth || 640) - 40)), H = 220, L = 30, R = 8, T = 14, B = 24;
  const vals = pts.map(p => p.avg).concat(seasonAvg ? [Number(seasonAvg)] : []);
  const lo = Math.floor((Math.min(...vals) - 3) / 5) * 5, hi = Math.ceil((Math.max(...vals) + 3) / 5) * 5;
  const x = i => L + (pts.length === 1 ? 0 : i * (W - L - R) / (pts.length - 1));
  const y = v => T + (hi - v) * (H - T - B) / (hi - lo || 1);
  const ticks = [];
  for (let v = lo; v <= hi; v += (hi - lo > 30 ? 10 : 5)) ticks.push(v);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
  const sa = seasonAvg ? Number(seasonAvg) : null;
  return `<figure class="pp-chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average at each event this season">
      ${ticks.map(v => `<g><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="pp-grid"/>
        <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="pp-axis">${v}</text></g>`).join('')}
      ${sa ? `<line x1="${L}" x2="${W - R}" y1="${y(sa)}" y2="${y(sa)}" class="pp-ref"/>
        <text x="${L + 4}" y="${y(sa) - 5}" class="pp-axis">Overall ${sa.toFixed(1)}</text>` : ''}
      <path d="${line}" class="pp-line"/>
      ${pts.map((p, i) => `<g class="pp-pt" tabindex="0" data-i="${i}">
        <circle cx="${x(i)}" cy="${y(p.avg)}" r="12" class="pp-hit"/>
        <circle cx="${x(i)}" cy="${y(p.avg)}" r="4.5" class="pp-dot"/>
        <title>${esc(p.name)}: ${p.avg.toFixed(2)}</title></g>`).join('')}
      <text x="${L}" y="${H - 6}" class="pp-axis">${esc(day(pts[0].day))}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" class="pp-axis">${esc(day(pts.at(-1).day))}</text>
    </svg>
    <figcaption class="pp-tip small muted">Tap a point to see the event.</figcaption>
  </figure>`;
}

function eventsHtml(events) {
  if (!events.length) return '<p class="muted">No events this season yet.</p>';
  return `<div class="pp-scroll"><table class="lb-table pp-events"><thead><tr>
      <th class="l">Event</th><th>Avg</th><th>W–L</th><th class="l">Reached</th></tr></thead>
    <tbody>${[...events].reverse().map(e => `<tr>
      <td class="l">${esc(e.name)}<span class="muted small" style="display:block">${[KIND[e.kind], day(e.day)].filter(Boolean).join(' · ')}</span></td>
      <td>${e.avg != null ? Number(e.avg).toFixed(2) : '–'}</td>
      <td>${e.played != null ? `${e.won}–${e.played - e.won}` : '–'}</td>
      <td class="l">${esc(reached(e.reached))}${e.points ? `<span class="muted small" style="display:block">${Number(e.points)} pts</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function matchesHtml(list) {
  if (!list.length) return '<p class="muted">No matches on the site yet.</p>';
  return `<table class="lb-table pp-matches"><tbody>${list.map(m => `<tr>
      <td><span class="pp-res ${m.won ? 'pp-w' : 'pp-l'}">${m.won ? 'W' : 'L'}</span></td>
      <td class="l">v ${esc(m.opponent ?? '?')}<span class="muted small" style="display:block">${esc(m.event)} · <span style="white-space:nowrap">${day(m.at)}</span></span></td>
      <td class="pp-score"><b>${m.legs_for ?? 0}–${m.legs_against ?? 0}</b></td>
      <td class="muted small">${m.avg != null ? Number(m.avg).toFixed(2) : ''}</td></tr>`).join('')}</tbody></table>`;
}

async function run() {
  if (!slug) { app.innerHTML = '<p class="muted">No player chosen. Pick one from the <a href="/order-of-merit/">order of merit</a>.</p>'; return; }
  const [{ data: d, error }, H] = await Promise.all([
    sb.rpc('player_profile', { p_slug: slug, p_season: season }),
    loadHistory(app.dataset.history).catch(() => null),
  ]);
  if (error) throw error;
  if (!d) { app.innerHTML = `<p class="muted">No player called "${esc(slug)}".</p>`; return; }
  const p = d.player;
  const y = YAML[slug] ?? {};
  document.title = `${p.name} · ${document.title.split(' · ').at(-1)}`;
  const stars = (n, label, cls) => Number(n) > 0 ? `<span class="award ${cls}">${'<span class="award-star">★</span>'.repeat(Number(n))} ${label}</span>` : '';
  const honours = H ? honoursHtml(honoursFor(H, slug), esc).replace('<details class="honours-box">', '<details class="honours-box" open>') : '';
  app.innerHTML = `
    <section class="panel pp-head">
      <img class="pp-photo" src="/images/players/${esc(slug)}.jpg" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pp-photo pp-blank'}))">
      <div>
        <h1>${esc(p.name)}</h1>
        ${p.nickname || y.nickname ? `<p class="pp-nick">${esc(p.nickname || y.nickname)}</p>` : ''}
        <p class="muted small">${[p.year || y.year,
          d.oom ? `#${d.oom.rank} on the OoM (${Number(d.oom.points)} pts)` : null,
          d.pc_oom ? `#${d.pc_oom.rank} on the PC OoM` : null].filter(Boolean).map(esc).join(' · ')}</p>
        <div class="pp-awards">${stars(y.national_champion, 'National Champion', 'award-gold')}${stars(y.stage_winner, 'Stage Winner', 'award-purple')}</div>
        ${d.linked ? `<p class="small muted">Account: ${esc(d.linked.name)} · ${esc(d.linked.email ?? '')}</p>` : ''}
      </div>
    </section>
    <section class="panel"><h2>Stats</h2>${statsHtml(d)}<p class="small muted">Averages are from every match scored on the site. Counts are this season plus earlier ones.</p></section>
    ${chartHtml(d.events, d.career?.avg) ? `<section class="panel"><h2>Average by event</h2>${chartHtml(d.events, d.career?.avg)}</section>` : ''}
    <section class="panel"><h2>Events</h2>${eventsHtml(d.events)}</section>
    <section class="panel"><h2>Recent matches</h2>${matchesHtml(d.matches)}</section>
    ${honours ? `<section class="panel">${honours}</section>` : ''}`;
  const pts = d.events.filter(e => e.avg != null && e.day);
  app.querySelectorAll('.pp-pt').forEach(g => {
    const show = () => {
      app.querySelectorAll('.pp-pt.on').forEach(x => x.classList.remove('on'));
      g.classList.add('on');
      const e = pts[Number(g.dataset.i)];
      app.querySelector('.pp-tip').innerHTML = `<b>${esc(e.name)}</b> · ${day(e.day)} · average <b>${Number(e.avg).toFixed(2)}</b>`;
    };
    g.addEventListener('click', show);
    g.addEventListener('mouseenter', show);
    g.addEventListener('focus', show);
  });
}

run().catch(err => { app.innerHTML = `<p class="error">${esc(err.message ?? String(err))}</p>`; });
