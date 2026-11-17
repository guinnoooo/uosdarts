// Match chances, shared by GuinnessBet (before a match) and the live win
// probability (during it), so the two always agree.
//
// Everything runs in the browser from data the page already has: each
// player's career figures and recent form (match_preview), the order of
// merit, and the match's own score. It's a few hundred arithmetic steps.

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

// Every number the model uses, in one place, so it can be retuned once there
// are enough results to measure it against (see tools/model-eval.mjs).
export const MODEL = {
  version: 2,
  baseline: 40,       // average assumed for someone with no record
  scale: 14,          // average points that make about one step in leg odds
  f9Weight: 0.3,      // how much first 9 counts on top of the average
  dblWeight: 0.15,    // average points per percentage point of doubles above 25%
  formWeight: 0.6,    // how far recent form can move a player from their career level
  formFull: 150,      // weighted recent darts for recent form to count fully
  h2hPrior: 4,        // meetings before head-to-head counts for half
  h2hHalfLife: 42,    // days: a meeting's weight halves every six weeks
  knownDarts: 300,    // career darts for a full record (less is pulled to 50/50)
  oomWeight: 0.6,     // order of merit gap to leg odds, with little history
  oomWithHistory: 0.4, // ...and the share of that left once both have a full record
  legCap: 0.85,       // no one rated more than this to win a leg before it starts
};

const num = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };

// One player's level: overall ability (career figures) moved towards recent
// form, by more the more they've played lately. Recent form comes from
// player_form, where a dart's weight halves every six weeks.
export function ability(career, form) {
  const cAvg = num(career?.avg, MODEL.baseline);
  const cF9 = num(career?.first9, cAvg);
  const cDbl = num(career?.dbl_pct, 25);
  const fd = num(form?.wdarts, 0);
  const pull = fd > 0 ? MODEL.formWeight * (fd / (fd + MODEL.formFull)) : 0;
  const blend = (c, f) => c + pull * (num(f, c) - c);
  const avg = blend(cAvg, form?.avg);
  const f9 = blend(cF9, form?.first9);
  const dbl = blend(cDbl, form?.dbl_pct);
  return { avg, f9, dbl, strength: avg + (f9 - avg) * MODEL.f9Weight + (dbl - 25) * MODEL.dblWeight };
}

// Chance player 1 wins a single leg, before it starts. Three things go in:
// overall ability and recent form (above), the head-to-head (recent meetings
// counting more), and the order of merit, which matters most when there's
// little history. Players with little history are pulled towards 50/50.
export function legChance(pv) {
  const a1 = ability(pv.p1, pv.p1_form), a2 = ability(pv.p2, pv.p2_form);
  let p = sigmoid((a1.strength - a2.strength) / MODEL.scale);
  const h2h = pv.h2h ?? [];
  if (h2h.length) {
    const now = Date.now();
    let legs1 = 0, legs2 = 0, meetings = 0;
    for (const x of h2h) {
      const days = (now - new Date(x.date).getTime()) / 86400000;
      const w = Number.isFinite(days) ? 0.5 ** (Math.max(0, days) / MODEL.h2hHalfLife) : 1;
      legs1 += w * x.p1_legs; legs2 += w * x.p2_legs; meetings += w;
    }
    const share = (legs1 + 1) / (legs1 + legs2 + 2);
    const w = meetings / (meetings + MODEL.h2hPrior);
    p = p * (1 - w) + share * w;
  }
  const known = Math.min(1, Math.min(num(pv.p1?.darts, 0), num(pv.p2?.darts, 0)) / MODEL.knownDarts);
  p = 0.5 + (p - 0.5) * (0.5 + 0.5 * known);
  if (pv.oom) {
    p = sigmoid(logit(p) + (pv.oom.p1 - pv.oom.p2) * MODEL.oomWeight * (1 - (1 - MODEL.oomWithHistory) * known));
  }
  return clamp(p, 1 - MODEL.legCap, MODEL.legCap);
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

// A chance as shown on screen, to one decimal place. Until the match is over
// it never reads 100.0% or 0.0%: anything that would round to those shows
// as 99.9% or 0.1%.
export function pct(p, final = false) {
  const v = Math.round(p * 1000) / 10;
  return (final ? v : clamp(v, 0.1, 99.9)).toFixed(1);
}

// Both sides, worked from the same rounded number so they always add up to 100.0.
export function pctPair(p, final = false) {
  const a = pct(p, final);
  return [a, (100 - Number(a)).toFixed(1)];
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
    const c = n === 1 ? ability(pv.p1, pv.p1_form).avg : ability(pv.p2, pv.p2_form).avg;
    const f = form?.[n === 1 ? 'p1' : 'p2'];
    if (!f?.darts) return c;
    return (c * 60 + (f.scored / f.darts) * 3 * f.darts) / (60 + f.darts);
  };
  const a1 = avg(1), a2 = avg(2);
  const c1 = ability(pv.p1, pv.p1_form).avg, c2 = ability(pv.p2, pv.p2_form).avg;
  const start = m.start_score ?? 501;
  // Line the live model up with the pre-match one: with career averages at
  // the start of a leg it gives exactly the pre-match leg chance. Tonight's
  // form and the scores left then move it from there.
  const neutral = (liveLeg(start, start, 1, c1, c2) + liveLeg(start, start, 2, c1, c2)) / 2;
  const shift = logit(pLeg) - logit(clamp(neutral, 0.02, 0.98));
  const raw = liveLeg(m.p1_rem ?? start, m.p2_rem ?? start, m.turn ?? 1, a1, a2);
  // Only a hair off 0 and 1, so the maths never divides by zero. A match
  // that's all but over can show 99.9%; only the finish itself is 100%.
  const cur = clamp(sigmoid(logit(clamp(raw, 0.0001, 0.9999)) + shift), 0.0001, 0.9999);
  return clamp(fromLeg(cur, pLeg, m), 0.001, 0.999);
}
