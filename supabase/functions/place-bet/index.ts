// place-bet: prices a GuinnessBet bet with the site's own model and places it.
//
// The browser never says what price to pay out at. It sends what it wants
// to back and the price it was shown; this works the price out again from
// the database with the same code the site uses (winprob.js, prices.js,
// outright.js). If the two differ, nothing is placed and the new price is
// sent back for the person to accept. Otherwise place_bet_internal checks
// the account, the stake and that betting is still open, takes the tokens
// and records the bet.
//
// The shared .js files are copied in next to this file when it's deployed
// (see .github/workflows/deploy-functions.yml), so they always match the site.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { MODEL, oomScore, matchChance } from './winprob.js';
import { previewFor, matchPrices, decimalOf } from './prices.js';
import { outrightOdds, outrightPrice } from './outright.js';
import { MK, matchMarkets, pickLabel } from './markets.js';

const MATCH_SELECT =
  '*, p1:players!matches_player1_id_fkey(id,name), p2:players!matches_player2_id_fkey(id,name)';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: 'Bad request' }, 400); }
  const stake = Math.floor(Number(body.stake));
  const shown = String(body.price ?? '');
  const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });

  try {
    // Pre-match chances for fantasy darts (who was the underdog), worked out
    // from the snapshot taken as each match started. Anyone can ask; it
    // only ever fills in what's missing.
    if (body.kind === 'prematch') return reply(await fillPrematch(db));
    if (body.kind === 'sels') return reply(await placeSelections(db, req, body, stake));
    if (body.kind !== 'match' && body.kind !== 'outright') return reply({ error: 'Bad request' }, 400);
    // Who's asking (not needed for a quote) and the price, worked out side by side.
    const auth = req.headers.get('Authorization') ?? '';
    const who = body.quote ? Promise.resolve(null)
      : createClient(URL_, ANON, { global: { headers: { Authorization: auth } } }).auth.getUser().then(r => r.data.user, () => null);
    const pricing = body.kind === 'match'
      ? priceMatch(db, String(body.match_id), Number(body.side))
      : priceOutright(db, String(body.tournament_id), String(body.player_id));
    const [user, bet] = await Promise.all([who, pricing]) as [any, Record<string, unknown>];
    // A quote: the current price, nothing placed, no login needed.
    if (body.quote) return reply({ price: bet.price, version: MODEL.version });
    if (!user || user.is_anonymous) return reply({ error: 'Log in to bet' }, 401);

    if (bet.price !== shown) return reply({ changed: true, price: bet.price });

    const { data, error } = await db.rpc('place_bet_internal', {
      p_user: user.id, p_tournament: bet.tournament_id, p_match: bet.match_id ?? null,
      p_side: bet.side ?? null, p_player: bet.player_id ?? null,
      p_selection: bet.selection, p_market: bet.market, p_price: bet.price,
      p_decimal: decimalOf(bet.price as string), p_stake: stake, p_version: MODEL.version,
    });
    if (error) return reply({ error: error.message }, 400);
    return reply({ placed: true, price: bet.price, ...data });
  } catch (e) {
    return reply({ error: (e as Error).message }, 400);
  }
});

async function priceMatch(db: any, matchId: string, side: number) {
  if (side !== 1 && side !== 2) throw new Error('Pick a side');
  // Everything at once: the match, whether it's open, the order of merit and
  // both kinds of preview (only the one that fits is used).
  const [mr, block, oom, pr, nr] = await Promise.all([
    db.from('matches').select(MATCH_SELECT).eq('id', matchId).single(),
    db.rpc('match_bet_block', { p_match: matchId }),
    db.rpc('oom_table'),
    db.rpc('match_preview', { p_match: matchId }),
    db.rpc('names_preview', { p_match: matchId }),
  ]);
  const m = mr.data;
  if (mr.error || !m) throw new Error('Match not found');
  if (block.data) throw new Error(block.data);

  const name1 = m.p1?.name ?? m.p1_name, name2 = m.p2?.name ?? m.p2_name;
  const linked = m.player1_id && m.player2_id;
  const preview = linked && !pr.error ? pr.data : null;
  const names = !linked && !nr.error ? nr.data : null;
  const pv = previewFor(m, { preview, names, oomRows: oom.data ?? [], name1, name2 });
  if (!pv) throw new Error('Odds not available for this fixture');
  const prices = matchPrices(pv, m);
  return {
    tournament_id: m.tournament_id, match_id: m.id, side,
    selection: side === 1 ? name1 : name2,
    market: `${name1} v ${name2}`,
    price: prices[side - 1],
  };
}

async function priceOutright(db: any, tournamentId: string, playerId: string) {
  const [block, t, e, m, fig, oom] = await Promise.all([
    db.rpc('outright_bet_block', { p_tournament: tournamentId }),
    db.from('tournaments').select('*').eq('id', tournamentId).single(),
    db.from('tournament_players').select('*, players(id,name)').eq('tournament_id', tournamentId),
    db.from('matches').select(MATCH_SELECT).eq('tournament_id', tournamentId).order('stage').order('round').order('slot'),
    db.rpc('tournament_odds_data', { p_tournament: tournamentId }),
    db.rpc('oom_table'),
  ]);
  if (block.data) throw new Error(block.data);
  if (t.error || e.error || m.error || fig.error) throw new Error('Tournament not found');
  const entrants = e.data ?? [];
  const odds = outrightOdds({
    figures: fig.data ?? [],
    oom: new Map(entrants.map((x: any) => [x.player_id, oomScore(oom.data ?? [], x.players?.name)])),
    t: t.data, entrants, matches: (m.data ?? []).map((x: any) => ({ ...x })),
  });
  const row = odds.find((x: any) => x.id === playerId);
  if (!row) throw new Error('No price for that player');
  return {
    tournament_id: tournamentId, player_id: playerId,
    selection: row.name ?? entrants.find((x: any) => x.player_id === playerId)?.players?.name ?? 'Player',
    market: `${t.data.name}: winner`,
    price: outrightPrice(row.p),
  };
}

async function fillPrematch(db: any) {
  const { data, error } = await db.rpc('prematch_missing', { p_limit: 500 });
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map((s: any) => ({
    match_id: s.match_id, p1_win: matchChance(s.features, s.features), model_version: MODEL.version,
  }));
  if (rows.length) {
    const { error: e } = await db.from('match_odds').upsert(rows, { onConflict: 'match_id', ignoreDuplicates: true });
    if (e) throw new Error(e.message);
  }
  return { filled: rows.length };
}


// ---------------------------------------------------------------- match markets and accas
//
// body: { kind: 'sels', sels: [{ match_id, market, pick }], prices: [what the
// page showed, in the same order], stake, quote? }. One selection is a bet on
// a match market; two or more are an acca (one pick per match, no futures).
// Every price is worked out again here; if any has moved, nothing is placed.

async function placeSelections(db: any, req: Request, body: Record<string, unknown>, stake: number) {
  const raw = Array.isArray(body.sels) ? body.sels as Record<string, unknown>[] : [];
  if (!raw.length) throw new Error('Nothing to bet on');
  if (raw.length > 50) throw new Error('Too many picks');
  const ids = raw.map(s => String(s.match_id));
  if (new Set(ids).size !== ids.length) throw new Error('An acca can only have one pick from each match');

  const auth = req.headers.get('Authorization') ?? '';
  const who = body.quote ? Promise.resolve(null)
    : createClient(URL_, ANON, { global: { headers: { Authorization: auth } } }).auth.getUser().then(r => r.data.user, () => null);
  const [user, oom] = await Promise.all([who, db.rpc('oom_table')]);
  const priced = await Promise.all(raw.map(s => priceSelection(db, oom.data ?? [], String(s.match_id), String(s.market), String(s.pick))));
  const prices = priced.map(p => p.price);
  if (body.quote) return { prices, version: MODEL.version, markets_version: MK.version };
  if (!user || user.is_anonymous) throw new Error('Log in to bet');
  const shown = Array.isArray(body.prices) ? body.prices.map(String) : [];
  if (prices.some((p, i) => p !== shown[i])) return { changed: true, prices };

  const { data, error } = await db.rpc('place_selections_internal', {
    p_user: user.id, p_stake: stake, p_sels: priced, p_version: MODEL.version * 100 + MK.version,
  });
  if (error) throw new Error(error.message);
  return { placed: true, prices, ...data };
}

async function priceSelection(db: any, oomRows: unknown[], matchId: string, market: string, pick: string) {
  const [mr, block, pr, nr, fr] = await Promise.all([
    db.from('matches').select(MATCH_SELECT).eq('id', matchId).single(),
    db.rpc('match_bet_block', { p_match: matchId }),
    db.rpc('match_preview', { p_match: matchId }),
    market === 'win' ? db.rpc('names_preview', { p_match: matchId }) : Promise.resolve({ data: null }),
    market === 'win' ? Promise.resolve({ data: null }) : db.rpc('market_figures', { p_match: matchId }),
  ]);
  const m = mr.data;
  if (mr.error || !m) throw new Error('Match not found');
  const name1 = m.p1?.name ?? m.p1_name, name2 = m.p2?.name ?? m.p2_name;
  if (block.data) throw new Error(`${name1} v ${name2}: ${block.data}`);
  const linked = m.player1_id && m.player2_id;
  const preview = linked && !pr.error ? pr.data : null;
  const names = !linked && !nr.error ? nr.data : null;
  const pv = previewFor(m, { preview, names, oomRows, name1, name2 });
  if (!pv) throw new Error(`No odds for ${name1} v ${name2}`);
  const title = `${name1} v ${name2}`;
  if (market === 'win') {
    if (pick !== '1' && pick !== '2') throw new Error('Pick a side');
    const price = matchPrices(pv, m)[Number(pick) - 1];
    return { match_id: matchId, market, pick, line: null, fav: null, title, label: pick === '1' ? name1 : name2, price, decimal: decimalOf(price) };
  }
  const mk = matchMarkets(pv, m, fr.data ?? {}, [name1, name2]).find((x: any) => x.key === market);
  const o = mk?.outcomes.find((x: any) => x.pick === pick);
  if (!mk || !o) throw new Error(`That market isn't available for ${title}`);
  return {
    match_id: matchId, market, pick, line: mk.line ?? null, fav: mk.fav ?? null,
    title: `${title}: ${mk.title}`, label: pickLabel(mk, o),
    price: o.price, decimal: o.decimal,
  };
}
