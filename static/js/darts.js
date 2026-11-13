// Pure darts logic: no DOM, no database. Easy to test.

export const IMPOSSIBLE = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);
export const QUICK_SCORES = [26, 41, 45, 60, 81, 85, 100, 140, 180];

const nums = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

// Finishing doubles, most popular first
const DOUBLES = [20, 16, 18, 12, 10, 8, 14, 6, 4, 2]
  .map(n => ({ label: `D${n}`, v: n * 2 }))
  .concat([{ label: 'Bull', v: 50 }])
  .concat([19, 17, 15, 13, 11, 9, 7, 5, 3, 1].map(n => ({ label: `D${n}`, v: n * 2 })));

// Set-up darts, preferred first
const SETUP = [
  ...nums.map(n => ({ label: `T${n}`, v: n * 3 })),
  { label: 'Bull', v: 50 },
  { label: '25', v: 25 },
  ...nums.map(n => ({ label: String(n), v: n })),
  ...nums.map(n => ({ label: `D${n}`, v: n * 2 })),
];

function setupFor(v) {
  return SETUP.find(s => s.v === v) ?? null;
}

// Returns e.g. ['T20', 'T20', 'Bull'] or null if no finish within `darts` darts.
export function checkout(rem, darts = 3) {
  if (rem < 2 || rem > 170) return null;
  const one = DOUBLES.find(d => d.v === rem);
  if (one) return [one.label];
  if (darts < 2) return null;
  for (const d of DOUBLES) {
    const s = setupFor(rem - d.v);
    if (s) return [s.label, d.label];
  }
  if (darts < 3) return null;
  for (const a of SETUP) {
    if (a.v >= rem) continue;
    const rest = checkout(rem - a.v, 2);
    if (rest && rest.length === 2) return [a.label, ...rest];
  }
  return null;
}

// Fewest darts that could finish `rem`, or null if it can't be done in one visit.
export function minDarts(rem) {
  for (const n of [1, 2, 3]) if (checkout(rem, n)) return n;
  return null;
}

export function isValidVisit(score) {
  return Number.isInteger(score) && score >= 0 && score <= 180 && !IMPOSSIBLE.has(score);
}

export function playerStats(visits, legs, p) {
  const vs = visits.filter(v => v.player === p);
  const darts = vs.reduce((a, v) => a + v.darts, 0);
  const scored = vs.reduce((a, v) => a + v.score, 0);
  const checkouts = vs.filter(v => v.remaining === 0).map(v => v.score);

  let bestLeg = null;
  for (const l of legs) {
    if (l.winner !== p) continue;
    const d = vs.filter(v => v.leg_id === l.id).reduce((a, v) => a + v.darts, 0);
    if (bestLeg === null || d < bestLeg) bestLeg = d;
  }

  // Every leg won ends on a double, so legs won is the number of doubles hit.
  const dblHit = legs.filter(l => l.winner === p).length;
  const dblAt = vs.reduce((a, v) => a + (v.darts_at_double ?? 0), 0);

  return {
    avg: darts ? (scored / darts) * 3 : null,
    darts,
    // Cumulative: a 180 counts in all three bands, a 140 counts in the first two.
    ton: vs.filter(v => v.score >= 100).length,
    ton40: vs.filter(v => v.score >= 140).length,
    max: vs.filter(v => v.score === 180).length,
    hiCheckout: checkouts.length ? Math.max(...checkouts) : null,
    bestLeg,
    dblHit,
    dblAt,
    dblPct: dblAt ? (dblHit / dblAt) * 100 : null,
  };
}
