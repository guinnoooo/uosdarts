-- Matchup markets: one market holding several head-to-head pairings, e.g.
-- "Who will go further in the Ham Cup?" with Name A v Name B on each row.
-- Each side is an ordinary selection, so pricing, betting, cash out and
-- settling work as for any future; pair_no ties the two sides of a pairing
-- together for display. A bet's selection reads "A (v B)" so it makes sense
-- on its own. If both go out in the same round, settle both sides void.

alter table futures_selections add column if not exists pair_no integer;
alter table futures_markets drop constraint if exists futures_markets_kind_check;
alter table futures_markets add constraint futures_markets_kind_check check (kind in ('player', 'special', 'matchup'));
-- A typed option's name is unique in its market, except that in a matchup
-- market the same person can be in more than one pairing.
drop index if exists futures_selections_special_name;
create unique index futures_selections_special_name on futures_selections (market_id, coalesce(pair_no, 0), lower(name)) where player_id is null;

-- Add one pairing. Names are typed. Sides aren't linked to players: the
-- same player can be in several pairings, and a market only allows each
-- player once.
create or replace function public.super_matchup_add(p_market bigint, p_a text, p_a_price text, p_b text, p_b_price text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer; pa text; pb text;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if not exists (select 1 from futures_markets where id = p_market and kind = 'matchup') then
    raise exception 'That market isn''t a matchup market';
  end if;
  if nullif(btrim(p_a), '') is null or nullif(btrim(p_b), '') is null then raise exception 'Type both names'; end if;
  if lower(btrim(p_a)) = lower(btrim(p_b)) then raise exception 'Pick two different people'; end if;
  pa := nullif(regexp_replace(coalesce(p_a_price, ''), '\s+', '', 'g'), '');
  pb := nullif(regexp_replace(coalesce(p_b_price, ''), '\s+', '', 'g'), '');
  if pa ~* '^evens$' then pa := 'Evens'; end if;
  if pb ~* '^evens$' then pb := 'Evens'; end if;
  if (pa is not null and (frac_decimal(pa) is null or frac_decimal(pa) <= 1))
     or (pb is not null and (frac_decimal(pb) is null or frac_decimal(pb) <= 1)) then
    raise exception 'Use prices like 5/6, 11/10 or Evens';
  end if;
  if exists (select 1 from futures_selections s1 join futures_selections s2 using (market_id, pair_no)
              where s1.market_id = p_market and s1.id != s2.id
                and lower(s1.name) = lower(btrim(p_a)) and lower(s2.name) = lower(btrim(p_b))) then
    raise exception 'That pairing is already there';
  end if;
  n := coalesce((select max(pair_no) from futures_selections where market_id = p_market), 0) + 1;
  insert into futures_selections (market_id, player_id, name, price, base_price, cash_price, pair_no)
  values (p_market, null, btrim(p_a), pa, pa, pa, n),
         (p_market, null, btrim(p_b), pb, pb, pb, n);
  return n;
end $function$;

-- Remove a pairing nobody has bet on.
create or replace function public.super_matchup_remove(p_market bigint, p_pair integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if exists (select 1 from bets b join futures_selections s on s.id = b.future_id
              where s.market_id = p_market and s.pair_no = p_pair) then
    raise exception 'People have bet on this pairing. Settle or void it instead.';
  end if;
  delete from futures_selections where market_id = p_market and pair_no = p_pair;
end $function$;

revoke all on function public.super_matchup_add(bigint, text, text, text, text) from public, anon;
revoke all on function public.super_matchup_remove(bigint, integer) from public, anon;
grant execute on function public.super_matchup_add(bigint, text, text, text, text) to authenticated;
grant execute on function public.super_matchup_remove(bigint, integer) to authenticated;

-- New markets can be matchups too.
create or replace function public.super_future_create(p_title text, p_category bigint, p_kind text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare mid bigint;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if nullif(btrim(p_title), '') is null then raise exception 'Give the market a title'; end if;
  if p_kind not in ('player', 'special', 'matchup') then raise exception 'Pick players, typed options or matchups'; end if;
  if not exists (select 1 from futures_categories where id = p_category) then raise exception 'Pick a category'; end if;
  insert into futures_markets (slug, title, kind, status, sort, category_id)
  values (p_kind || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10), btrim(p_title), p_kind, 'draft',
          coalesce((select max(sort) from futures_markets where category_id = p_category), 0) + 1, p_category)
  returning id into mid;
  return mid;
end $function$;

-- The bet's selection says who they're up against, e.g. "Dan Wells (v Matt Watts)".
create or replace function public.place_future_bet(p_selection bigint, p_price text, p_stake integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  a accounts;
  s futures_selections;
  m futures_markets;
  why text;
  bid bigint;
  label text;
begin
  if uid is null then raise exception 'Log in to bet'; end if;
  perform apply_topups(uid);
  select * into a from accounts where user_id = uid for update;
  if not found then raise exception 'Confirm your email to start betting'; end if;
  if a.banned then raise exception 'Your account can''t place bets'; end if;
  if not a.can_bet then raise exception 'Admin logins can''t bet. Sign up with your email to bet.'; end if;
  if p_stake is null or p_stake < 10 then raise exception 'The smallest bet is 10 tokens'; end if;
  if p_stake > a.tokens then raise exception 'You only have % tokens', a.tokens; end if;

  select * into s from futures_selections where id = p_selection for share;
  why := future_bet_block(p_selection);
  if why is not null then raise exception '%', why; end if;
  select * into m from futures_markets where id = s.market_id;
  if p_price is distinct from s.price then
    return jsonb_build_object('changed', true, 'price', s.price);
  end if;
  if frac_decimal(s.price) is null or frac_decimal(s.price) <= 1 then raise exception 'No price for that'; end if;

  label := s.name;
  if s.pair_no is not null then
    label := s.name || coalesce(' (v ' || (select o.name from futures_selections o
                                            where o.market_id = s.market_id and o.pair_no = s.pair_no and o.id != s.id limit 1) || ')', '');
  end if;

  update accounts set tokens = tokens - p_stake where user_id = uid;
  insert into bets (user_id, tournament_id, future_id, player_id, selection, market, price, decimal_odds, stake)
  values (uid, null, s.id, s.player_id, label, m.title, s.price, frac_decimal(s.price), p_stake)
  returning id into bid;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake);
end $function$;

-- Pairings come out together, in the order they were added.
create or replace function public.futures_board()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at,
           'category', coalesce(c.name, case when m.kind = 'special' then 'Specials' else 'Futures' end),
           'open', m.status = 'open' and (m.closes_at is null or m.closes_at > now()),
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'player_id', s.player_id, 'name', s.name,
                                                 'price', s.price, 'result', s.result, 'pair', s.pair_no,
                                                 'was', case when s.price_moved_at > now() - interval '7 days' then s.prev_price end)
                              order by s.pair_no nulls last, case when s.pair_no is not null then s.id end,
                                       s.result = 'won' desc nulls last, frac_decimal(s.price) nulls last, s.name)
               from futures_selections s
              where s.market_id = m.id and (s.price is not null or s.result is not null)), '[]'::jsonb))
         order by c.sort nulls last, c.id, m.sort, m.id), '[]'::jsonb)
    from futures_markets m
    left join futures_categories c on c.id = m.category_id
   where m.status != 'draft';
$function$;

create or replace function public.super_futures()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at, 'category_id', m.category_id,
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', s.id, 'player_id', s.player_id, 'name', s.name, 'suggested', s.suggested, 'pair', s.pair_no,
                      'price', s.price, 'base_price', s.base_price, 'result', s.result,
                      'proposed', s.proposed, 'proposed_reason', s.proposed_reason,
                      'bets', coalesce(b.n, 0), 'staked', coalesce(b.staked, 0), 'liability', coalesce(b.liability, 0))
                    order by s.pair_no nulls last, case when s.pair_no is not null then s.id end,
                             frac_decimal(coalesce(s.price, s.suggested)) nulls last, s.name)
               from futures_selections s
               left join lateral (select count(*) as n, sum(stake) as staked,
                                         sum(floor(stake * decimal_odds)) filter (where status = 'open') as liability
                                    from bets where future_id = s.id and status != 'cancelled') b on true
              where s.market_id = m.id), '[]'::jsonb))
         order by c.sort nulls last, c.id, m.sort, m.id)
    from futures_markets m left join futures_categories c on c.id = m.category_id), '[]'::jsonb);
end $function$;


-- Price suggestions are for outright-style markets. A matchup market holds
-- separate two-way books, so leave it out.
do $$ declare d text; begin
  select pg_get_functiondef('public.futures_propose'::regproc) into d;
  if position('m.kind != ''matchup''' in d) = 0 then
    d := replace(d, 'join futures_markets m on m.id = s.market_id and m.status = ''open''',
                    'join futures_markets m on m.id = s.market_id and m.status = ''open'' and m.kind != ''matchup''');
    execute d;
  end if;
end $$;
