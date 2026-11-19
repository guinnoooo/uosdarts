import { sb, esc, fmtDate, scoreText, winnerSide, HUBS } from './db.js';

// Everything on the site is stored as a "tournament": real tournaments,
// friendlies (one match), and UDUK / Franny team matches (one game per row).
// These helpers tell them apart and draw a card for each, shared by the
// Match Hub, the UDUK and Franny hubs and the results archive.

export const kindOf = t => (t.kind ? t.kind : t.is_friendly ? 'friendly' : 'tournament');

export const KIND_LABEL = { tournament: 'Tournament', friendly: 'Friendly', uduk: 'UDUK', franny: 'Franny' };

const FORMAT = {
  knockout: 'Knockout',
  groups: 'Round robin',
  groups_knockout: 'Groups + knockout',
};

const liveBadge = t => (t.status === 'live' ? '<span class="badge live">Live</span>' : '');

export function tournamentCard(t) {
  return `<a class="t-card ${t.status}" href="/tournament/?id=${t.id}">
    <div class="t-name">${esc(t.name)}</div>
    <div class="t-meta">${fmtDate(t.starts_at)} · ${FORMAT[t.format] ?? ''} · ${t.start_score}</div>
    ${t.champion ? `<div class="t-champ">🏆 ${esc(t.champion.name)}</div>` : ''}
    ${liveBadge(t)}
  </a>`;
}

// A friendly is a one-match tournament, so its card links straight to the match.
export function friendlyCard(t, m) {
  if (!m) return '';
  const score = m.status === 'pending' ? 'Not started' : scoreText(m);
  const winner = t.status === 'complete' ? (winnerSide({ ...m, status: 'complete' }) === 1 ? m.p1_name : m.p2_name) : null;
  const length = m.sets_to_win ? `first to ${m.sets_to_win} sets` : `first to ${t.knockout_legs_to_win}`;
  return `<a class="t-card ${t.status}" href="/match/?id=${m.id}">
    <div class="t-name">${esc(m.p1_name)} v ${esc(m.p2_name)}</div>
    <div class="t-meta">${t.status === 'complete' ? `${fmtDate(t.created_at)} · ` : ''}Friendly · ${score} · ${length} · ${t.start_score}</div>
    ${winner ? `<div class="t-champ">🏆 ${esc(winner)}</div>` : ''}
    ${liveBadge(t)}
  </a>`;
}

// A UDUK or Franny match: the two teams and the games won so far.
export function fixtureCard(t, sc) {
  const home = sc?.home_won ?? 0, away = sc?.away_won ?? 0;
  const played = sc?.finished ?? 0, games = sc?.games ?? 0;
  const what = `${HUBS[t.kind]?.name ?? ''}${t.competition ? ` ${t.competition}` : ''}`;
  const state = t.status === 'complete' ? (home === away ? 'Draw' : `🏆 ${esc(home > away ? t.home_team : t.away_team)}`)
    : t.status === 'live' ? `${played} of ${games} games played` : 'Not started';
  return `<a class="t-card fixture-card ${t.status}" href="/fixture/?id=${t.id}">
    <div class="t-name">${esc(t.home_team)} ${t.status === 'upcoming' ? '<span class="muted">v</span>' : `<b class="fx-score">${home}–${away}</b>`} ${esc(t.away_team)}</div>
    <div class="t-meta">${fmtDate(t.starts_at ?? t.created_at)} · ${what}</div>
    <div class="${t.status === 'complete' ? 't-champ' : 't-meta'}">${state}</div>
    ${liveBadge(t)}
  </a>`;
}

// The extra rows the cards need: the one match of each friendly, and the
// games-won score of each team match.
export async function cardData(list) {
  const friendlies = list.filter(t => kindOf(t) === 'friendly').map(t => t.id);
  const fixtures = list.filter(t => t.kind).map(t => t.id);
  const [fm, fs] = await Promise.all([
    friendlies.length ? sb.from('matches').select('*').in('tournament_id', friendlies) : { data: [] },
    fixtures.length ? sb.from('fixture_scores').select('*').in('tournament_id', fixtures) : { data: [] },
  ]);
  return {
    match: new Map((fm.data ?? []).map(m => [m.tournament_id, m])),
    score: new Map((fs.data ?? []).map(s => [s.tournament_id, s])),
  };
}

export function anyCard(t, extra) {
  const k = kindOf(t);
  if (k === 'friendly') return friendlyCard(t, extra.match.get(t.id));
  if (k === 'uduk' || k === 'franny') return fixtureCard(t, extra.score.get(t.id));
  return tournamentCard(t);
}

// Every PC has a Europa waiting behind it. An unstarted one only shows up on
// the night (its PC is live, or finished within the last day), otherwise the
// upcoming lists would be full of empty Europas.
export function europaVisible(all) {
  const byId = new Map(all.map(t => [t.id, t]));
  return t => {
    if (!t.parent_id || t.status !== 'upcoming') return true;
    const pc = byId.get(t.parent_id);
    if (!pc) return false;
    if (pc.status === 'live') return true;
    return pc.status === 'complete' && Date.now() - new Date(pc.starts_at).getTime() < 36 * 3600 * 1000;
  };
}

export function section(title, cards, empty, id = '') {
  const html = cards.filter(Boolean);
  return `<section${id ? ` id="${id}"` : ''}><h2>${title}</h2>
    ${html.length ? `<div class="t-grid">${html.join('')}</div>` : `<p class="muted">${empty}</p>`}
  </section>`;
}
