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
export function oomScore(rows, name) {
  const pointed = (rows ?? []).filter(r => Number(r.total_points) > 0);
  const n = pointed.length;
  const r = pointed.find(x => x.player_name === name);
  if (!r) return 0.3;
  return 0.4 + 0.6 * (n > 1 ? 1 - (r.rank - 1) / (n - 1) : 1);
}

export function oomScores(rows, name1, name2) {
  return { p1: oomScore(rows, name1), p2: oomScore(rows, name2) };
}

// Every number the model uses, in one place, so it can be retuned once there
// are enough results to measure it against (see tools/model-eval.mjs).
export const MODEL = {
  version: 8,
  baseline: 45,       // average assumed for someone with no record and no provisional average
  scale: 14,          // average points that make about one step in leg odds
  f9Weight: 0.5,      // how much first 9 counts on top of the average
  dblWeight: 0.05,   // average points per percentage point of doubles above 25%
  formWeight: 0.6,    // how far recent form can move a player from their career level
  formFull: 150,      // weighted recent darts for recent form to count fully
  h2hPrior: 4,        // meetings before head-to-head counts for half
  h2hHalfLife: 42,    // days: a meeting's weight halves every six weeks
  knownDarts: 300,    // career darts for a full record (less is pulled to 50/50)
  provDarts: 150,     // how much record a provisional average is worth
  thinDarts: 100,     // fewer real darts than this (and no provisional average) gets the odds asterisk
  oomWeight: 0.6,     // order of merit gap to leg odds, with little history
  oomWithHistory: 0.4, // ...and the share of that left once both have a full record
  winRatePrior: 10,   // matches of 50% added to everyone's record, so a short record barely counts
  winRateWeight: 0.15, // how far the gap in (adjusted) win rates moves the leg odds (halved now the rating covers results too)
  winRateCap: 0.6,    // the most win rate can move them, in the model's steps (about 15 points at evens)
  legCap: 0.8,        // no one rated more than this to win a leg before it starts
  thinPull: 0.75,     // with no record, every input counts this much (rising to fully at knownDarts darts)
  throwEdge: 0.12,    // extra pull towards whoever throws first in a leg: about 53% between equals (measured 51.6% to 54.6% so far)
  ratingWeight: 0.25, // how far the results rating (Glicko) moves the leg odds
  ratingCap: 0.6,     // the most the rating can move them, in the model's steps
  sdRef: 27.4,        // a typical spread of visit scores
  sdWeight: 0.5,      // how much a wider spread (a streakier pair) pulls a leg towards 50/50
};

// Results rating (Glicko), worked out on the server from every finished
// match in order, so beating strong players counts for more than beating
// weak ones. Each rating comes with its uncertainty (rd): someone with few
// matches has a wide one and their rating counts for less. Anyone without a
// rating is a new player: 1500, as uncertain as it gets.
const GQ = Math.log(10) / 400;
function ratingShift(pv) {
  const r1 = num(pv.p1_rating, 1500), r2 = num(pv.p2_rating, 1500);
  const rd = Math.hypot(num(pv.p1_rd, 350), num(pv.p2_rd, 350));
  const g = 1 / Math.sqrt(1 + 3 * GQ * GQ * rd * rd / (Math.PI * Math.PI));
  const e = 1 / (1 + 10 ** (-g * (r1 - r2) / 400));
  return clamp(MODEL.ratingWeight * logit(clamp(e, 0.01, 0.99)), -MODEL.ratingCap, MODEL.ratingCap);
}

// How streaky the pair is: the spread of their visit scores against a
// typical one. Two players with the same average but wide spreads trade
// legs more, so the gap between them counts for a bit less.
function spreadFactor(pv) {
  const s1 = num(pv.p1_sd, MODEL.sdRef), s2 = num(pv.p2_sd, MODEL.sdRef);
  return (Math.sqrt((s1 * s1 + s2 * s2) / 2) / MODEL.sdRef) ** MODEL.sdWeight;
}

// A leg's chance for player 1 when player `starter` throws first, from the
// chance with nobody's throw counted (what legChance gives).
export function legFor(p, starter) {
  if (starter !== 1 && starter !== 2) return p;
  return sigmoid(logit(p) + (starter === 1 ? 1 : -1) * MODEL.throwEdge);
}

// Win rate, pulled towards 50% by winRatePrior matches. 3 from 4 reads as
// 57%, 15 from 20 as 67%, 60 from 80 as 72%: it counts for more the more
// matches someone has played, without a lucky short run counting for much.
export function shrunkRate(won, played) {
  return (num(won, 0) + MODEL.winRatePrior / 2) / (num(played, 0) + MODEL.winRatePrior);
}

function winRateShift(pv) {
  const r = pv.wr ?? { p1: shrunkRate(pv.p1_won, pv.p1_played), p2: shrunkRate(pv.p2_won, pv.p2_played) };
  return clamp(MODEL.winRateWeight * (logit(r.p1) - logit(r.p2)), -MODEL.winRateCap, MODEL.winRateCap);
}

const num = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };

// Career figures for player n, with any provisional average folded in. A
// provisional average is entered by hand for someone with little or no
// record. It stands in for the darts they haven't thrown yet and fades out
// as real ones come in, so it stops counting once they reach knownDarts.
export function careerOf(pv, n) {
  const c = pv?.[`p${n}`] ?? null;
  const prov = num(pv?.[`p${n}_prov`], NaN);
  if (!Number.isFinite(prov)) return c;
  const d = num(c?.darts, 0);
  if (d >= MODEL.knownDarts) return c;
  const w = d / MODEL.knownDarts;
  const mix = real => prov + w * (num(real, prov) - prov);
  return { ...c, avg: mix(c?.avg), first9: mix(c?.first9 ?? c?.avg), darts: Math.max(d, MODEL.provDarts) };
}

// True when someone in the match has too little record for the prices to
// mean much: under thinDarts real darts and no provisional average.
export function isThin(pv) {
  if (!pv) return false;
  if (typeof pv.thin === 'boolean') return pv.thin;
  return [1, 2].some(n => num(pv[`p${n}`]?.darts, 0) < MODEL.thinDarts
    && !Number.isFinite(num(pv[`p${n}_prov`], NaN)));
}

// Doubles, trebles and any game between typed-in names (from names_preview).
// Each player is rated on their own, with their career, recent form,
// provisional average and order of merit place, and each side gets the
// mean, since partners take turns at the board. Returns the same shape as
// match_preview, so the prices and the win probability work the same way.
// If anyone in the game has no profile on the site there's nothing to price
// them on, so the result is just { unavailable: true }. With guests allowed
// (the team match chart, which never shows prices), they count as the
// baseline player instead.
export function teamPreview(np, oomRows, guests = false) {
  if (!np?.side1?.length || !np?.side2?.length) return null;
  if (!guests && [...np.side1, ...np.side2].some(x => !x.id)) return { unavailable: true };
  const side = list => {
    const rated = list.map(x => {
      const c = careerOf({ p1: x.career, p1_prov: x.prov }, 1);
      return {
        a: ability(c, x.form),
        known: num(c?.darts, 0),
        thin: num(x.career?.darts, 0) < MODEL.thinDarts && !Number.isFinite(num(x.prov, NaN)),
        oom: oomScore(oomRows, x.name),
        wr: shrunkRate(x.won, x.played),
        rating: num(x.rating, 1500),
        rd: num(x.rd, 350),
        sd: num(x.sd, MODEL.sdRef),
      };
    });
    const mean = f => rated.reduce((t, r) => t + f(r), 0) / rated.length;
    return {
      career: { avg: mean(r => r.a.avg), first9: mean(r => r.a.f9), dbl_pct: mean(r => r.a.dbl), darts: Math.min(...rated.map(r => r.known)) },
      oom: mean(r => r.oom),
      wr: mean(r => r.wr),
      thin: rated.some(r => r.thin),
      rating: mean(r => r.rating),
      rd: Math.sqrt(mean(r => r.rd * r.rd)),
      sd: Math.sqrt(mean(r => r.sd * r.sd)),
    };
  };
  const s1 = side(np.side1), s2 = side(np.side2);
  return { p1: s1.career, p2: s2.career, oom: { p1: s1.oom, p2: s2.oom }, wr: { p1: s1.wr, p2: s2.wr },
    p1_rating: s1.rating, p1_rd: s1.rd, p2_rating: s2.rating, p2_rd: s2.rd, p1_sd: s1.sd, p2_sd: s2.sd,
    h2h: [], team: true, thin: s1.thin || s2.thin };
}

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

// Chance player 1 wins a single leg, before it starts, not counting who
// throws first (legFor adds that). What goes in: overall ability and recent
// form (above), how streaky both players are, the head-to-head (recent
// meetings counting more), the results rating, win rate (counting more the
// more matches played), and the order of merit, which matters most when
// there's little history. Players with little history are pulled towards 50/50.
export function legChance(pv) {
  const c1 = careerOf(pv, 1), c2 = careerOf(pv, 2);
  const a1 = ability(c1, pv.p1_form), a2 = ability(c2, pv.p2_form);
  let p = sigmoid((a1.strength - a2.strength) / (MODEL.scale * spreadFactor(pv)));
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
  const known = Math.min(1, Math.min(num(c1?.darts, 0), num(c2?.darts, 0)) / MODEL.knownDarts);
  let x = logit(p) + winRateShift(pv) + ratingShift(pv);
  // Order of merit. No points usually means new, and new players have
  // tended to be weaker, so it counts against them. But not when there's a
  // better guide to their level: a provisional average, or a rating from a
  // seed or results.
  const vague = n => !(pv.oom[`p${n}`] >= 0.4) && (Number.isFinite(num(pv[`p${n}_prov`], NaN)) || num(pv[`p${n}_rd`], 350) < 340);
  if (pv.oom && !vague(1) && !vague(2)) {
    x += (pv.oom.p1 - pv.oom.p2) * MODEL.oomWeight * (1 - (1 - MODEL.oomWithHistory) * known);
  }
  // Everything together is pulled towards 50/50 when either player has
  // little record: by a quarter with none, not at all once both have a full one.
  x *= MODEL.thinPull + (1 - MODEL.thinPull) * known;
  p = sigmoid(x);
  return clamp(p, 1 - MODEL.legCap, MODEL.legCap);
}

// Chance of being first to `a` more legs (or sets) before the other gets `b`,
// when player `next` throws first in the next one and the throw alternates
// after that. pl[1] and pl[2] are player 1's chance of each, by who starts it.
function race(a, b, pl, next, memo = new Map()) {
  if (!(a > 0)) return 1;   // also catches a missing number
  if (!(b > 0)) return 0;
  const k = (a * 100 + b) * 3 + next;
  if (!memo.has(k)) {
    const p = pl[next], o = 3 - next;
    memo.set(k, p * race(a - 1, b, pl, o, memo) + (1 - p) * race(a, b - 1, pl, o, memo));
  }
  return memo.get(k);
}

// From the current leg to the whole match, for legs or set play. The throw
// alternates leg by leg; in set play each set starts with the other player
// from the last, and the legs inside it alternate from there (as the site
// sets them up). `first` is who threw first in the match: when it isn't
// known yet (before the bull off) both ways are worked out and averaged.
// `cur` is the current leg's chance, or null to take it from the starter.
function fromLeg(cur, pLeg, m, first) {
  if (first !== 1 && first !== 2) return (fromLeg(cur, pLeg, m, 1) + fromLeg(cur, pLeg, m, 2)) / 2;
  const pl = { 1: legFor(pLeg, 1), 2: legFor(pLeg, 2) };
  const L = Math.max(1, Number(m.legs_to_win) || 1);
  const l1 = m.p1_legs ?? 0, l2 = m.p2_legs ?? 0;
  const sets = (m.p1_sets ?? 0) + (m.p2_sets ?? 0);
  const setStarter = !m.sets_to_win || sets % 2 === 0 ? first : 3 - first;
  const now = (l1 + l2) % 2 === 0 ? setStarter : 3 - setStarter;
  const c = cur ?? pl[now];
  const setNow = c * race(L - l1 - 1, L - l2, pl, 3 - now) + (1 - c) * race(L - l1, L - l2 - 1, pl, 3 - now);
  if (!m.sets_to_win) return setNow;
  const ps = { 1: race(L, L, pl, 1), 2: race(L, L, pl, 2) };
  const s1 = m.sets_to_win - (m.p1_sets ?? 0);
  const s2 = m.sets_to_win - (m.p2_sets ?? 0);
  const nextSet = 3 - setStarter;
  return setNow * race(s1 - 1, s2, ps, nextSet) + (1 - setNow) * race(s1, s2 - 1, ps, nextSet);
}

// GuinnessBet: chance player 1 wins the match, before it starts. Who throws
// first isn't known until the bull off, so it's worked out both ways.
export function matchChance(pv, m) {
  const pLeg = legChance(pv);
  return clamp(fromLeg(null, pLeg, { ...m, p1_legs: 0, p2_legs: 0, p1_sets: 0, p2_sets: 0 }, null), 0.04, 0.96);
}

// Chance player 1 wins from a given number of legs (and sets) each, between
// legs, when they win each leg with chance pLeg (before the throw is
// counted). `first` is who threw first in the game, if known. Used by the
// team match chart.
export function chanceFromScore(pLeg, m, first = null) {
  return fromLeg(null, pLeg, m, first);
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
//   m:    the match row (legs, sets, p1_rem / p2_rem, turn), plus .first:
//         who threw first in leg 1, when known
//   form: optional { p1: {darts, scored}, p2: {...} } for this match, which
//         shifts each player's average towards how they're throwing tonight
export function liveChance(pv, m, form) {
  if (m.status === 'complete') return (m.winner_id ? m.winner_id === m.player1_id : m.p1_legs > m.p2_legs) ? 1 : 0;
  const pLeg = legChance(pv);
  // Averages for this leg: career, moved towards tonight's form (60 darts of
  // career count about the same as 60 darts tonight).
  const avg = n => {
    const c = ability(careerOf(pv, n), pv[`p${n}_form`]).avg;
    const f = form?.[n === 1 ? 'p1' : 'p2'];
    if (!f?.darts) return c;
    return (c * 60 + (f.scored / f.darts) * 3 * f.darts) / (60 + f.darts);
  };
  const a1 = avg(1), a2 = avg(2);
  const c1 = ability(careerOf(pv, 1), pv.p1_form).avg, c2 = ability(careerOf(pv, 2), pv.p2_form).avg;
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
  return clamp(fromLeg(cur, pLeg, m, m.first ?? null), 0.001, 0.999);
}
