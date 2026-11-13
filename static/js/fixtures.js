// Pure fixture and standings logic. No DOM, no database.

export function roundName(round, totalRounds) {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Last ${2 ** (fromEnd + 1)}`;
}

// Describes the knockout a given number of players produces: one entry per
// round, listed from the final backwards. `contested` is how many matches are
// actually played, which is lower than `slots` in the first round when the
// field doesn't fill the bracket.
export function bracketPlan(n) {
  if (!n || n < 2) return [];
  const size = 2 ** Math.ceil(Math.log2(n));
  const rounds = Math.log2(size);
  const plan = [];
  for (let r = rounds; r >= 1; r--) {
    const slots = size / 2 ** r;
    const byes = r === 1 ? size - n : 0;
    plan.push({
      round: r,
      fromEnd: rounds - r,   // 0 = final, 1 = semi-final, and so on
      name: roundName(r, rounds),
      slots,
      byes,
      contested: slots - byes,
      isPrelim: byes > 0 && r === 1,
    });
  }
  return plan;
}

// Round robin by the circle method. Returns an array of rounds, each an array of [a, b] pairs.
export function roundRobin(ids) {
  const p = [...ids];
  if (p.length % 2) p.push(null);
  const n = p.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = p[i];
      const b = p[n - 1 - i];
      if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    p.splice(1, 0, p.pop());
  }
  return rounds;
}

// Standard bracket order, e.g. size 8 -> [1, 8, 4, 5, 2, 7, 3, 6]
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const len = order.length * 2;
    order = order.flatMap(s => [s, len + 1 - s]);
  }
  return order;
}

// Snake draft into groups: seeds 1..G across, then back.
export function allocateGroups(ids, groupCount) {
  const groups = Array.from({ length: groupCount }, () => []);
  ids.forEach((id, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    groups[row % 2 === 0 ? col : groupCount - 1 - col].push(id);
  });
  return groups;
}

// Builds every knockout match row for `seededIds` (best seed first).
// Returns rows with pre-made ids so next_match_id links can be set up front.
export function buildBracket(seededIds, base, makeId = () => crypto.randomUUID()) {
  const n = seededIds.length;
  if (n < 2) throw new Error('Need at least 2 players for a knockout');
  const size = 2 ** Math.ceil(Math.log2(n));
  const rounds = Math.log2(size);
  const order = seedOrder(size);

  const ids = {};
  for (let r = 1; r <= rounds; r++) {
    ids[r] = {};
    for (let s = 1; s <= size / 2 ** r; s++) ids[r][s] = makeId();
  }

  const rows = [];
  for (let r = 1; r <= rounds; r++) {
    for (let s = 1; s <= size / 2 ** r; s++) {
      rows.push({
        ...base,
        id: ids[r][s],
        stage: 'knockout',
        round: r,
        slot: s,
        player1_id: r === 1 ? seededIds[order[2 * s - 2] - 1] ?? null : null,
        player2_id: r === 1 ? seededIds[order[2 * s - 1] - 1] ?? null : null,
        next_match_id: r < rounds ? ids[r + 1][Math.ceil(s / 2)] : null,
        next_slot: r < rounds ? (s % 2 ? 1 : 2) : null,
      });
    }
  }
  return { rows, rounds };
}

// League table for one group. players: [{id, name}], matches: group matches.
export function standings(players, matches) {
  const t = new Map(players.map(p => [p.id, {
    id: p.id, name: p.name, P: 0, W: 0, L: 0, LF: 0, LA: 0, Pts: 0,
  }]));
  for (const m of matches) {
    if (m.status !== 'complete') continue;
    const a = t.get(m.player1_id);
    const b = t.get(m.player2_id);
    if (!a || !b) continue;
    a.P++; b.P++;
    a.LF += m.p1_legs; a.LA += m.p2_legs;
    b.LF += m.p2_legs; b.LA += m.p1_legs;
    if (m.winner_id === a.id) { a.W++; b.L++; a.Pts += 2; } else { b.W++; a.L++; b.Pts += 2; }
  }
  return [...t.values()].sort((x, y) =>
    y.Pts - x.Pts ||
    (y.LF - y.LA) - (x.LF - x.LA) ||
    y.LF - x.LF ||
    x.name.localeCompare(y.name));
}
