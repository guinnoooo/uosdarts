import { esc, matchLabel } from './db.js';

function playerName(m, n) {
  const p = n === 1 ? m.p1 : m.p2;
  if (p) return p.name;
  return m.status === 'complete' ? 'Bye' : 'TBC';
}

export function statusBadge(m) {
  if (m.status === 'live') return '<span class="badge live">Live</span>';
  if (m.status === 'complete') return '<span class="badge done">Result</span>';
  if (m.player1_id && m.player2_id) return '<span class="badge ready">Ready</span>';
  return '<span class="badge">Waiting</span>';
}

export function matchCard(m, totalKoRounds) {
  const live = m.status === 'live';
  const row = n => {
    const won = m.winner_id && m.winner_id === (n === 1 ? m.player1_id : m.player2_id);
    const throwing = live && m.turn === n;
    return `<div class="mc-row${won ? ' win' : ''}${throwing ? ' throwing' : ''}">
      <span class="mc-name">${esc(playerName(m, n))}</span>
      ${live ? `<span class="mc-rem">${n === 1 ? m.p1_rem : m.p2_rem}</span>` : ''}
      <span class="mc-legs">${m.status === 'pending' ? '' : (n === 1 ? m.p1_legs : m.p2_legs)}</span>
    </div>`;
  };
  return `<a class="match-card ${m.status}" href="/match/?id=${m.id}">
    <div class="mc-meta"><span>${esc(matchLabel(m, totalKoRounds))}${m.board ? ` · Board ${esc(m.board)}` : ''}</span>${statusBadge(m)}</div>
    ${row(1)}${row(2)}
    ${m.status === 'pending' && m.player1_id && m.player2_id && !m.scorer_id
      ? '<div class="mc-cta">Needs a scorer</div>' : ''}
  </a>`;
}
