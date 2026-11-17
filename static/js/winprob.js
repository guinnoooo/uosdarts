// Match chances, shared by GuinnessBet (before a match) and the live win
// probability (during it), so the two always agree.
//
// Everything runs in the browser from data the page already has: each
// player's career figures (match_preview), the order of merit, and the
// match's own score. It's a few hundred arithmetic steps per update.

const logit = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 0 to 1 for where each player sits in the order of merit: 1 for top,
// down to 0.4 for the lowest with points. No points at all scores 0.3, which
// covers both newcomers and people who haven't picked up points yet.
export function oomScores(rows, name1, name2) {
  const pointed = (rows ?? []).filter(r => Number(r.total_points) > 0);
  const n = pointed.length;
  const score = name => {
    const r = pointed.find(x => x.player_name === name);
    if (!r) return 0.3;
    return 0.4 + 0.6 * (n > 1 ? 1 - (r.rank - 1) / (n - 1) : 1);
  };
  return { p1: score(name1), p2: score(name2) };
}

const careerAvg = x => parseFloat(x?.avg) || 40;   // no record: treated as about average

// Chance player 1 wins a single leg, before it starts. Mostly career average,
// nudged by first 9 and doubles, pulled towards the head-to-head leg record,
// pulled towards 50/50 for players with little history, and nudged by the
// order of merit (most when there's little history).
export function legChance(pv) {
  const strength = x => {
    const avg = careerAvg(x);
    const f9 = parseFloat(x?.first9) || avg;
    const dbl = parseFloat(x?.dbl_pct) || 25;
    return avg + (f9 - avg) * 0.3 + (dbl - 25) * 0.15;
  };
  let p = sigmoid((strength(pv.p1) - strength(pv.p2)) / 14);
  const h2h = pv.h2h ?? [];
  if (h2h.length) {
    const legs1 = h2h.reduce((a, x) => a + x.p1_legs, 0);
    const legs2 = h2h.reduce((a, x) => a + x.p2_legs, 0);
    const share = (legs1 + 1) / (legs1 + legs2 + 2);
    const w = h2h.length / (h2h.length + 4);
    p = p * (1 - w) + share * w;
  }
  // About 300 darts (a decent night or two) counts as a full record.
  const known = Math.min(1, Math.min(pv.p1?.darts ?? 0, pv.p2?.darts ?? 0) / 300);
  p = 0.5 + (p - 0.5) * (0.5 + 0.5 * known);
  if (pv.oom) p = sigmoid(logit(p) + (pv.oom.p1 - pv.oom.p2) * 0.6 * (1 - 0.6 * known));
  return clamp(p, 0.15, 0.85);
}

// Chance of being first to `a` more legs before the other gets `b`, winning
// each leg with chance p.
function race(a, b, p, memo = new Map()) {
  if (!(a > 0)) return 1;   // also catches a missing number
  if (!(b > 0)) return 0;
  const k = a * 100 + b;
  if (!memo.has(k)) memo.set(k, p * race(a - 1, b, p, memo) + (1 - p) * race(a, b - 1, p, memo));
  return memo.get(k);
}

// From the current leg's chance to the whole match, for legs or set play.
function fromLeg(cur, pLeg, m) {
  const L = Math.max(1, Number(m.legs_to_win) || 1);
  const need1 = L - (m.p1_legs ?? 0);
  const need2 = L - (m.p2_legs ?? 0);
  const setNow = cur * race(need1 - 1, need2, pLeg) + (1 - cur) * race(need1, need2 - 1, pLeg);
  if (!m.sets_to_win) return setNow;
  const pSet = race(L, L, pLeg);
  const s1 = m.sets_to_win - (m.p1_sets ?? 0);
  const s2 = m.sets_to_win - (m.p2_sets ?? 0);
  return setNow * race(s1 - 1, s2, pSet) + (1 - setNow) * race(s1, s2 - 1, pSet);
}

// GuinnessBet: chance player 1 wins the match, before it starts.
export function matchChance(pv, m) {
  const pLeg = legChance(pv);
  return clamp(fromLeg(pLeg, pLeg, { ...m, p1_legs: 0, p2_legs: 0, p1_sets: 0, p2_sets: 0 }), 0.04, 0.96);
}

// ---------------------------------------------------------------- during a leg

// Visits a player is likely to need from `rem`: scoring down to a finish at
// about their average, then a couple of visits at the double.
function visitsLeft(rem, avg) {
  const scoring = Math.max(0, rem - 40) / Math.max(avg, 15);
  return scoring + (rem <= 1 ? 0 : 1.8);
}

// Chance player 1 wins the leg in progress, from the scores left and who's throwing.
function liveLeg(rem1, rem2, turn, a1, a2) {
  const m1 = visitsLeft(rem1, a1);
  const m2 = visitsLeft(rem2, a2);
  const spread = Math.sqrt(0.55 * (m1 + m2) + 1.2);
  // Player 1 wins if they need fewer visits, or the same and throw first.
  const edge = (m2 - m1) + (turn === 1 ? 0.5 : -0.5);
  return sigmoid(1.7 * edge / spread);
}

// Live chance player 1 wins the match.
//   pv:   career figures from match_preview (with .oom when loaded)
//   m:    the match row (legs, sets, p1_rem / p2_rem, turn)
//   form: optional { p1: {darts, scored}, p2: {...} } for this match, which
//         shifts each player's average towards how they're throwing tonight
export function liveChance(pv, m, form) {
  if (m.status === 'complete') return (m.winner_id ? m.winner_id === m.player1_id : m.p1_legs > m.p2_legs) ? 1 : 0;
  const pLeg = legChance(pv);
  // Averages for this leg: career, moved towards tonight's form (60 darts of
  // career count about the same as 60 darts tonight).
  const avg = n => {
    const c = careerAvg(n === 1 ? pv.p1 : pv.p2);
    const f = form?.[n === 1 ? 'p1' : 'p2'];
    if (!f?.darts) return c;
    return (c * 60 + (f.scored / f.darts) * 3 * f.darts) / (60 + f.darts);
  };
  const a1 = avg(1), a2 = avg(2);
  const c1 = careerAvg(pv.p1), c2 = careerAvg(pv.p2);
  const start = m.start_score ?? 501;
  // Line the live model up with the pre-match one: with career averages at
  // the start of a leg it gives exactly the pre-match leg chance. Tonight's
  // form and the scores left then move it from there.
  const neutral = (liveLeg(start, start, 1, c1, c2) + liveLeg(start, start, 2, c1, c2)) / 2;
  const shift = logit(pLeg) - logit(clamp(neutral, 0.02, 0.98));
  const raw = liveLeg(m.p1_rem ?? start, m.p2_rem ?? start, m.turn ?? 1, a1, a2);
  const cur = clamp(sigmoid(logit(clamp(raw, 0.01, 0.99)) + shift), 0.01, 0.99);
  return clamp(fromLeg(cur, pLeg, m), 0.01, 0.99);
}
