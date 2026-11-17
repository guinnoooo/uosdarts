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

// Recommended routes, taken from the CSW Darts checkout chart
// (cswdarts.co.uk/darts-checkout-chart). Score:route, darts joined with "-".
const CHART = new Map((
  '170:T20-T20-Bull 167:T20-T19-Bull 164:T20-T18-Bull 161:T20-T17-Bull 160:T20-T20-D20 ' +
  '158:T20-T20-D19 157:T20-T19-D20 156:T20-T20-D18 155:T20-T19-D19 154:T20-T18-D20 ' +
  '153:T20-T19-D18 152:T20-T20-D16 151:T20-T17-D20 150:T20-T18-D18 149:T20-T19-D16 ' +
  '148:T20-T16-D20 147:T20-T17-D18 146:T20-T18-D16 145:T20-T15-D20 144:T20-T20-D12 ' +
  '143:T20-T17-D16 142:T20-T14-D20 141:T20-T19-D12 140:T20-T20-D10 139:T19-T14-D20 ' +
  '138:T20-T18-D12 137:T20-T19-D10 136:T20-T20-D8 135:T20-T17-D12 134:T20-T14-D16 ' +
  '133:T20-T19-D8 132:Bull-T14-D20 131:T20-T13-D16 130:T20-T20-D5 129:T19-T20-D6 ' +
  '128:T18-T14-D16 127:T20-T17-D8 126:T19-T19-D6 125:T18-T19-D7 124:T20-T16-D8 ' +
  '123:T19-T16-D9 122:T18-T18-D7 121:T20-T11-D14 120:T20-20-D20 119:T20-19-D20 ' +
  '118:T20-18-D20 117:T20-17-D20 116:T20-16-D20 115:T19-18-D20 114:T20-14-D20 ' +
  '113:T19-16-D20 112:T20-12-D20 111:T19-14-D20 110:T20-Bull 109:T20-17-D16 108:T20-16-D16 ' +
  '107:T19-18-D16 106:T20-14-D16 105:T19-16-D16 104:T18-18-D16 103:T19-14-D16 ' +
  '102:T20-10-D16 101:T17-18-D16 100:T20-D20 99:T19-10-D16 98:T20-D19 97:T19-D20 96:T20-D18 ' +
  '95:T19-D19 94:T18-D20 93:T19-D18 92:T20-D16 91:T17-D20 90:T20-D15 89:T19-D16 88:T20-D14 ' +
  '87:T17-D18 86:T18-D16 85:T15-D20 84:T20-D12 83:T17-D16 82:Bull-D16 81:T19-D12 80:T20-D10 ' +
  '79:T19-D11 78:T18-D12 77:T19-D10 76:T20-D8 75:T17-D12 74:T14-D16 73:T19-D8 72:T16-D12 ' +
  '71:T13-D16 70:T18-D8 69:T19-D6 68:T20-D4 67:T17-D8 66:T10-D18 65:T19-D4 64:T16-D8 ' +
  '63:T13-D12 62:T10-D16 61:T15-D8 60:20-D20 59:19-D20 58:18-D20 57:17-D20 56:16-D20 ' +
  '55:15-D20 54:14-D20 53:13-D20 52:20-D16 51:19-D16 50:Bull 49:17-D16 48:16-D16 47:15-D16 ' +
  '46:14-D16 45:13-D16 44:12-D16 43:11-D16 42:10-D16 41:9-D16 40:D20 39:7-D16 38:D19 ' +
  '37:5-D16 36:D18 35:3-D16 34:D17 33:1-D16 32:D16 31:15-D8 30:D15 29:13-D8 28:D14 27:11-D8 ' +
  '26:D13 25:9-D8 24:D12 23:7-D8 22:D11 21:5-D8 20:D10 19:3-D8 18:D9 17:1-D8 16:D8 15:7-D4 ' +
  '14:D7 13:5-D4 12:D6 11:3-D4 10:D5 9:1-D4 8:D4 7:3-D2 6:D3 5:1-D2 4:D2 3:1-D1 2:D1 '
).trim().split(/\s+/).map(e => {
  const [score, route] = e.split(':');
  return [Number(score), route.split('-')];
}));

// Returns e.g. ['T20', 'T20', 'Bull'] or null if no finish within `darts` darts.
// Uses the chart when its route fits in the darts left, otherwise works one out.
export function checkout(rem, darts = 3) {
  const route = CHART.get(rem);
  if (route && route.length <= darts) return [...route];
  return computeCheckout(rem, darts);
}

function computeCheckout(rem, darts = 3) {
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
    const rest = computeCheckout(rem - a.v, 2);
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
    if (l.winner !== p || l.bull_off) continue;
    const d = vs.filter(v => v.leg_id === l.id).reduce((a, v) => a + v.darts, 0);
    if (bestLeg === null || d < bestLeg) bestLeg = d;
  }

  // Every leg won ends on a double, so legs won is the number of doubles hit.
  // A leg settled on a bull off had no double, so it doesn't count.
  const dblHit = legs.filter(l => l.winner === p && !l.bull_off).length;

  // First 9: the first three visits of each leg.
  let f9darts = 0, f9scored = 0;
  for (const l of legs) {
    for (const v of vs.filter(x => x.leg_id === l.id).slice(0, 3)) { f9darts += v.darts; f9scored += v.score; }
  }
  const dblAt = vs.reduce((a, v) => a + (v.darts_at_double ?? 0), 0);

  return {
    avg: darts ? (scored / darts) * 3 : null,
    darts,
    first9: f9darts ? (f9scored / f9darts) * 3 : null,
    // Separate bands: a 180 is only a 180, a 140 isn't also a 100+.
    ton: vs.filter(v => v.score >= 100 && v.score < 140).length,
    ton40: vs.filter(v => v.score >= 140 && v.score < 180).length,
    max: vs.filter(v => v.score === 180).length,
    hiCheckout: checkouts.length ? Math.max(...checkouts) : null,
    bestLeg,
    dblHit,
    dblAt,
    dblPct: dblAt ? (dblHit / dblAt) * 100 : null,
  };
}
