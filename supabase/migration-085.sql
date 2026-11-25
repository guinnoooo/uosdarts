-- 1. Accas are priced in fractional odds, rounded down (never up) to a
--    price that reads cleanly: X/1, X/2, X/3 or X/5 under 5/1, X/1 or X/2
--    up to 10/1, whole numbers above that (1/1 shows as Evens). Under 1/5 it's 1/X. The same rounding is in static/js/betting.js.
-- 2. Settling a match locks the bets and accounts it touches in a fixed
--    order first, so two matches finishing at the same moment with the same
--    bettors (an acca across both, say) can't deadlock each other.

create or replace function nice_fraction(d numeric, out num bigint, out den int)
language plpgsql immutable as $$
declare f numeric := d - 1; b int; a bigint; best numeric := -1;
begin
  num := 0; den := 1;
  -- Long prices read as whole numbers: halves allowed up to 10/1, thirds and fifths only under 5/1.
  foreach b in array array[1, 2, 3, 5] loop
    continue when (f >= 10 and b > 1) or (f >= 5 and b > 2);
    a := floor(f * b + 0.0000001);
    if a::numeric / b > best + 0.000000001 then best := a::numeric / b; num := a; den := b; end if;
  end loop;
  if num = 0 and f > 0 then num := 1; den := ceil(1 / f - 0.0000001)::int; end if;
end $$;

create or replace function nice_price(d numeric) returns text language sql immutable as $$
  select case when num = den then 'Evens' else num || '/' || den end from nice_fraction(d);
$$;
create or replace function nice_decimal(d numeric) returns numeric language sql immutable as $$
  select round(1 + num::numeric / den, 4) from nice_fraction(d);
$$;

create or replace function place_selections_internal(p_user uuid, p_stake int, p_sels jsonb, p_version int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a accounts;
  n int;
  why text;
  s jsonb;
  prod numeric := 1;
  dec numeric;
  bid bigint;
  k text;
begin
  perform apply_topups(p_user);
  select * into a from accounts where user_id = p_user for update;
  if not found then raise exception 'Confirm your email to start betting'; end if;
  if a.banned then raise exception 'Your account can''t place bets'; end if;
  if not a.can_bet then raise exception 'Admin logins can''t bet. Sign up with your email to bet.'; end if;
  if p_stake is null or p_stake < 10 then raise exception 'The smallest bet is 10 tokens'; end if;
  if p_stake > a.tokens then raise exception 'You only have % tokens', a.tokens; end if;
  n := jsonb_array_length(coalesce(p_sels, '[]'::jsonb));
  if n < 1 then raise exception 'Nothing to bet on'; end if;
  if (select count(distinct x->>'match_id') from jsonb_array_elements(p_sels) x) <> n then
    raise exception 'An acca can only have one pick from each match';
  end if;
  for s in select * from jsonb_array_elements(p_sels) loop
    why := match_bet_block((s->>'match_id')::uuid);
    if why is not null then raise exception '%: %', s->>'title', why; end if;
    if exists (select 1 from matches where id = (s->>'match_id')::uuid and p_user in (scorer_id, scorer2_id)) then
      raise exception 'You can''t bet on a match you''re scoring';
    end if;
    if (s->>'decimal')::numeric <= 1 then raise exception 'No price for %', s->>'label'; end if;
    prod := prod * (s->>'decimal')::numeric;
  end loop;
  prod := round(prod, 4);
  k := case when n = 1 then 'market' else 'acca' end;
  dec := case when n = 1 then prod else nice_decimal(prod) end;

  update accounts set tokens = tokens - p_stake where user_id = p_user;
  insert into bets (user_id, kind, selection, market, price, decimal_odds, stake, model_version)
  values (p_user, k,
          case when n = 1 then p_sels->0->>'label' else (select string_agg(x->>'label', ' + ') from jsonb_array_elements(p_sels) x) end,
          case when n = 1 then p_sels->0->>'title' else n || '-fold acca' end,
          case when n = 1 then p_sels->0->>'price' else nice_price(prod) end,
          dec, p_stake, p_version)
  returning id into bid;
  insert into bet_selections (bet_id, match_id, market, pick, line, fav, title, label, price, decimal_odds)
  select bid, (x->>'match_id')::uuid, x->>'market', x->>'pick', (x->>'line')::numeric, (x->>'fav')::smallint,
         x->>'title', x->>'label', x->>'price', (x->>'decimal')::numeric
    from jsonb_array_elements(p_sels) x;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake, 'decimal', dec,
                            'price', case when n = 1 then p_sels->0->>'price' else nice_price(prod) end);
end $$;
revoke all on function place_selections_internal(uuid, int, jsonb, int) from public, anon, authenticated;

-- An acca pays at the price it was struck at. If a pick is void, it pays
-- at the remaining picks' odds, rounded down the same way.
create or replace function settle_bet_from_selections(p_bet bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  b bets;
  n_lost int; n_open int; n_won int; n_void int; prod numeric;
  new_status text; new_payout bigint; old_credit bigint; new_credit bigint;
begin
  select * into b from bets where id = p_bet for update;
  if not found or b.kind not in ('market', 'acca') or b.status in ('cancelled', 'cashed_out') then return; end if;
  select count(*) filter (where status = 'lost'), count(*) filter (where status = 'open'), count(*) filter (where status = 'won'),
         count(*) filter (where status = 'void'),
         round(coalesce(exp(sum(ln(decimal_odds)) filter (where status = 'won')), 1), 4)
    into n_lost, n_open, n_won, n_void, prod
    from bet_selections where bet_id = p_bet;
  if n_lost > 0 then new_status := 'lost'; new_payout := 0;
  elsif n_open > 0 then new_status := 'open'; new_payout := 0;
  elsif n_won = 0 then new_status := 'void'; new_payout := 0;
  elsif n_void = 0 then new_status := 'won'; new_payout := floor(b.stake * b.decimal_odds)::bigint;
  elsif b.kind = 'acca' and n_won > 1 then new_status := 'won'; new_payout := floor(b.stake * nice_decimal(prod))::bigint;
  else new_status := 'won'; new_payout := floor(b.stake * prod)::bigint;   -- one pick left: its own price
  end if;
  old_credit := case b.status when 'won' then b.payout when 'void' then b.stake else 0 end;
  new_credit := case new_status when 'won' then new_payout when 'void' then b.stake else 0 end;
  if new_status is distinct from b.status or new_payout is distinct from b.payout then
    update bets set status = new_status, payout = new_payout,
                    settled_at = case when new_status = 'open' then null else now() end
     where id = p_bet;
  end if;
  if new_credit <> old_credit then
    update accounts set tokens = tokens + (new_credit - old_credit) where user_id = b.user_id;
  end if;
end $$;

-- Every bet a match settles, then every account it pays, each in id order.
create or replace function lock_match_bets(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from bets where match_id = p_match)
     and not exists (select 1 from bet_selections where match_id = p_match) then return; end if;
  perform 1 from bets
   where id in (select id from bets where match_id = p_match union select bet_id from bet_selections where match_id = p_match)
   order by id for update;
  perform 1 from accounts
   where user_id in (select user_id from bets where match_id = p_match
                     union select b.user_id from bets b join bet_selections s on s.bet_id = b.id where s.match_id = p_match)
   order by user_id for update;
end $$;
revoke all on function lock_match_bets(uuid) from public, anon, authenticated;

create or replace function public.bets_follow_match()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if tg_op = 'DELETE' then
    perform lock_match_bets(old.id);
    perform void_open_bets(old.tournament_id, old.id);
    perform void_match_selections(old.id);
    return old;
  end if;
  if new.status = 'pending' and (
       (old.player1_id is not null and old.player1_id is distinct from new.player1_id)
    or (old.player2_id is not null and old.player2_id is distinct from new.player2_id)
    or (old.p1_name is not null and old.p1_name is distinct from new.p1_name)
    or (old.p2_name is not null and old.p2_name is distinct from new.p2_name)) then
    perform lock_match_bets(new.id);
    perform void_open_bets(new.tournament_id, new.id);
    perform void_match_selections(new.id);
  end if;
  -- Only when the result itself changes: not on every visit of a finished match's row.
  if (old.status = 'complete' or new.status = 'complete')
     and (old.status is distinct from new.status or old.winner_id is distinct from new.winner_id
          or old.p1_legs is distinct from new.p1_legs or old.p2_legs is distinct from new.p2_legs
          or old.p1_sets is distinct from new.p1_sets or old.p2_sets is distinct from new.p2_sets) then
    perform lock_match_bets(new.id);
    perform resettle_match(new.id);
    perform settle_match_selections(new.id);
  end if;
  return new;
end $function$;
