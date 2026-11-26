// Intro card: when a match goes live, spectators get a short card with both
// players side by side (OoM standing, the chance to win, average, first 9,
// doubles, their last five results and the head to head), then it slides
// away after a few seconds or on a tap. Each person sees it once per match,
// and only near the start (before a leg has been won), never while scoring.

import { sb, esc } from './db.js';
import { matchChance, oomScores } from './winprob.js';
import { slugify } from './history.js';

const SECONDS = 7;
const seenKey = id => `uosdarts:intro:${id}`;
const seen = id => { try { return !!localStorage.getItem(seenKey(id)); } catch { return false; } };
const markSeen = id => { try { localStorage.setItem(seenKey(id), '1'); } catch { /* private mode */ } };

let showing = false;

export async function maybeShowIntro({ match: m, round, scoring, nameOf }) {
  if (showing || scoring || m.status !== 'live' || !m.player1_id || !m.player2_id) return;
  if ((m.p1_legs ?? 0) + (m.p2_legs ?? 0) + (m.p1_sets ?? 0) + (m.p2_sets ?? 0) > 0) return;
  if (seen(m.id)) return;
  showing = true;
  markSeen(m.id);
  try {
    const recent = pid => sb.from('matches').select('player1_id, player2_id, winner_id, finished_at')
      .eq('status', 'complete').or(`player1_id.eq.${pid},player2_id.eq.${pid}`)
      .not('winner_id', 'is', null).order('finished_at', { ascending: false }).limit(5);
    const [pv, oom, f1, f2] = await Promise.all([
      sb.rpc('match_preview', { p_match: m.id }), sb.rpc('oom_table'), recent(m.player1_id), recent(m.player2_id),
    ]);
    if (pv.error || !pv.data) return;
    const p = pv.data;
    const rows = oom.data ?? [];
    p.oom = oomScores(rows, nameOf(1), nameOf(2));
    const chance = matchChance(p, m);
    const standing = name => rows.find(r => r.player_name === name && Number(r.total_points) > 0);
    const form = (res, pid) => (res.data ?? []).map(x => x.winner_id === pid);
    const h2h = p.h2h ?? [];
    const won1 = h2h.filter(x => x.p1_won).length, won2 = h2h.length - won1;
    show({
      kicker: [m.tournament?.name, round, m.board ? `Board ${m.board}` : null].filter(Boolean).join(' · '),
      legs: m.sets_to_win ? `Best of ${m.sets_to_win * 2 - 1} sets` : `Best of ${m.legs_to_win * 2 - 1}`,
      chance,
      sides: [1, 2].map(n => ({
        name: nameOf(n), slug: slugify(nameOf(n)), oom: standing(nameOf(n)),
        career: n === 1 ? p.p1 : p.p2, form: form(n === 1 ? f1 : f2, n === 1 ? m.player1_id : m.player2_id),
        h2h: n === 1 ? won1 : won2,
      })),
    });
  } catch {
    showing = false;
  }
}

function show(d) {
  const [a, b] = d.sides;
  const num = (v, dp = 1) => (v == null || v === '' || Number.isNaN(parseFloat(v)) ? null : parseFloat(v));
  const fmt = (v, dp = 1, suf = '') => (v == null ? '–' : `${v.toFixed(dp)}${suf}`);
  // The better figure of each pair is bright, the other dimmed.
  const pair = (label, x, y, dp = 1, suf = '') => {
    const hi = x == null || y == null || x === y ? 0 : x > y ? 1 : 2;
    return `<tr><td class="${hi === 2 ? 'ic-lo' : 'ic-hi'}">${fmt(x, dp, suf)}</td><th>${label}</th><td class="${hi === 1 ? 'ic-lo' : 'ic-hi'}">${fmt(y, dp, suf)}</td></tr>`;
  };
  const form = f => f.length ? `<span class="ic-form">${f.map(w => `<i class="${w ? 'w' : 'l'}">${w ? 'W' : 'L'}</i>`).join('')}</span>` : '–';
  const photo = s => `<img src="/images/players/${esc(s.slug)}.jpg" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ic-ph'}))">`;
  const sub = s => s.oom ? `OoM #${s.oom.rank} · ${Number(s.oom.total_points).toLocaleString('en-GB')} pts` : 'No OoM points yet';
  const pct = Math.round(d.chance * 100);
  const el = document.createElement('div');
  el.className = 'intro-card';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `${a.name} v ${b.name}`);
  el.innerHTML = `<div class="ic">
    <div class="ic-kick"><span>${esc(d.kicker)}</span><span class="ic-on">● Game on</span></div>
    <div class="ic-vs">
      <div class="ic-p">${photo(a)}<b>${esc(a.name)}</b><small>${esc(sub(a))}</small></div>
      <div class="ic-v">v</div>
      <div class="ic-p">${photo(b)}<b>${esc(b.name)}</b><small>${esc(sub(b))}</small></div>
    </div>
    <div class="ic-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <div class="ic-pc"><span><b>${pct}%</b> to win</span><span>${esc(d.legs)}</span><span>${100 - pct}%</span></div>
    <table class="ic-t">
      ${pair('Average', num(a.career?.avg), num(b.career?.avg))}
      ${pair('First 9', num(a.career?.first9), num(b.career?.first9))}
      ${pair('Doubles', num(a.career?.dbl_pct), num(b.career?.dbl_pct), 1, '%')}
      <tr><td>${form(a.form)}</td><th>Last 5</th><td>${form(b.form)}</td></tr>
      ${a.h2h + b.h2h ? pair('Head to head', a.h2h, b.h2h, 0) : '<tr><td></td><th>First meeting</th><td></td></tr>'}
    </table>
    <div class="ic-prog"><i></i></div>
    <div class="ic-foot"><span class="muted small">Odds from the GuinnessBet model</span><button class="primary" data-ic="close">Watch</button></div>
  </div>`;
  document.body.appendChild(el);
  const prog = el.querySelector('.ic-prog i');
  prog.style.animationDuration = `${SECONDS}s`;
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('ic-out');
    setTimeout(() => { el.remove(); showing = false; }, 250);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-ic="close"]')) close(); });
  setTimeout(close, SECONDS * 1000);
}
