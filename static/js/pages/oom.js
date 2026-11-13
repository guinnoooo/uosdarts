// Replaces the pre-rendered ranking table with live points from Supabase.
// If the fetch fails the table built at deploy time stays on screen, so the
// page is never blank.

import { sb, esc } from '../db.js';

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
function rebuildBracket(rows) {
  const box = document.getElementById('pc-bracket');
  const winsTag = document.getElementById('pc-wins');
  if (!box || !winsTag) return;

  let wins = {};
  try { wins = JSON.parse(winsTag.textContent); } catch { return; }

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
async function liveStats() {
  const season = list.dataset.season || '2026/27';
  const { data, error } = await sb.rpc('player_stats', { p_season: season });
  if (error || !data) return;
  for (const r of data) {
    const box = document.getElementById(`player-${r.player_slug}`);
    if (!box) continue;
    for (const [key, value] of Object.entries(r)) {
      if (key.startsWith('player_')) continue;
      const el = box.querySelector(`[data-stat="${key}"]`);
      if (!el) continue;
      if (value === null || value === undefined) continue;
      // A zero from the database is real for counts, but for "best run" it
      // means nothing has been played yet, so leave the published value.
      if (typeof value === 'string' || Number.isFinite(value)) el.textContent = value;
    }
  }
}

async function run() {
  const pcOnly = list.dataset.pcOnly === 'true';
  const season = list.dataset.season || '2026/27';
  try {
    const { data, error } = await sb.rpc('oom_table', { p_season: season, p_pc_only: pcOnly });
    if (error) throw error;
    if (!data?.length) throw new Error('no rows');

    list.innerHTML = data.map(row).join('');
    fillModals(data);
    rebuildBracket(data);
    await liveStats();
  } catch (e) {
    // Leave the table built at deploy time in place and say so quietly.
    if (note) {
      note.textContent = 'Showing the last published standings: live points are unavailable right now.';
      note.hidden = false;
    }
  }
}
