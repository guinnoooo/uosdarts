// Odds to win the whole tournament. The rest of the event is played out a
// few thousand times with the same model as the match odds (winprob.js):
// group matches leg by leg, the group tables, the knockout draw made the way
// the admin page makes it, then every knockout match. A player's chance is
// the share of those run-throughs they win.

import { legChance, legFor, chanceFromScore, MODEL } from './winprob.js';
import { standings, buildBracket } from './fixtures.js';

const RUNS = 3000;

// Prices for an outright market. Rounded shorter like the match odds, with
// a bigger margin (as bookmakers do on outrights), so backing everyone
// always loses.
const LADDER = ['1/10', '1/8', '1/6', '1/5', '1/4', '2/7', '1/3', '2/5', '4/9', '1/2', '4/7', '4/6',
  '4/5', '10/11', 'Evens', '6/5', '5/4', '6/4', '7/4', '2/1', '9/4', '5/2', '11/4', '3/1', '7/2', '4/1',
  '9/2', '5/1', '11/2', '6/1', '13/2', '7/1', '8/1', '9/1', '10/1', '12/1', '14/1', '16/1', '20/1',
  '25/1', '33/1', '40/1', '50/1', '66/1', '80/1', '100/1', '150/1', '250/1', '500/1'];
const ladderValue = f => (f === 'Evens' ? 1 : f.split('/').reduce((a, b) => a / b));
const implied = f => 1 / (ladderValue(f) + 1);
const MARGIN = 1.2;

export function outrightPrice(p) {
  const target = Math.min(0.95, Math.max(p * MARGIN, implied('500/1')));
  let best = LADDER[0];
  for (const f of LADDER) if (implied(f) >= target) best = f;
  return best;
}

// figures: [{ id, name, career, form, prov, played, won, rating, rd, sd }] from tournament_odds_data
// oom: player id -> order of merit score (winprob oomScore)
// t: the tournament row; entrants: tournament_players rows; matches: all rows
export function outrightOdds({ figures, oom, t, entrants, matches }) {
  const fig = new Map(figures.map(f => [f.id, f]));
  const pv = (a, b) => ({
    p1: fig.get(a)?.career ?? null, p1_form: fig.get(a)?.form ?? null, p1_prov: fig.get(a)?.prov ?? null,
    p2: fig.get(b)?.career ?? null, p2_form: fig.get(b)?.form ?? null, p2_prov: fig.get(b)?.prov ?? null,
    oom: { p1: oom.get(a) ?? 0.3, p2: oom.get(b) ?? 0.3 },
    p1_won: fig.get(a)?.won, p1_played: fig.get(a)?.played,
    p2_won: fig.get(b)?.won, p2_played: fig.get(b)?.played,
    p1_rating: fig.get(a)?.rating, p1_rd: fig.get(a)?.rd, p1_sd: fig.get(a)?.sd,
    p2_rating: fig.get(b)?.rating, p2_rd: fig.get(b)?.rd, p2_sd: fig.get(b)?.sd,
  });
  const legMemo = new Map();
  const leg = (a, b) => {
    const k = `${a}|${b}`;
    if (!legMemo.has(k)) legMemo.set(k, legChance(pv(a, b)));
    return legMemo.get(k);
  };
  // A match played out from its current legs: returns [winner side, p1 legs, p2 legs].
  // Who threw first isn't known here, so it's a coin flip (as the bull off
  // roughly is), and the throw alternates leg by leg from there.
  const playLegs = (a, b, l1, l2, toWin) => {
    const p = leg(a, b);
    const pl = { 1: legFor(p, 1), 2: legFor(p, 2) };
    let x = l1, y = l2;
    let s = Math.random() < 0.5 ? 1 : 2;
    while (x < toWin && y < toWin) { if (Math.random() < pl[s]) x++; else y++; s = 3 - s; }
    return [x >= toWin ? 1 : 2, x, y];
  };

  const ko = matches.filter(m => m.stage === 'knockout');
  const groups = matches.filter(m => m.stage === 'group');
  const players = new Map(entrants.map(e => [e.player_id, e.players]));
  const wins = new Map();

  // Knockout rounds count back from the final for per-round legs.
  const koLegs = (round, rounds) => t.round_legs?.ko?.[rounds - round] ?? t.knockout_legs_to_win;

  function playKnockout(rows) {
    const winner = new Map();   // match id -> player id
    const feeders = new Map();  // match id -> { 1: feeder id, 2: feeder id }
    for (const m of rows) if (m.next_match_id) {
      const f = feeders.get(m.next_match_id) ?? {};
      f[m.next_slot] = m.id;
      feeders.set(m.next_match_id, f);
    }
    const sorted = [...rows].sort((a, b) => a.round - b.round || a.slot - b.slot);
    let champion = null;
    for (const m of sorted) {
      const side = n => {
        const actual = n === 1 ? m.player1_id : m.player2_id;
        if (actual) return actual;
        const f = feeders.get(m.id)?.[n];
        return f ? winner.get(f) ?? null : null;
      };
      const a = side(1), b = side(2);
      let w;
      if (m.status === 'complete' && m.winner_id) w = m.winner_id;
      else if (!a || !b) w = a ?? b;   // a bye
      else if (m.status === 'live' && m.player1_id === a && m.player2_id === b) {
        w = Math.random() < (m._live ?? 0.5) ? a : b;
      } else {
        const toWin = m.legs_to_win ?? t.knockout_legs_to_win;
        w = playLegs(a, b, 0, 0, toWin)[0] === 1 ? a : b;
      }
      winner.set(m.id, w);
      if (!m.next_match_id) champion = w;
    }
    return champion;
  }

  // A live match's chance comes from the legs (and sets) won so far, not
  // the scores left in the current leg, so it only moves when a leg ends.
  // It doesn't change between run-throughs.
  for (const m of matches) {
    if (m.status === 'live' && m.player1_id && m.player2_id) {
      m._live = chanceFromScore(legChance(pv(m.player1_id, m.player2_id)), { ...m, legs_to_win: m.legs_to_win ?? t.knockout_legs_to_win });
    }
  }

  const labels = [...new Set(entrants.map(e => e.group_label).filter(Boolean))].sort();
  const needGroups = !ko.length && groups.length;
  if (!ko.length && !groups.length) return [];
  if (t.format === 'groups' && labels.length > 1) return [];

  for (let run = 0; run < RUNS; run++) {
    let champ;
    if (needGroups) {
      // Play the rest of the groups, then draw the knockout as the admin page does.
      const played = groups.map(m => {
        if (m.status === 'complete') return m;
        const toWin = m.legs_to_win ?? t.group_legs_to_win;
        const [w, x, y] = playLegs(m.player1_id, m.player2_id, m.p1_legs ?? 0, m.p2_legs ?? 0, toWin);
        return { ...m, status: 'complete', p1_legs: x, p2_legs: y, winner_id: w === 1 ? m.player1_id : m.player2_id };
      });
      const tables = labels.map(g => standings(
        entrants.filter(e => e.group_label === g).map(e => e.players),
        played.filter(m => m.group_label === g)));
      if (t.format === 'groups') { champ = tables[0]?.[0]?.id; }
      else {
        const q = [];
        for (let pos = 0; pos < (t.advance_per_group ?? 2); pos++) for (const tb of tables) if (tb[pos]) q.push(tb[pos].id);
        if (q.length < 2) { champ = q[0]; }
        else {
          let n = 0;
          const { rows, rounds } = buildBracket(q, {}, () => `sim${n++}`);
          for (const r of rows) r.legs_to_win = koLegs(r.round, rounds);
          champ = playKnockout(rows.map(r => ({ ...r, status: 'pending' })));
        }
      }
    } else {
      champ = playKnockout(ko);
    }
    if (champ) wins.set(champ, (wins.get(champ) ?? 0) + 1);
  }

  // Everyone still in: every entrant during the groups, otherwise anyone in
  // the knockout who hasn't lost a finished match. Long shots who never won
  // a run-through still get listed, at the longest price.
  const alive = new Set();
  if (needGroups) entrants.forEach(e => alive.add(e.player_id));
  else {
    for (const m of ko) for (const pid of [m.player1_id, m.player2_id]) if (pid) alive.add(pid);
    for (const m of ko) if (m.status === 'complete' && m.winner_id) {
      for (const pid of [m.player1_id, m.player2_id]) if (pid && pid !== m.winner_id) alive.delete(pid);
    }
  }
  for (const pid of alive) if (!wins.has(pid)) wins.set(pid, 0);

  return [...wins.entries()]
    .map(([id, w]) => {
      const f = fig.get(id);
      const thin = (Number(f?.career?.darts) || 0) < MODEL.thinDarts && f?.prov == null;
      return { id, name: players.get(id)?.name ?? f?.name ?? '?', p: w / RUNS, thin };
    })
    .sort((a, b) => b.p - a.p);
}
