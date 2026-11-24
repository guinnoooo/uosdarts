// Replaces the pre-rendered ranking table with live points from Supabase.
// If the fetch fails the table built at deploy time stays on screen, so the
// page is never blank.

import { sb, esc } from '../db.js';
import { loadHistory, honoursFor, honoursHtml } from '../history.js';

const list = document.getElementById('ranking-list');
const note = document.getElementById('ranking-note');
if (list) run();

function slugify(name) {
  return name.toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasModal(slug) {
  return !!document.getElementById(`player-${slug}`);
}

function row(r) {
  const slug = r.player_slug || slugify(r.player_name);
  const info = hasModal(slug);
  const pts = Number(r.total_points);
  return `<div class="ranking-row${info ? ' has-info' : ''}"${
    info ? ` onclick="document.getElementById('player-${slug}').showModal()"` : ''}>
    <span class="ranking-rank">#${r.rank}</span>
    <span class="ranking-name">${esc(r.player_name)}</span>
    <span class="ranking-points">${Number.isInteger(pts) ? pts : pts.toFixed(0)}</span>
  </div>`;
}

// Players created on the site have no yaml file, so the build couldn't make
// them a profile. Build one here from what's stored with them: name, nickname
// and Student/Alumni. Their stats are filled by liveStats like everyone else's,
// and already include the starting totals entered when they were created.
// If the extra columns can't be read, they still get a profile with their name.
async function addMissingModals(rows) {
  const missing = [...new Set(rows.map(r => r.player_slug || slugify(r.player_name)))]
    .filter(slug => slug && !hasModal(slug));
  if (!missing.length) return;

  const { data } = await sb.from('players').select('slug, name, nickname, year').in('slug', missing);
  const bySlug = new Map((data ?? []).map(p => [p.slug, p]));
  const host = document.querySelector('.ranking-list-wrap')?.parentElement ?? document.body;

  for (const slug of missing) {
    const fromRow = rows.find(r => (r.player_slug || slugify(r.player_name)) === slug);
    const p = bySlug.get(slug) ?? { slug, name: fromRow?.player_name ?? slug };
    host.insertAdjacentHTML('beforeend', modalHtml(p));
  }
}

function modalHtml(p) {
  const slug = esc(p.slug);
  const stat = (key, label) => `<div class="stat"><span class="stat-label">${label}</span>`
    + `<span class="stat-value" data-stat="${key}">&ndash;</span></div>`;
  return `<dialog id="player-${slug}" class="player-modal">
    <div class="player-modal-topbar">
      <span class="player-modal-rank" data-rank-for="${slug}"></span>
      <button class="player-modal-close" onclick="this.closest('dialog').close()">&times;</button>
    </div>
    <div class="player-modal-top">
      <img class="player-modal-photo" loading="lazy" decoding="async"
           src="/images/players/${slug}.jpg" alt="${esc(p.name)}"
           onerror="this.onerror=null;this.outerHTML='&lt;div class=&quot;player-modal-placeholder&quot;&gt;&lt;/div&gt;'">
      <div class="player-modal-heading">
        <p class="player-modal-name" data-name-for="${slug}">${esc(p.name)}</p>
        ${p.nickname ? `<p class="player-modal-nickname">${esc(p.nickname)}</p>` : ''}
        ${p.year ? `<p class="player-modal-year">${esc(p.year)}</p>` : ''}
      </div>
    </div>
    <div class="player-modal-bottom">
      <div class="player-modal-stats">
        <div class="player-modal-stats-row">
          ${stat('pc_best', 'PC Best')}${stat('pc_wins', 'PC Wins')}${stat('major_best', 'Major Best')}${stat('major_wins', 'Major Wins')}
        </div>
        <div class="player-modal-stats-row">
          ${stat('hit_180s', '180s Hit')}${stat('checkouts_100_plus', '100+ C/Os')}${stat('sheet_legs', 'Sheet Legs')}
        </div>
        <div class="player-modal-stats-row">
          ${stat('avg', 'Average')}${stat('first9', 'First 9 Avg')}${stat('dbl_pct', 'Doubles')}
        </div>
      </div>
      <div class="player-modal-honours" data-honours-for="${slug}"></div>
    </div>
  </dialog>`;
}

// Fill in the rank and name on each profile modal, which the build can't know.
function fillModals(rows) {
  for (const r of rows) {
    const slug = r.player_slug || slugify(r.player_name);
    const rank = document.querySelector(`[data-rank-for="${slug}"]`);
    const name = document.querySelector(`[data-name-for="${slug}"]`);
    if (rank) rank.textContent = `#${r.rank}`;
    if (name) name.textContent = r.player_name;
  }
}

// The provisional PC Finals draw: anyone who has won a PC qualifies, the rest
// of the 16 places go on ranking, then it's 1 v 16, 2 v 15 and so on.
//
// Who has won a PC comes from two places. The yaml files (baked into the page
// at build time) hold wins from before live scoring; the database knows about
// every PC finished on the site. A player counts as a winner if either says
// so, so nobody already qualified can drop out if the two disagree, and a PC
// won tonight counts straight away without anyone editing a yaml file.
function rebuildBracket(rows, stats) {
  const box = document.getElementById('pc-bracket');
  const winsTag = document.getElementById('pc-wins');
  if (!box || !winsTag) return;

  let wins = {};
  try {
    wins = JSON.parse(winsTag.textContent);
    // Older builds wrote the list as a quoted string; unwrap it if so.
    if (typeof wins === 'string') wins = JSON.parse(wins);
    if (!wins || typeof wins !== 'object') wins = {};
  } catch { wins = {}; }
  for (const r of stats ?? []) {
    if (!r.player_slug) continue;
    wins[r.player_slug] = Math.max(Number(wins[r.player_slug]) || 0, Number(r.pc_wins) || 0);
  }

  const won = [];
  const rest = [];
  for (const r of rows) {
    const slug = r.player_slug || slugify(r.player_name);
    ((wins[slug] ?? 0) >= 1 ? won : rest).push(r);
  }
  const qualified = won.concat(rest.slice(0, Math.max(0, 16 - won.length)))
    .sort((a, b) => a.rank - b.rank);

  const cell = (p, seed, right) => {
    const name = p ? esc(p.player_name) : '&ndash;';
    return right
      ? `<span class="bracket-name">${name}</span><span class="bracket-seed">${seed}</span>`
      : `<span class="bracket-seed">${seed}</span><span class="bracket-name">${name}</span>`;
  };

  box.innerHTML = Array.from({ length: 8 }, (_, i) => {
    const j = 15 - i;
    return `<div class="bracket-match">
      <div class="bracket-player">${cell(qualified[i], i + 1, false)}</div>
      <span class="bracket-vs">vs</span>
      <div class="bracket-player">${cell(qualified[j], j + 1, true)}</div>
    </div>`;
  }).join('');
}

// Profile stats come from matches actually scored on the site. The values
// Hugo rendered from data/players stay put for anything the database has no
// figure for yet.
async function fetchStats(season) {
  const { data, error } = await sb.rpc('player_stats', { p_season: season });
  return error ? null : data;
}

function liveStats(data) {
  if (!data) return;
  for (const r of data) {
    const box = document.getElementById(`player-${r.player_slug}`);
    if (!box) continue;
    for (const [key, value] of Object.entries(r)) {
      if (key.startsWith('player_')) continue;
      const el = box.querySelector(`[data-stat="${key}"]`);
      if (!el) continue;
      if (value === null || value === undefined) continue;
      // 180s, 100+ checkouts and sheet legs only exist in the database from
      // the day live scoring started. Everything before that is in the
      // player's yaml file, published into data-base, so the two are added.
      // PC and major results are already complete in the database.
      if ('base' in el.dataset && Number.isFinite(value)) {
        el.textContent = (Number(el.dataset.base) || 0) + value;
      } else if (typeof value === 'string' || Number.isFinite(value)) {
        el.textContent = value;
      }
    }
  }
}

// Titles, Dartsity record and committee roles from data/history.
async function fillHonours() {
  if (!list.dataset.history) return;
  try {
    const H = await loadHistory(list.dataset.history);
    for (const box of document.querySelectorAll('[data-honours-for]')) {
      box.innerHTML = honoursHtml(honoursFor(H, box.dataset.honoursFor), esc);
    }
  } catch { /* the profiles still work without it */ }
}

// The history page links to /order-of-merit/#player-<slug>.
function openFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id.startsWith('player-')) return;
  const box = document.getElementById(id);
  if (box && !box.open) box.showModal();
}

async function run() {
  openFromHash();
  await runTable();
  await fillHonours();
  openFromHash();
}

async function runTable() {
  const pcOnly = list.dataset.pcOnly === 'true';
  const season = list.dataset.season || '2026/27';
  try {
    const { data, error } = await sb.rpc('oom_table', { p_season: season, p_pc_only: pcOnly });
    if (error) throw error;
    if (!data?.length) throw new Error('no rows');

    await addMissingModals(data);
    list.innerHTML = data.map(row).join('');
    fillModals(data);
    // One stats fetch serves both the profiles and the PC Finals draw.
    const stats = await fetchStats(season);
    rebuildBracket(data, stats);
    liveStats(stats);
    // Career averages across every tournament scored on the site.
    const avgs = await sb.rpc('player_averages');
    if (!avgs.error) liveStats(avgs.data);
  } catch (e) {
    // Leave the table built at deploy time in place and say so quietly.
    if (note) {
      note.textContent = 'Showing the last published standings: live points are unavailable right now.';
      note.hidden = false;
    }
  }
}
