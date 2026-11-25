// How well are the match markets (static/js/markets.js) priced?
//
//   node tools/markets-eval.mjs model-data.json market-stats.txt
//
// model-data.json is what tools/model-eval.mjs reads (from
// supabase/model-eval-compact.sql); market-stats.txt is the output of
// supabase/markets-eval-export.sql, one line per match in the same order:
// what each player had thrown on the site before the match, and what they
// threw in it.
//
// For every market it compares the chances against a simple guess that
// knows nothing about the players (log loss, lower is better), checks the
// lines split near 50/50, and works out what the book would have made if
// someone had put 10 tokens on every outcome at our prices.

import fs from 'fs';
import { MK, marketChances, marketPrices, scoreDist } from '../static/js/markets.js';
import { decimalOf } from '../static/js/prices.js';

const [file, statsFile] = process.argv.slice(2);
if (!file || !statsFile) { console.error('Usage: node tools/markets-eval.mjs model-data.json market-stats.txt'); process.exit(1); }
let data = JSON.parse(fs.readFileSync(file, 'utf8'));
const stats = fs.readFileSync(statsFile, 'utf8').trim().split('\n').map(l => {
  const [t, l1, l2, L, S, start, p1, p2, a1, a2, first] = l.split('|');
  const pr = s => { const [v, tons, m180] = s.split(',').map(Number); return { v, tons, m180 }; };
  const ac = s => { if (!s) return null; const [v, tons, m180, avg, darts] = s.split(',').map(Number); return { v, tons, m180, avg, darts }; };
  return { t, l1: +l1, l2: +l2, L: +L, S: +S, start: +start, figs: { p1: pr(p1), p2: pr(p2) }, act: [ac(a1), ac(a2)], first: +first || null };
});
if (stats.length !== data.length) throw new Error(`${data.length} matches but ${stats.length} stat lines: export both at the same time`);

const eps = 1e-6;
const ll = p => -Math.log(Math.min(1 - eps, Math.max(eps, p)));
const res = {};
const add = (key, pModel, pNaive, overHit, book) => {
  const r = (res[key] ??= { n: 0, model: 0, naive: 0, a: 0, staked: 0, paid: 0 });
  r.n++; r.model += ll(pModel); r.naive += ll(pNaive); r.a += overHit ? 1 : 0; r.staked += book.staked; r.paid += book.paid;
};

// The naive guess: evenly matched players at the society's average.
const naivePv = { p1: null, p2: null, h2h: [], oom: null };
for (let i = 0; i < data.length; i++) {
  const d = data[i], s = stats[i];
  if (d.taken_at !== s.t) throw new Error(`Line ${i + 1} is ${s.t} but the match is ${d.taken_at}`);
  if (!s.act[0] || !s.act[1]) continue;
  const m = { player1_id: 1, player2_id: 2, legs_to_win: s.L, sets_to_win: s.S || null, start_score: s.start };
  const mks = marketChances(d.features, m, s.figs, ['P1', 'P2']);
  const naive = Object.fromEntries(marketChances(naivePv, m, {}, ['P1', 'P2']).map(x => [x.key, x]));
  const first = s.first ?? d.legs?.[0]?.winner ?? null;
  const r = { l1: s.l1, l2: s.l2, tons: [s.act[0].tons, s.act[1].tons], m180: [s.act[0].m180, s.act[1].m180], avg: [s.act[0].avg, s.act[1].avg], first };
  for (const mk of mks) {
    const win = winnerOf(mk, r);
    if (win == null) continue;
    const prices = marketPrices(mk);
    const book = { staked: 10 * prices.length, paid: 10 * decimalOf(prices[win]) };
    // The naive market can have a different line: score the same outcome under it where it can.
    const nv = naive[mk.key];
    let pn = 0.5;
    if (mk.multi) pn = nv?.outcomes.find(o => o.pick === mk.outcomes[win].pick)?.p ?? 1 / mk.outcomes.length;
    else if (mk.key === '180') pn = win === 0 ? nv.outcomes[0].p : nv.outcomes[1].p;
    else if (mk.key === 'first' || mk.key === 'hcap') pn = 0.5;
    add(mk.key.replace(/[12]$/, 'N'), mk.outcomes[win].p, pn, win === 0, book);
  }
}

function winnerOf(mk, r) {
  const t = r.tons[0] + r.tons[1];
  switch (mk.key) {
    case 'cs': return mk.outcomes.findIndex(o => o.pick === `${r.l1}-${r.l2}`);
    case 'hcap': { const d = mk.fav === 1 ? r.l1 - r.l2 : r.l2 - r.l1; return d > mk.line ? 0 : 1; }
    case 'legs': return r.l1 + r.l2 > mk.line ? 0 : 1;
    case 'first': return r.first ? (r.first === 1 ? 0 : 1) : null;
    case 'tons': return t > mk.line ? 0 : 1;
    case 'tons1': case 'tons2': return r.tons[+mk.key.slice(-1) - 1] > mk.line ? 0 : 1;
    case 'avg1': case 'avg2': { const a = r.avg[+mk.key.slice(-1) - 1]; return a == null ? null : a > mk.line ? 0 : 1; }
    case '180': return r.m180[0] + r.m180[1] > 0 ? 0 : 1;
  }
  return null;
}

console.log(`\nMarkets version ${MK.version}, ${data.length} matches\n`);
console.log('market     bets   log loss (model / know-nothing)   first outcome hit   book margin made');
for (const [k, r] of Object.entries(res)) {
  console.log(`${k.padEnd(9)} ${String(r.n).padStart(5)}   ${(r.model / r.n).toFixed(4)} / ${(r.naive / r.n).toFixed(4)}`
    + `                  ${(100 * r.a / r.n).toFixed(0).padStart(3)}%              ${(100 * (r.staked - r.paid) / r.staked).toFixed(1)}%`);
}
console.log('\n"first outcome hit" is how often Over (or Yes, or the first name) came in: near 50% means the lines are set well.');
console.log('"book margin made" is the share of all stakes kept if 10 tokens went on every outcome. It swings a lot over few matches.');
