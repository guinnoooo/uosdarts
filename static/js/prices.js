// GuinnessBet match prices, shared by the match page and the place-bet edge
// function (supabase/functions/place-bet), so a bet is always struck at the
// price people see. No browser or database code in here.

import { matchChance, oomScores, teamPreview } from './winprob.js';

// Pretend bookmaker odds. The chance of each player winning comes from
// winprob.js; the prices are then made like a real book: a margin is built
// in and every price is rounded shorter, never longer, so the two sides
// always add up to more than 100% and there's no way to back both and be
// sure of a profit.
export const LADDER = ['1/100', '1/66', '1/50', '1/40', '1/33', '1/25', '1/20', '1/16', '1/14', '1/12', '1/10',
  '1/9', '1/8', '1/7', '1/6', '1/5', '2/9', '1/4', '2/7', '1/3', '4/11', '2/5', '4/9', '1/2', '8/15', '4/7',
  '8/13', '4/6', '8/11', '4/5', '5/6', '10/11', 'Evens', '11/10', '6/5', '5/4', '11/8', '6/4', '13/8', '7/4',
  '15/8', '2/1', '9/4', '5/2', '11/4', '3/1', '10/3', '7/2', '4/1', '9/2', '5/1', '11/2', '6/1', '13/2',
  '7/1', '15/2', '8/1', '9/1', '10/1', '11/1', '12/1', '14/1', '16/1', '18/1', '20/1', '25/1', '33/1'];
export const ladderValue = f => (f === 'Evens' ? 1 : f.split('/').reduce((a, b) => a / b));
const implied = f => 1 / (ladderValue(f) + 1);
const BOOK = 1.045;  // about 4.5% margin, so two even players are 10/11 each

// What a winning bet returns per token staked, stake included (6/4 -> 2.5).
export const decimalOf = f => Math.round((ladderValue(f) + 1) * 10000) / 10000;

// The longest price on the ladder whose implied chance is at least `prob`.
function priceFor(prob) {
  let best = LADDER[0];
  for (const f of LADDER) if (implied(f) >= prob) best = f;
  return best;
}

export function bookPrices(p1) {
  const fav = p1 >= 0.5 ? 1 : 2;
  const pf = Math.max(p1, 1 - p1);
  // Favourite first, rounded shorter.
  // The margin is shared the way bookmakers do it: most of it on prices
  // near evens, very little on a heavy favourite.
  const withMargin = q => q + (BOOK - 1) * 2 * q * (1 - q);
  const favPrice = priceFor(Math.min(0.99, withMargin(pf)));
  // Then the outsider, rounded shorter, and short enough that the book
  // stays over 100% even when the favourite had to be rounded a lot.
  const dogPrice = priceFor(Math.max(withMargin(1 - pf), 1.03 - implied(favPrice)));
  return fav === 1 ? [favPrice, dogPrice] : [dogPrice, favPrice];
}

// The model's input for a match, the way the match page builds it:
//   linked players: match_preview plus each player's order of merit score;
//   typed-in names (UDUK / Franny games): names_preview, rated player by
//   player, and only when everyone has a profile.
// m needs player1_id/player2_id or p1_name/p2_name; name1/name2 are the
// players' names. Returns null when there are no odds for the match.
export function previewFor(m, { preview, names, oomRows, name1, name2 }) {
  if (m.player1_id && m.player2_id) {
    if (!preview) return null;
    return { ...preview, oom: oomScores(oomRows ?? [], name1, name2) };
  }
  const pv = names ? teamPreview(names, oomRows ?? []) : null;
  if (!pv || pv.unavailable) return null;
  return { ...pv, h2h: names?.h2h ?? [] };
}

export const matchPrices = (pv, m) => bookPrices(matchChance(pv, m));
