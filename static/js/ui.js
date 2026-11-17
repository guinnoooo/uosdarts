import { esc, matchLabel, hasPlayers, winnerSide } from './db.js';

function playerName(m, n) {
  const p = n === 1 ? m.p1 : m.p2;
  if (p) return p.name;
  const typed = n === 1 ? m.p1_name : m.p2_name;
  if (typed) return typed;
  return m.status === 'complete' ? 'Bye' : 'TBC';
}

export function statusBadge(m) {
  if (m.status === 'live') return '<span class="badge live">Live</span>';
  if (m.status === 'complete') return '<span class="badge done">Result</span>';
  if (m.called_at && hasPlayers(m)) return '<span class="badge called">Called</span>';
  if (hasPlayers(m)) return '<span class="badge ready">Ready</span>';
  return '<span class="badge">Waiting</span>';
}

// How many people are watching each match, kept up to date by the page.
let watching = new Map();
export function setWatching(map) { watching = map; }

export function matchCard(m, totalKoRounds) {
  const live = m.status === 'live';
  const row = n => {
    const won = winnerSide(m) === n;
    const throwing = live && m.turn === n;
    return `<div class="mc-row${won ? ' win' : ''}${throwing ? ' throwing' : ''}">
      <span class="mc-name">${esc(playerName(m, n))}</span>
      ${live ? `<span class="mc-rem">${n === 1 ? m.p1_rem : m.p2_rem}</span>` : ''}
      <span class="mc-legs">${m.status === 'pending' ? '' : m.sets_to_win
        ? `${n === 1 ? m.p1_sets : m.p2_sets}<small>${n === 1 ? m.p1_legs : m.p2_legs}</small>`
        : (n === 1 ? m.p1_legs : m.p2_legs)}</span>
    </div>`;
  };
  return `<a class="match-card ${m.status}" href="/match/?id=${m.id}">
    <div class="mc-meta"><span>${esc(matchLabel(m, totalKoRounds))}${m.board ? ` · Board ${esc(m.board)}` : ''}${watching.get(m.id) ? ` · <span class="mc-watch">${watching.get(m.id)} watching</span>` : ''}</span>${statusBadge(m)}</div>
    ${row(1)}${row(2)}
    ${m.status === 'pending' && hasPlayers(m) && !m.scorer_id
      ? `<div class="mc-cta">${m.called_at && m.referee_name ? `${esc(m.referee_name)} to mark` : 'Needs a scorer'}</div>` : ''}
  </a>`;
}
