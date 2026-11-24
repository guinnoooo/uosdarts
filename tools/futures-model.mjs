// The model's chances for the futures markets, used to move their prices
// week by week from the baselines set on the super admin page. It never
// sets a price on its own terms: the database keeps each published price
// and shifts it by however much these chances have changed since.
//
//   1. Run `select futures_model_data()::text` with the Supabase connector and
//      save the value as data.json.
//   2. node tools/futures-model.mjs data.json > probs.json
//   3. Run `select futures_apply_model('<contents of probs.json>'::jsonb)`.
//      It returns the prices that moved.
//
// Edit the rules below when they change (who can play on stage, the alumni
// cap, the Ham Cup format).

import fs from 'fs';
import { legChance, legFor, oomScore } from '../static/js/winprob.js';

// ---------------------------------------------------------------- rules

const CAPTAIN = "Ben O'Callaghan";
// Can't play on stage at all (graduated more than a year ago).
const NOT_ELIGIBLE = new Set(['Matt Watts', 'Luke Davies', 'Oli Graham', 'Adam Khalil', 'Jack Newton']);
// First-year alumni: at most two of them on stage.
const ALUMNI = new Set(['Lewis Forrest', 'Mikey Guinness', 'Matt Duke', 'James Beer', 'Adam Butcher', 'Harvey Richards', 'Louis Woods-Kelly']);
const ALUMNI_CAP = 2;
// Ben's picks lean towards these (on top of how good the model rates them).
const CAPTAIN_FAVOURS = new Set(['Mikey Guinness', 'Lewis Forrest']);
const PICK_SHARPNESS = 7;     // how strongly Ben's picks follow ability
const PICKS = 4;
// Knockout legs to win, counted back from the final.
const HAM_CUP_LEGS = [5, 4, 3, 3, 2, 2, 2];
const QUALIFIER_LEGS = [3, 3, 3, 3, 2, 2, 2];
const RUNS = 40000;

// ---------------------------------------------------------------- data

let raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (Array.isArray(raw)) raw = raw[0];
if (raw?.futures_model_data) raw = raw.futures_model_data;
if (typeof raw === 'string') raw = JSON.parse(raw);

const fig = a => a && { darts: a[0], avg: a[1], first9: a[2], dbl_pct: a[3] == null ? null : `${a[3]}%` };
const form = a => a && { wdarts: a[0], avg: a[1], first9: a[2], dbl_pct: a[3] == null ? null : `${a[3]}%` };
const oomRows = (raw.oom ?? []).map(([player_name, rank, total_points]) => ({ player_name, rank, total_points }));
const P = raw.players.map(([id, name, prov, career, fm, played, won, rating, rd, sd]) => ({
  id, name, prov, career: fig(career), form: form(fm), played, won, rating, rd, sd, oom: oomScore(oomRows, name),
}));
const F = new Map(P.map(p => [p.id, p]));
const ids = P.map(p => p.id);

// Seeded, so the same data always gives the same chances.
let s32 = 20261124;
const rand = () => { s32 = (s32 + 0x6D2B79F5) | 0; let t = Math.imul(s32 ^ (s32 >>> 15), 1 | s32); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const memo = new Map();
const leg = (a, b) => {
  const k = a + b;
  if (!memo.has(k)) {
    const x = F.get(a), y = F.get(b);
    memo.set(k, legChance({
      p1: x.career, p1_form: x.form, p1_prov: x.prov, p2: y.career, p2_form: y.form, p2_prov: y.prov,
      oom: { p1: x.oom, p2: y.oom }, p1_won: x.won, p1_played: x.played, p2_won: y.won, p2_played: y.played,
      p1_rating: x.rating, p1_rd: x.rd, p1_sd: x.sd, p2_rating: y.rating, p2_rd: y.rd, p2_sd: y.sd,
    }));
  }
  return memo.get(k);
};
const match = (a, b, toWin) => {
  const p = leg(a, b);
  let x = 0, y = 0, s = rand() < 0.5 ? 1 : 2;
  while (x < toWin && y < toWin) { if (rand() < legFor(p, s)) x++; else y++; s = 3 - s; }
  return x > y ? a : b;
};
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// A random-draw knockout, byes in the first round.
function knockout(field, legs) {
  if (field.length < 2) return field[0];
  let size = 1; while (size < field.length) size *= 2;
  const real = shuffle(field), byes = size - field.length, pairs = [];
  for (let i = 0; i < byes; i++) pairs.push([real[i], null]);
  for (let i = byes; i < real.length; i += 2) pairs.push([real[i], real[i + 1]]);
  let round = shuffle(pairs).flat();
  const rounds = Math.log2(size);
  for (let r = 0; round.length > 1; r++) {
    const toWin = legs[rounds - 1 - r] ?? 2, next = [];
    for (let i = 0; i < round.length; i += 2) {
      const a = round[i], b = round[i + 1];
      next.push(!a ? b : !b ? a : match(a, b, toWin));
    }
    round = next;
  }
  return round[0];
}

// ---------------------------------------------------------------- markets

const name = id => F.get(id).name;
const isAlum = id => ALUMNI.has(name(id));
const ben = P.find(p => p.name === CAPTAIN)?.id;
const strength = new Map(ids.map(a => [a, ids.filter(b => b !== a).reduce((t, b) => t + leg(a, b), 0) / (ids.length - 1)]));
const logit = p => Math.log(p / (1 - p));
const eligible = ids.filter(a => a !== ben && !NOT_ELIGIBLE.has(name(a)));
const weight = new Map(eligible.map(a => [a, Math.exp(PICK_SHARPNESS * logit(strength.get(a))) * (CAPTAIN_FAVOURS.has(name(a)) ? 3 : 1)]));

const ham = new Map(), stage = new Map(), qual = new Map(), notPicked = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
for (let i = 0; i < RUNS; i++) {
  bump(ham, knockout(ids, HAM_CUP_LEGS));

  // Ben's picks, then the two qualifiers among everyone left who's allowed.
  const pool = new Map(weight), picked = new Set();
  let alumni = 0;
  for (let k = 0; k < PICKS && pool.size; k++) {
    let tot = 0; for (const v of pool.values()) tot += v;
    let x = rand() * tot;
    for (const [id, v] of pool) { x -= v; if (x <= 0) { picked.add(id); pool.delete(id); if (isAlum(id)) alumni++; break; } }
    if (alumni >= ALUMNI_CAP) for (const id of [...pool.keys()]) if (isAlum(id)) pool.delete(id);
  }
  const left = eligible.filter(a => !picked.has(a));
  left.forEach(a => bump(notPicked, a));
  const field1 = left.filter(a => alumni < ALUMNI_CAP || !isAlum(a));
  const q1 = knockout(field1, QUALIFIER_LEGS);
  if (q1 && isAlum(q1)) alumni++;
  const q2 = knockout(field1.filter(a => a !== q1 && (alumni < ALUMNI_CAP || !isAlum(a))), QUALIFIER_LEGS);
  for (const q of [q1, q2]) if (q) bump(qual, q);
  for (const id of [...picked, q1, q2]) if (id) bump(stage, id);
}

const round4 = x => Math.round(x * 1e4) / 1e4;
const out = { 'ham-cup': {}, 'dartsity-stage': {}, 'dartsity-qualifiers': {} };
for (const id of ids) {
  out['ham-cup'][id] = round4((ham.get(id) ?? 0) / RUNS);
  if (eligible.includes(id)) {
    out['dartsity-stage'][id] = round4((stage.get(id) ?? 0) / RUNS);
    // Bets on someone Ben picks are void, so this is their chance if he doesn't.
    out['dartsity-qualifiers'][id] = round4((qual.get(id) ?? 0) / Math.max(1, notPicked.get(id) ?? 0));
  }
}
process.stdout.write(JSON.stringify(out));
