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

export function matchLabel(m, totalKoRounds) {
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
