import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { roundName } from './fixtures.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, LOGIN_DOMAIN } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const MATCH_SELECT =
  '*, p1:players!matches_player1_id_fkey(id,name), p2:players!matches_player2_id_fkey(id,name)';

// Scorers get a silent anonymous account so the database knows who owns a match.
// The session is kept in localStorage, so refreshing the page keeps scorer rights.
export async function ensureSignedIn() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) return session.user;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}

export async function currentUserId() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user?.id ?? null;
}

// Waits a random 0 to 2 seconds before reloading, so when one change reaches
// every open copy of a page they don't all hit the database at once.
export const jittered = fn => () => setTimeout(fn, Math.random() * 2000);

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function fmtDate(d) {
  if (!d) return 'Date TBC';
  return new Date(d).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export { roundName } from './fixtures.js';

// Friendlies have typed names (p1_name / p2_name) instead of player profiles.
export const hasPlayers = m => !!((m.player1_id || m.p1_name) && (m.player2_id || m.p2_name));

// 1 or 2 for the winner, or null. Friendlies have no winner_id, so the legs decide.
export function winnerSide(m) {
  if (m.winner_id) return m.winner_id === m.player1_id ? 1 : 2;
  // Friendlies and team games can have a typed name on one or both sides,
  // and then there's no winner_id, so the score decides.
  if (m.status === 'complete' && (m.p1_name || m.p2_name)) {
    return (m.sets_to_win ? m.p1_sets > m.p2_sets : m.p1_legs > m.p2_legs) ? 1 : 2;
  }
  return null;
}

export const HUBS = {
  uduk: { name: 'UDUK', blurb: 'Wednesday uni matches', teams: ['Sheffield A', 'Sheffield B', 'Sheffield C'] },
  franny: { name: 'Franny', blurb: 'Thursday Franchise League', teams: ["Accy D's", 'Boobs', 'Slingers'] },
};

// Where team matches are usually played. Anywhere else can be typed in.
export const VENUES = ['Crookes', 'Beehive', 'Springy'];

// "Best of 3 · 701" for a game in a team match.
export const gameFormat = m => `Bo${m.legs_to_win * 2 - 1} · ${m.start_score}`;

// "First to 3 legs" or "First to 3 sets (2 legs a set)".
export function formatText(m) {
  return m.sets_to_win
    ? `First to ${m.sets_to_win} set${m.sets_to_win > 1 ? 's' : ''} (${m.legs_to_win} leg${m.legs_to_win > 1 ? 's' : ''} a set)`
    : `First to ${m.legs_to_win} leg${m.legs_to_win > 1 ? 's' : ''}`;
}

// The score as people say it: legs, or sets for set play.
export const scoreText = m => (m.sets_to_win ? `${m.p1_sets}–${m.p2_sets} in sets` : `${m.p1_legs}–${m.p2_legs}`);

export function matchLabel(m, totalKoRounds) {
  if (m.game_label) return m.game_label;   // a game in a UDUK or Franny match
  if (m.p1_name && m.p2_name) return 'Friendly';
  if (m.stage === 'group') return `Group ${m.group_label} · Round ${m.round}`;
  return roundName(m.round, totalKoRounds);
}

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(msg, isError = true) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isError ? 'show error' : 'show';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 3500);
}

// Anything that stops the first load — no keys in config.js, Supabase
// unreachable, a blocked network — should say so rather than sit on "Loading…".
// A page opened without a valid ?id= should say so, not sit on "Loading…"
// or show a raw Postgres error about uuid syntax.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validId(v) { return typeof v === 'string' && UUID.test(v); }

export function showMissing(el, what) {
  el.innerHTML = `<div class="panel center"><p>That ${esc(what)} link doesn't look right.</p>
    <p class="muted small">It may have been deleted, or the address was mistyped.</p>
    <p><a href="/">Back to the Match Hub</a></p></div>`;
}

export function showLoadError(el, e) {
  const placeholder = SUPABASE_URL.includes('YOUR-PROJECT-REF') || SUPABASE_ANON_KEY.includes('YOUR-');
  const msg = placeholder
    ? 'This site has not been connected to its database yet: fill in js/config.js with the Supabase project URL and publishable key.'
    : `Could not reach the scoring database. ${esc(e?.message ?? e ?? 'Unknown error')}`;
  el.innerHTML = `<div class="panel center"><p class="error">${esc(msg)}</p>
    <p class="muted small">Check your connection and reload. If it keeps happening, tell the committee.</p></div>`;
  console.error('uosdarts: load failed', e);
}

// Admin accounts are identified by username. Supabase needs an email, so one
// is built from the username. Anything already containing @ is left alone, so
// accounts made before this change still sign in.
export function toLoginEmail(username) {
  const u = String(username ?? '').trim();
  return u.includes('@') ? u.toLowerCase() : `${u.toLowerCase()}@${LOGIN_DOMAIN}`;
}

export function toUsername(email) {
  const e = String(email ?? '');
  return e.toLowerCase().endsWith(`@${LOGIN_DOMAIN}`) ? e.slice(0, e.lastIndexOf('@')) : e;
}
