-- Migration 081: replaces part of 080.
-- 1. No limit on futures bets: the 25,000 return cap is gone.
-- 2. Cash outs follow form plus the crowd. Lots of different people backing
--    the same long shot moves its price and its cash out a little. One
--    person's big bet can't: their money counts for at most 1,000 tokens of
--    "crowd", and the crowd counts fully only from five backers. The extra
--    shortening that protects the book when a selection would cost more than
--    the market has taken still moves the price, less for one backer, and
--    never the cash out.

drop function if exists public.future_max_return();

create or replace function public.futures_propose(p_probs jsonb default '{}'::jsonb, p_market bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  lo constant numeric := 0.002; hi constant numeric := 0.995;
  damp constant numeric := 0.5;
  pcur numeric; pform numeric; pm numeric; p0 numeric; pb numeric; pnew numeric;
  z numeric; shift numeric; w numeric; fresh text; why text[];
  crowd_shift numeric; guard numeric; pw numeric; pcash numeric;
  out jsonb := '[]'::jsonb;
begin
  -- Store any new model chances first.
  update futures_selections s
     set model_p = (x.value)::numeric,
         base_model = coalesce(s.base_model, case when s.base_price is not null then (x.value)::numeric end)
    from jsonb_each(coalesce(p_probs, '{}'::jsonb)) mk
    join futures_markets m on m.slug = mk.key
    cross join lateral jsonb_each(mk.value) x
   where s.market_id = m.id and s.player_id = x.key::uuid;

  for r in
    with book as (
      select s.market_id, sum(1 / frac_decimal(s.price)) as overround
        from futures_selections s where s.price is not null and s.result is null group by s.market_id),
    per_user as (
      select fs.market_id, b.future_id, b.user_id,
             sum(b.stake) as staked, sum(floor(b.stake * b.decimal_odds)) as liability
        from bets b join futures_selections fs on fs.id = b.future_id
       where b.status = 'open' group by fs.market_id, b.future_id, b.user_id),
    money as (
      -- One person's money counts for at most 1,000 tokens of "crowd", so a
      -- single big bet can't drag a price in on its own.
      select market_id, future_id, sum(staked) as staked, sum(liability) as liability,
             sum(least(staked, 1000)) as crowd, count(*) as backers
        from per_user group by market_id, future_id),
    market_money as (select market_id, sum(staked) as total, sum(crowd) as crowd_total from money group by market_id)
    select s.*, m.slug, k.overround, coalesce(mo.staked, 0) as staked, coalesce(mo.liability, 0) as liability,
           coalesce(mo.crowd, 0) as crowd, coalesce(mo.backers, 0) as backers,
           coalesce(mm.total, 0) as total, coalesce(mm.crowd_total, 0) as crowd_total
      from futures_selections s
      join futures_markets m on m.id = s.market_id and m.status = 'open'
      join book k on k.market_id = s.market_id
      left join money mo on mo.future_id = s.id
      left join market_money mm on mm.market_id = s.market_id
     where s.price is not null and s.result is null and (p_market is null or s.market_id = p_market)
  loop
    why := '{}';
    pcur := least(hi, greatest(lo, 1 / frac_decimal(r.price)));
    pform := pcur;

    -- Form: the same damped move from the last approved price as before.
    if r.model_p is not null and r.base_model is not null and r.base_price is not null then
      pb := least(hi, greatest(lo, 1 / frac_decimal(r.base_price)));
      pm := least(hi, greatest(lo, r.model_p));
      p0 := least(hi, greatest(lo, r.base_model));
      pform := 1 / (1 + exp(-(ln(pb / (1 - pb)) + damp * (ln(pm / (1 - pm)) - ln(p0 / (1 - p0))))));
      if ladder_price(pform) <> ladder_price(pcur) then
        why := why || format('model %s%% (was %s%%)', round(r.model_p * 100, 1), round(r.base_model * 100, 1));
      end if;
    end if;

    -- Money, in two parts.
    --   crowd: lots of different people backing the same player. Counts
    --          fully from five backers, not at all with one. This moves the
    --          price and the cash out.
    --   guard: protection when one selection would cost more than the
    --          market has taken. Moves the price only, never the cash out,
    --          and less when it's one person.
    -- Light backing lets an odds-against price drift a little.
    crowd_shift := 0; guard := 0; shift := 0;
    if r.total >= 500 then
      w := least(1, r.total / 5000.0);
      pw := least(1, greatest(0, r.backers - 1) / 4.0);
      z := ln((r.crowd / nullif(r.crowd_total, 0) + 0.01) / (pcur / r.overround + 0.01));
      if z > 0 then
        crowd_shift := least(0.35, 0.25 * w * z) * pw;
      elsif pcur <= 0.5 then
        shift := greatest(-0.15, 0.25 * w * z);
      end if;
      if crowd_shift >= 0.05 then
        why := why || format('%s people have backed them', r.backers);
      elsif shift <= -0.05 then
        why := why || format('little money on them (%s%% of the stake)', round(100 * r.staked / r.total));
      end if;
      if r.liability > r.total then
        guard := least(0.4, 0.15 * w * ln(r.liability / r.total)) * (0.5 + 0.5 * pw);
        if guard >= 0.05 then
          why := why || format('would pay out %s if they win, against %s taken on the market', r.liability, r.total);
        end if;
      end if;
    end if;

    pnew := 1 / (1 + exp(-(ln(pform / (1 - pform)) + shift + crowd_shift + guard)));
    -- What a cash out follows: form plus the crowd, never the guard.
    pcash := 1 / (1 + exp(-(ln(pform / (1 - pform)) + least(0, shift) + crowd_shift)));
    pnew := least(hi, greatest(lo, pnew));
    fresh := ladder_price(pnew);
    -- Prices shorter than the ladder goes (1/20, 1/100) are left alone unless
    -- the suggestion is longer than the ladder's shortest rung.
    if pcur > 1 / frac_decimal('1/10') and pnew >= 1 / frac_decimal('1/10') then fresh := r.price; end if;

    if fresh = r.price or fresh = r.rejected or array_length(why, 1) is null then
      update futures_selections set proposed = null, proposed_reason = null, proposed_at = null, proposed_form = null
       where id = r.id and proposed is not null;
    elsif fresh is distinct from r.proposed then
      -- Cash outs follow form plus the crowd only.
      update futures_selections set proposed = fresh, proposed_reason = array_to_string(why, '; '), proposed_at = now(),
             proposed_form = case when ladder_price_out(pcash) = ladder_price_out(pcur) then coalesce(r.cash_price, r.price) else ladder_price_out(pcash) end
       where id = r.id;
      out := out || jsonb_build_object('market', r.slug, 'name', r.name, 'from', r.price, 'to', fresh,
                                       'why', array_to_string(why, '; '));
    end if;
  end loop;
  return out;
end $$;
revoke all on function public.futures_propose(jsonb, bigint) from public, anon, authenticated;

create or replace function public.place_future_bet(p_selection bigint, p_price text, p_stake integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  a accounts;
  s futures_selections;
  m futures_markets;
  why text;
  bid bigint;
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

  update accounts set tokens = tokens - p_stake where user_id = uid;
  insert into bets (user_id, tournament_id, future_id, player_id, selection, market, price, decimal_odds, stake)
  values (uid, null, s.id, s.player_id, s.name, m.title, s.price, frac_decimal(s.price), p_stake)
  returning id into bid;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake);
end $$;

-- For cash outs, round to the nearest rung at or LONGER than the fair price,
-- so the ladder's big gaps (500/1 to 250/1) never hand out a jump.
create or replace function public.ladder_price_out(p numeric)
returns text language sql immutable as $$
  select coalesce((select f from unnest(price_ladder()) f
                    where 1 / frac_decimal(f) <= p + 0.000001 order by frac_decimal(f) asc limit 1), '500/1');
$$;
-- (futures_propose above was then patched in place to use ladder_price_out
-- for the cash-out price: proposed_form = ladder_price_out(pcash).)
