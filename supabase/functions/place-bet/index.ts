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
import { MODEL, oomScore } from './winprob.js';
import { previewFor, matchPrices, decimalOf } from './prices.js';
import { outrightOdds, outrightPrice } from './outright.js';

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
    let bet: Record<string, unknown>;
    if (body.kind === 'match') {
      bet = await priceMatch(db, String(body.match_id), Number(body.side));
    } else if (body.kind === 'outright') {
      bet = await priceOutright(db, String(body.tournament_id), String(body.player_id));
    } else {
      return reply({ error: 'Bad request' }, 400);
    }
    // A quote: the current price, nothing placed, no login needed.
    if (body.quote) return reply({ price: bet.price, version: MODEL.version });

    const auth = req.headers.get('Authorization') ?? '';
    const asUser = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await asUser.auth.getUser();
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
  const { data: m, error } = await db.from('matches').select(MATCH_SELECT).eq('id', matchId).single();
  if (error || !m) throw new Error('Match not found');
  const { data: why } = await db.rpc('match_bet_block', { p_match: matchId });
  if (why) throw new Error(why);

  const name1 = m.p1?.name ?? m.p1_name, name2 = m.p2?.name ?? m.p2_name;
  const oom = await db.rpc('oom_table');
  let preview = null, names = null;
  if (m.player1_id && m.player2_id) {
    const r = await db.rpc('match_preview', { p_match: matchId });
    preview = r.error ? null : r.data;
  } else {
    const r = await db.rpc('names_preview', { p_match: matchId });
    names = r.error ? null : r.data;
  }
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
  const { data: why } = await db.rpc('outright_bet_block', { p_tournament: tournamentId });
  if (why) throw new Error(why);
  const [t, e, m, fig, oom] = await Promise.all([
    db.from('tournaments').select('*').eq('id', tournamentId).single(),
    db.from('tournament_players').select('*, players(id,name)').eq('tournament_id', tournamentId),
    db.from('matches').select(MATCH_SELECT).eq('tournament_id', tournamentId).order('stage').order('round').order('slot'),
    db.rpc('tournament_odds_data', { p_tournament: tournamentId }),
    db.rpc('oom_table'),
  ]);
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
