// GuinnessBet match markets beyond the winner: correct score, leg handicap,
// total legs, first leg, 100+ visits, player averages and a 180. Shared by
// the match page and the place-bet edge function, so a bet is struck at the
// price people see. No browser or database code in here.
//
// Everything is worked out before the match starts, from the same inputs as
// the winner odds (match_preview) plus each player's visit record
// (market_figures: visits, 100+ visits and 180s thrown on the site). The
// numbers in MK were checked against every finished match with a snapshot
// (tools/markets-eval.mjs).

import { legChance, legFor, careerOf, ability } from './winprob.js';
import { LADDER, ladderValue, decimalOf } from './prices.js';

export const MK = {
  version: 1,
  newAvg: 39.5,        // expected average of someone with no record at all
  avgLift: 1.2,        // players with a record have thrown a little above their expected average
  visitsA: 1.1,        // visits each player throws per leg:
  visitsB: 0.93,       //   visitsA + visitsB * 501 / (better player's average)
  tonA: -3.0,          // 100+ visit rate from average: logistic in (avg - 45)
  tonB: 0.094,
  tonPrior: 150,       // visits of the curve a player's own 100+ rate is pulled towards
  maxA: -7.1,          // 180 rate from average, the same way
  maxB: 0.146,
  maxPrior: 1500,
  nightSpread: 0.7,      // how much a player's leg chance varies from night to night (logit scale)
  avgSpread: 7,         // how far a match average strays from the expected one, beyond luck
  visitSd: 27.4,       // spread of a single visit when a player's own isn't known
  book2: 1.09,         // margin on two-way markets (the winner market has 1.045)
  bookMulti: 0.2,      // total margin on correct score, spread over the scores
};

// Longer prices than the winner market needs, for correct scores and 180s.
export const LONG_LADDER = [...LADDER, '40/1', '50/1', '66/1', '80/1', '100/1'];
const implied = f => 1 / (ladderValue(f) + 1);
function priceFor(prob, ladder) {
  let best = ladder[0];
  for (const f of ladder) if (implied(f) >= prob) best = f;
  return best;
}

const sigmoid = x => 1 / (1 + Math.exp(-x));
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

// Which markets a match can have. Legs only (no sets), two linked players,
// and for the scoring markets a 501 start. A single leg has no leg markets.
export function marketsAllowed(m) {
  if (!m || m.sets_to_win || !(m.player1_id && m.player2_id)) return { legs: false, stats: false };
  const L = Number(m.legs_to_win) || 1;
  return { legs: L >= 2, stats: (m.start_score ?? 501) === 501 };
}

// Chance of each final score, with the throw alternating leg by leg and the
// bull off a coin flip. Returns [{ a, b, p }] (player 1 legs, player 2 legs).
// Legs in a match aren't quite independent: whoever's throwing better on
// the night tends to keep winning. So the leg chance is spread around the
// model's by nightSpread, and the scores averaged over that spread.
const GH = [[-2.0202, 0.0200], [-0.9586, 0.3936], [0, 0.9453], [0.9586, 0.3936], [2.0202, 0.0200]];
export function scoreDist(pv, L) {
  const base = legChance(pv);
  const out = new Map();
  const nodes = MK.nightSpread > 0 ? GH : [[0, Math.sqrt(Math.PI)]];
  for (const [z, w] of nodes) {
    const p0 = sigmoid(Math.log(base / (1 - base)) + Math.SQRT2 * MK.nightSpread * z);
    const wt = w / Math.sqrt(Math.PI);
    scoresFrom(p0, L, wt, out);
  }
  return [...out].map(([k, p]) => { const [a, b] = k.split(',').map(Number); return { a, b, p }; });
}

function scoresFrom(p0, L, wt, out) {
  for (const first of [1, 2]) {
    let cur = new Map([['0,0', 0.5 * wt]]);
    for (let leg = 0; leg < 2 * L - 1; leg++) {
      const starter = leg % 2 === 0 ? first : 3 - first;
      const q = legFor(p0, starter);
      const next = new Map();
      for (const [k, p] of cur) {
        const [a, b] = k.split(',').map(Number);
        if (a === L || b === L) { next.set(k, (next.get(k) ?? 0) + p); continue; }
        const w = `${a + 1},${b}`, l = `${a},${b + 1}`;
        next.set(w, (next.get(w) ?? 0) + p * q);
        next.set(l, (next.get(l) ?? 0) + p * (1 - q));
      }
      cur = next;
    }
    for (const [k, p] of cur) out.set(k, (out.get(k) ?? 0) + p);
  }
}

// Expected average for player n, as the winner model sees them; someone
// with no record and no provisional average is expected to be newAvg.
export function expectedAvg(pv, n) {
  const c = careerOf(pv, n);
  if (!(num(c?.darts, 0) > 0)) return MK.newAvg;
  return ability(c, pv[`p${n}_form`]).avg + MK.avgLift;
}

// A player's chance per visit of 100+ (or 180): the curve for their
// average, moved towards what they've actually thrown on the site.
function rate(fig, field, avg, a, b, prior) {
  const curve = sigmoid(a + b * (avg - 45));
  const v = num(fig?.v, 0), k = num(fig?.[field], 0);
  return (k + prior * curve) / (v + prior);
}

const poissonCdf = (k, lam) => {   // P(X <= k)
  let t = Math.exp(-lam), s = t;
  for (let i = 1; i <= k; i++) { t *= lam / i; s += t; }
  return Math.min(1, s);
};
const normCdf = x => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

// The line x.5 that splits a distribution closest to 50/50, given P(X <= k).
function halfLine(cdf, lo, hi) {
  let best = lo + 0.5, gap = 2;
  for (let k = lo; k < hi; k++) { const g = Math.abs(cdf(k) - 0.5); if (g < gap) { gap = g; best = k + 0.5; } }
  return best;
}

// All the chances, before margins. m is the match row, figs is
// market_figures ({ p1: { v, tons, m180 }, p2: {...} }), names the players'.
export function marketChances(pv, m, figs, names) {
  const ok = marketsAllowed(m);
  if (!pv || (!ok.legs && !ok.stats)) return [];
  const L = Math.max(1, Number(m.legs_to_win) || 1);
  const dist = scoreDist(pv, L);
  const [n1, n2] = names;
  const out = [];
  const two = (key, title, a, b, pa, line = null) =>
    out.push({ key, title, line, outcomes: [{ pick: 'a', label: a, p: pa }, { pick: 'b', label: b, p: 1 - pa }] });

  if (ok.legs) {
    out.push({ key: 'cs', title: 'Correct score', multi: true,
      outcomes: dist.slice().sort((x, y) => (y.a - y.b) - (x.a - x.b) || y.a - x.a)
        .map(d => ({ pick: `${d.a}-${d.b}`, label: `${d.a > d.b ? n1 : n2} ${Math.max(d.a, d.b)}-${Math.min(d.a, d.b)}`, p: d.p })) });
    // Leg handicap: the favourite gives the line that's closest to 50/50.
    const pWin = dist.filter(d => d.a > d.b).reduce((t, d) => t + d.p, 0);
    const fav = pWin >= 0.5 ? 1 : 2;
    let best = null;
    for (let h = 1.5; h < L; h += 1) {
      const pf = dist.filter(d => (fav === 1 ? d.a - d.b : d.b - d.a) > h).reduce((t, d) => t + d.p, 0);
      if (!best || Math.abs(pf - 0.5) < Math.abs(best.pf - 0.5)) best = { h, pf };
    }
    if (best) {
      const [fn, dn] = fav === 1 ? [n1, n2] : [n2, n1];
      two('hcap', 'Leg handicap', `${fn} -${best.h}`, `${dn} +${best.h}`, best.pf, best.h);
      out[out.length - 1].fav = fav;
    }
    const legsCdf = k => dist.filter(d => d.a + d.b <= k).reduce((t, d) => t + d.p, 0);
    const lineL = halfLine(legsCdf, L, 2 * L - 1);
    two('legs', 'Total legs', `Over ${lineL}`, `Under ${lineL}`, 1 - legsCdf(Math.floor(lineL)), lineL);
    const p0 = legChance(pv);
    two('first', 'First leg', n1, n2, (legFor(p0, 1) + legFor(p0, 2)) / 2);
  }

  if (ok.stats) {
    const mu = [expectedAvg(pv, 1), expectedAvg(pv, 2)];
    const perLeg = MK.visitsA + MK.visitsB * 501 / Math.max(15, Math.max(...mu));
    const tr = [1, 2].map(n => rate(figs?.[`p${n}`], 'tons', mu[n - 1], MK.tonA, MK.tonB, MK.tonPrior));
    const mr = [1, 2].map(n => rate(figs?.[`p${n}`], 'm180', mu[n - 1], MK.maxA, MK.maxB, MK.maxPrior));
    // Over a mix of match lengths, weighted by the chance of each.
    const mix = f => dist.reduce((t, d) => t + d.p * f(d.a + d.b), 0);
    const tonCdf = r => k => mix(n => poissonCdf(k, r * perLeg * n));
    const totalCdf = tonCdf(tr[0] + tr[1]);
    const lineT = halfLine(totalCdf, 0, 60);
    two('tons', 'Total 100+ visits', `Over ${lineT}`, `Under ${lineT}`, 1 - totalCdf(Math.floor(lineT)), lineT);
    for (const n of [1, 2]) {
      const cdf = tonCdf(tr[n - 1]);
      const line = halfLine(cdf, 0, 40);
      two(`tons${n}`, `${names[n - 1]} 100+ visits`, `Over ${line}`, `Under ${line}`, 1 - cdf(Math.floor(line)), line);
    }
    for (const n of [1, 2]) {
      const sdv = num(pv[`p${n}_sd`], MK.visitSd);
      const line = Math.round(mu[n - 1] * 2) / 2 + (Number.isInteger(Math.round(mu[n - 1] * 2) / 2) ? 0.5 : 0);
      const pOver = mix(k => 1 - normCdf((line - mu[n - 1]) / Math.sqrt(MK.avgSpread ** 2 + sdv * sdv / (perLeg * k))));
      two(`avg${n}`, `${names[n - 1]} match average`, `Over ${line.toFixed(1)}`, `Under ${line.toFixed(1)}`, pOver, line);
    }
    const p180 = 1 - mix(k => Math.exp(-(mr[0] + mr[1]) * perLeg * k));
    two('180', '180 in the match', 'Yes', 'No', p180);
  }
  return out;
}

// Book prices for one market. Two-way markets are made like the winner
// market (rounded shorter so the book is always over 100%) with a bigger
// margin; correct score spreads its margin over the scores.
export function marketPrices(mk) {
  if (mk.multi) {
    const total = mk.outcomes.reduce((t, o) => t + o.p, 0);
    return mk.outcomes.map(o => priceFor(Math.min(0.97, (o.p / total) * (1 + MK.bookMulti)), LONG_LADDER));
  }
  const [pa, pb] = mk.outcomes.map(o => o.p);
  const withMargin = q => q + (MK.book2 - 1) * 2 * q * (1 - q);
  const fa = pa >= pb;
  const pf = Math.max(pa, pb);
  const favPrice = priceFor(Math.min(0.97, withMargin(pf)), LONG_LADDER);
  const dogPrice = priceFor(Math.max(withMargin(1 - pf), 1.06 - implied(favPrice)), LONG_LADDER);
  return fa ? [favPrice, dogPrice] : [dogPrice, favPrice];
}

// Everything for the page: markets with a price on each outcome.
export function matchMarkets(pv, m, figs, names) {
  return marketChances(pv, m, figs, names).map(mk => {
    const prices = marketPrices(mk);
    return { ...mk, outcomes: mk.outcomes.map((o, i) => ({ ...o, price: prices[i], decimal: decimalOf(prices[i]) })) };
  });
}

// How a pick reads on a slip or a bet: "Egan 3-1", "Total legs: Over 6.5".
export function pickLabel(mk, o) {
  return ['cs', 'hcap'].includes(mk.key) ? o.label : `${mk.title}: ${o.label}`;
}
