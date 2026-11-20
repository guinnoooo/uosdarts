// How well is the GuinnessBet / win probability model doing, and what should
// its weights be?
//
//   node tools/model-eval.mjs model-data.json
//
// model-data.json is the output of supabase/model-eval-export.sql: for each
// finished match, what the model knew when it started and how each leg went.
//
// It scores the current weights (log loss and Brier score, lower is better)
// against simple alternatives, shows how well calibrated the chances are, then
// searches for better weights. To avoid fitting to luck it tunes on the
// earlier 70% of matches and checks on the latest 30%, and only recommends
// new weights if they also do better on matches they never saw.

import fs from 'fs';
import { MODEL, legChance, legFor, matchChance } from '../static/js/winprob.js';

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/model-eval.mjs model-data.json'); process.exit(1); }
let data = JSON.parse(fs.readFileSync(file, 'utf8'));
// Accept the bare array (the copied cell) or the row it came in.
if (!Array.isArray(data)) data = data.model_data ?? [];
else if (data[0]?.model_data) data = data[0].model_data;
if (typeof data === 'string') data = JSON.parse(data);
data = data.filter(d => d.features && d.legs?.length);
if (!data.length) { console.log('No finished matches with snapshots yet.'); process.exit(0); }

const START = { ...MODEL };
const eps = 1e-6;
const ll = (p, won) => -Math.log(Math.min(1 - eps, Math.max(eps, won ? p : 1 - p)));
const brier = (p, won) => (p - (won ? 1 : 0)) ** 2;

// Every leg (bull offs left out) is one prediction: the pre-match leg chance,
// with whoever threw first in that leg counted. Matches are scored too, but
// there are far fewer of them.
function score(rows) {
  let legLL = 0, legBr = 0, legs = 0, mLL = 0, mBr = 0, ms = 0;
  for (const d of rows) {
    const p0 = legChance(d.features);
    for (const l of d.legs) {
      if (l.bull_off) continue;
      const p = legFor(p0, l.starter);
      legLL += ll(p, l.winner === 1); legBr += brier(p, l.winner === 1); legs++;
    }
    if (d.winner) {
      const pm = matchChance(d.features, d.features);
      mLL += ll(pm, d.winner === 1); mBr += brier(pm, d.winner === 1); ms++;
    }
  }
  return { legLL: legLL / legs, legBr: legBr / legs, legs, mLL: mLL / ms, mBr: mBr / ms, ms };
}

const fmt = s => `legs ${s.legs}: log loss ${s.legLL.toFixed(4)}, Brier ${s.legBr.toFixed(4)} | matches ${s.ms}: log loss ${s.mLL.toFixed(4)}, Brier ${s.mBr.toFixed(4)}`;
const withModel = (patch, fn) => { Object.assign(MODEL, START, patch); const r = fn(); Object.assign(MODEL, START); return r; };

console.log(`\n${data.length} matches, ${data[0].taken_at.slice(0, 10)} to ${data.at(-1).taken_at.slice(0, 10)}\n`);
console.log('Current weights   ', fmt(score(data)));
console.log('Coin flip         ', 'log loss 0.6931, Brier 0.2500 (what any model has to beat)');
console.log('Career only       ', fmt(withModel({ formWeight: 0, oomWeight: 0, h2hPrior: 1e9 }, () => score(data))));
console.log('No recent form    ', fmt(withModel({ formWeight: 0 }, () => score(data))));
console.log('No order of merit ', fmt(withModel({ oomWeight: 0 }, () => score(data))));
console.log('No head-to-head   ', fmt(withModel({ h2hPrior: 1e9 }, () => score(data))));
console.log('No throw edge     ', fmt(withModel({ throwEdge: 0 }, () => score(data))));
console.log('No rating         ', fmt(withModel({ ratingWeight: 0 }, () => score(data))));
console.log('No spread         ', fmt(withModel({ sdWeight: 0 }, () => score(data))));
console.log('No win rate       ', fmt(withModel({ winRateWeight: 0 }, () => score(data))));
console.log('Version 5 setup   ', fmt(withModel({ throwEdge: 0, ratingWeight: 0, sdWeight: 0, winRateWeight: 0.3 }, () => score(data))));

// Calibration: when the model says 60-70%, does that player win 60-70% of legs?
console.log('\nCalibration (player 1 leg chance):');
const buckets = Array.from({ length: 10 }, () => ({ n: 0, won: 0, sum: 0 }));
for (const d of data) {
  const p0 = legChance(d.features);
  for (const l of d.legs) {
    if (l.bull_off) continue;
    const p = legFor(p0, l.starter);
    const b = buckets[Math.min(9, Math.floor(p * 10))];
    b.n++; b.sum += p; if (l.winner === 1) b.won++;
  }
}
buckets.forEach((b, i) => b.n && console.log(
  `  ${i * 10}-${i * 10 + 10}%: said ${(b.sum / b.n * 100).toFixed(0)}%, happened ${(b.won / b.n * 100).toFixed(0)}% (${b.n} legs)`));

// Tune on the earlier 70%, check on the latest 30%.
const cut = Math.floor(data.length * 0.7);
const train = data.slice(0, cut), test = data.slice(cut);
if (train.length < 15 || test.length < 5) {
  console.log('\nNot enough matches yet to tune weights safely (need about 25). Check again later.');
  process.exit(0);
}
const KNOBS = {
  scale: [6, 30], formWeight: [0, 1], formFull: [30, 600], h2hPrior: [0.5, 20],
  oomWeight: [0, 2], oomWithHistory: [0, 1], f9Weight: [0, 1], dblWeight: [0, 0.5], knownDarts: [50, 1000], provDarts: [0, 300], winRateWeight: [0, 1], winRatePrior: [2, 40],
  throwEdge: [0, 0.5], ratingWeight: [0, 1], ratingCap: [0.2, 1.5], sdWeight: [0, 2],
};
// Leg log loss, plus a small pull back to the current weights so a handful of
// odd results can't drag anything to an extreme.
const objective = rows => {
  const s = score(rows);
  const pull = Object.keys(KNOBS).reduce((t, k) => {
    const [lo, hi] = KNOBS[k];
    return t + ((MODEL[k] - START[k]) / (hi - lo)) ** 2;
  }, 0);
  return s.legLL + 0.02 * pull;
};
let best = { ...START }, bestVal = withModel({}, () => objective(train));
for (let round = 0; round < 4; round++) {
  for (const [k, [lo, hi]] of Object.entries(KNOBS)) {
    for (let step = 0; step <= 20; step++) {
      const v = lo + ((hi - lo) * step) / 20;
      const val = withModel({ ...best, [k]: v }, () => objective(train));
      if (val < bestVal - 1e-6) { bestVal = val; best = { ...best, [k]: v }; }
    }
  }
}
const before = withModel({}, () => score(test));
const after = withModel(best, () => score(test));
console.log('\nOn the latest matches (not used for tuning):');
console.log('  current weights ', fmt(before));
console.log('  tuned weights   ', fmt(after));
console.log('  (tuned:', Object.keys(KNOBS).map(k => k + '=' + +best[k].toFixed(3)).join(', ') + ')');
const changed = Object.keys(KNOBS).filter(k => Math.abs(best[k] - START[k]) > 1e-9);
if (after.legLL < before.legLL - 0.002) {
  console.log('\nTuned weights do better on unseen matches. Suggested MODEL changes (static/js/winprob.js):');
  for (const k of changed) console.log(`  ${k}: ${START[k]} -> ${+best[k].toFixed(3)}`);
} else {
  console.log('\nNo change recommended: tuned weights did not beat the current ones on unseen matches.');
}
