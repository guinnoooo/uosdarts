// The society's history, built from data/history (one file per season).
// Shared by the history page and the honours on the player profiles.

let cache = null;

export async function loadHistory(url) {
  if (!cache) cache = fetch(url).then(r => r.json()).then(prepare);
  return cache;
}

export function slugify(name) {
  return String(name).toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// "Joe Hopkins & Jack Newton" or "A, B and C" -> each name.
export const people = s => (Array.isArray(s) ? s : [s]).filter(Boolean)
  .flatMap(x => String(x).split(/\s*&\s*|\s*,\s*|\s+and\s+/)).map(x => x.trim()).filter(Boolean);

function prepare(raw) {
  const aliases = raw.aliases ?? {};
  const profiles = new Set(raw.profiles ?? []);
  const slugOf = name => aliases[name] ?? slugify(name);
  // Oldest first.
  const seasons = Object.entries(raw.seasons ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s);
  return { seasons, slugOf, hasProfile: name => profiles.has(slugOf(name)) };
}

// Score "3-1" read from our side.
export function matchResult(mt) {
  if (typeof mt.won === 'boolean') return mt.won ? 'W' : 'L';
  const [a, b] = String(mt.score ?? '').split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a > b ? 'W' : 'L';
}

// Every Dartsity match each Uni of player has played.
export function varsityRecords(H) {
  const by = new Map();
  for (const s of H.seasons) {
    const v = s.varsity;
    if (!v?.matches) continue;
    for (const mt of v.matches) {
      const r = matchResult(mt);
      for (const name of people(mt.us)) {
        const x = by.get(name) ?? { name, played: 0, won: 0, lost: 0, seasons: [], titles: 0 };
        if (r) { x.played++; if (r === 'W') x.won++; else x.lost++; }
        x.seasons.push(s.season);
        if (v.result === 'won') x.titles++;
        by.set(name, x);
      }
    }
  }
  return [...by.values()];
}

// Hallam players we've met more than once.
export function opponentRecords(H) {
  const by = new Map();
  for (const s of H.seasons) {
    for (const mt of s.varsity?.matches ?? []) {
      if (!mt.them || /&/.test(mt.them)) continue;
      const r = matchResult(mt);
      if (!r) continue;
      const x = by.get(mt.them) ?? { name: mt.them, played: 0, theyWon: 0, beaten: [], lostTo: [] };
      x.played++;
      if (r === 'L') { x.theyWon++; x.beaten.push(people(mt.us).join(' & ')); } else x.lostTo.push(people(mt.us).join(' & '));
      by.set(mt.them, x);
    }
  }
  return [...by.values()].filter(x => x.played > 1);
}

// Everything one player has won or been part of, for their profile.
export function honoursFor(H, slug) {
  const mine = name => H.slugOf(name) === slug;
  const titles = new Map();          // event -> [season]
  const add = (k, season) => { const a = titles.get(k) ?? []; a.push(season); titles.set(k, a); };
  const roles = [];
  const awards = [];
  let ds = { played: 0, won: 0, titles: 0, captain: [] };

  for (const s of H.seasons) {
    for (const e of s.internal ?? []) {
      if (people(e.winner).some(mine)) add(e.event, s.season);
    }
    for (const t of s.trophies ?? []) {
      if ((t.winners ?? []).some(mine)) add(t.title, s.season);
    }
    for (const c of s.committee ?? []) {
      if (mine(c.name) && /president|captain/i.test(c.role) && !/vice|dartselona|football|b team|c team/i.test(c.role)) {
        roles.push(`${c.role} ${s.season}`);
      }
    }
    for (const a of s.awards ?? []) {
      if (/player of the year|fresher/i.test(a.award) && people(a.name).some(mine)) awards.push(`${a.award} ${s.season}`);
    }
    const v = s.varsity;
    if (v) {
      if (v.captain && mine(v.captain)) ds.captain.push(s.season);
      for (const mt of v.matches ?? []) {
        if (!people(mt.us).some(mine)) continue;
        const r = matchResult(mt);
        if (r) { ds.played++; if (r === 'W') ds.won++; }
        if (v.result === 'won') ds.titles++;
      }
    }
  }
  return { titles: [...titles.entries()], roles, awards, dartsity: ds };
}

export function honoursHtml(h, esc) {
  const parts = [];
  if (h.dartsity.played) {
    parts.push(`<li><b>Dartsity</b> ${h.dartsity.won}–${h.dartsity.played - h.dartsity.won} in matches`
      + `${h.dartsity.titles ? `, ${h.dartsity.titles} title${h.dartsity.titles === 1 ? '' : 's'}` : ''}`
      + `${h.dartsity.captain.length ? `, captain ${h.dartsity.captain.join(', ')}` : ''}</li>`);
  }
  for (const [event, seasons] of h.titles) {
    parts.push(`<li><b>${esc(event)}</b>${seasons.length > 1 ? ` ×${seasons.length}` : ''} <span class="muted">${seasons.map(esc).join(', ')}</span></li>`);
  }
  for (const x of [...h.roles, ...h.awards]) parts.push(`<li>${esc(x)}</li>`);
  if (!parts.length) return '';
  return `<p class="honours-head">Honours</p><ul class="honours">${parts.join('')}</ul>`;
}
