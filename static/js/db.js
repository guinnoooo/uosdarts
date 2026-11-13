import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { roundName } from './fixtures.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

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
