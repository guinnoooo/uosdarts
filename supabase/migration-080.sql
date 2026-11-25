-- Migration 080: stop backing a long shot, getting the price cut because of
-- that money, and cashing out at the shorter price.
--
-- 1. Cash outs use a "cash-out price" that only form can shorten. When a
--    suggestion is approved, the cash-out price becomes the form-only part
--    of it. Money-driven moves protect the book but never raise a cash out.
--    Setting a price by hand sets both.
-- 2. One futures bet can return at most 25,000 tokens (future_max_return).

alter table public.futures_selections add column if not exists cash_price text;
alter table public.futures_selections add column if not exists proposed_form text;

-- Today's approved moves were driven by money, so cash outs go back to the
-- price before them. Everything else cashes out at its current price.
update public.futures_selections
   set cash_price = case when price_moved_at is not null and prev_price is not null
                          and frac_decimal(prev_price) > frac_decimal(price) then prev_price else price end
 where price is not null;

create or replace function public.future_max_return()
returns bigint language sql immutable as $$ select 25000::bigint $$;

create or replace function public.future_cash_out_value(p_bet bigint)
returns bigint language sql stable security definer set search_path = public as $$
  select case
    when b.id is null or b.status <> 'open' or b.future_id is null then null
    when b.placed_at > now() - make_interval(hours => future_free_cancel_hours()) then null
    when future_bet_block(b.future_id) is not null then null
    else least(floor(b.stake * b.decimal_odds),
               floor(b.stake * b.decimal_odds
                     / greatest(frac_decimal(s.price), frac_decimal(coalesce(s.cash_price, s.price)))
                     * (1 - future_cash_out_fee())))::bigint
  end
  from (select 1) x
  left join bets b on b.id = p_bet
  left join futures_selections s on s.id = b.future_id;
$$;
create or replace function public.futures_propose(p_probs jsonb default '{}'::jsonb, p_market bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  lo constant numeric := 0.002; hi constant numeric := 0.995;
  damp constant numeric := 0.5;
  pcur numeric; pform numeric; pm numeric; p0 numeric; pb numeric; pnew numeric;
  z numeric; shift numeric; w numeric; fresh text; why text[];
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
    money as (
      select fs.market_id, b.future_id,
             sum(b.stake) as staked, sum(floor(b.stake * b.decimal_odds)) as liability
        from bets b join futures_selections fs on fs.id = b.future_id
       where b.status = 'open' group by fs.market_id, b.future_id),
    market_money as (select market_id, sum(staked) as total from money group by market_id)
    select s.*, m.slug, k.overround, coalesce(mo.staked, 0) as staked, coalesce(mo.liability, 0) as liability,
           coalesce(mm.total, 0) as total
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

    -- Money: share of the stake against share of the book.
    shift := 0;
    if r.total >= 500 then
      w := least(1, r.total / 5000.0);
      z := ln((r.staked / r.total + 0.01) / (pcur / r.overround + 0.01));
      -- Heavy backing shortens. Light backing only lets a price drift when it
      -- is odds-against, and only a little, so favourites never drift for
      -- want of money.
      shift := case when z > 0 then least(0.5, 0.25 * w * z)
                    when pcur <= 0.5 then greatest(-0.15, 0.25 * w * z) else 0 end;
      if shift >= 0.05 then
        why := why || format('%s%% of the market''s money is on them', round(100 * r.staked / r.total));
      elsif shift <= -0.05 then
        why := why || format('little money on them (%s%% of the stake)', round(100 * r.staked / r.total));
      end if;
      -- A selection that would cost more than the whole market has taken.
      if r.liability > r.total then
        shift := shift + least(0.4, 0.15 * w * ln(r.liability / r.total));
        why := why || format('would pay out %s if they win, against %s taken on the market', r.liability, r.total);
      end if;
    end if;

    pnew := 1 / (1 + exp(-(ln(pform / (1 - pform)) + shift)));
    pnew := least(hi, greatest(lo, pnew));
    fresh := ladder_price(pnew);
    -- Prices shorter than the ladder goes (1/20, 1/100) are left alone unless
    -- the suggestion is longer than the ladder's shortest rung.
    if pcur > 1 / frac_decimal('1/10') and pnew >= 1 / frac_decimal('1/10') then fresh := r.price; end if;

    if fresh = r.price or fresh = r.rejected or array_length(why, 1) is null then
      update futures_selections set proposed = null, proposed_reason = null, proposed_at = null, proposed_form = null
       where id = r.id and proposed is not null;
    elsif fresh is distinct from r.proposed then
      -- The form-only part, which is all a cash out is allowed to follow.
      update futures_selections set proposed = fresh, proposed_reason = array_to_string(why, '; '), proposed_at = now(),
             proposed_form = case when ladder_price(pform) = ladder_price(pcur) then coalesce(r.cash_price, r.price) else ladder_price(pform) end
       where id = r.id;
      out := out || jsonb_build_object('market', r.slug, 'name', r.name, 'from', r.price, 'to', fresh,
                                       'why', array_to_string(why, '; '));
    end if;
  end loop;
  return out;
end $$;

create or replace function public.super_future_approve(p_selection bigint)
returns text language plpgsql security definer set search_path = public as $$
declare s futures_selections;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  select * into s from futures_selections where id = p_selection for update;
  if s.proposed is null then raise exception 'Nothing to approve'; end if;
  update futures_selections
     set price = s.proposed, base_price = s.proposed, base_model = coalesce(s.model_p, s.base_model),
         cash_price = coalesce(s.proposed_form, s.price),
         proposed = null, proposed_reason = null, proposed_at = null, proposed_form = null, rejected = null
   where id = p_selection;
  return s.proposed;
end $$;

create or replace function public.super_future_approve_all(p_market bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  update futures_selections
     set cash_price = coalesce(proposed_form, price),
         price = proposed, base_price = proposed, base_model = coalesce(model_p, base_model),
         proposed = null, proposed_reason = null, proposed_at = null, proposed_form = null, rejected = null
   where market_id = p_market and proposed is not null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.super_future_prices(p_market bigint, p_prices jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare k text; v text; n integer := 0;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p_prices) loop
    v := nullif(btrim(v), '');
    if v is not null then
      if v ~* '^evens$' then v := 'Evens'; end if;
      v := regexp_replace(v, '\s+', '', 'g');
      if frac_decimal(v) is null or frac_decimal(v) <= 1 then raise exception 'Can''t read % as a price. Use 5/2, 1/3 or Evens.', v; end if;
    end if;
    update futures_selections set price = v, base_price = v, base_model = model_p, cash_price = v,
                                  proposed = null, proposed_reason = null, proposed_at = null, proposed_form = null, rejected = null
     where id = k::bigint and market_id = p_market and price is distinct from v;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Specials get a cash-out price too.
create or replace function public.super_special_add(p_market bigint, p_name text, p_price text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare sid bigint; v text := nullif(regexp_replace(coalesce(p_price, ''), '\s+', '', 'g'), '');
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if not exists (select 1 from futures_markets where id = p_market and kind = 'special') then
    raise exception 'That market isn''t a special';
  end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Type the option first'; end if;
  if v ~* '^evens$' then v := 'Evens'; end if;
  if v is not null and (frac_decimal(v) is null or frac_decimal(v) <= 1) then
    raise exception 'Can''t read % as a price. Use 5/2, 1/3 or Evens.', v;
  end if;
  if exists (select 1 from futures_selections where market_id = p_market and lower(name) = lower(btrim(p_name))) then
    raise exception 'That option is already there';
  end if;
  insert into futures_selections (market_id, player_id, name, price, base_price, cash_price)
  values (p_market, null, btrim(p_name), v, v, v)
  returning id into sid;
  return sid;
end $$;

-- One futures bet can return at most future_max_return() tokens.
create or replace function public.place_future_bet(p_selection bigint, p_price text, p_stake integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  a accounts;
  s futures_selections;
  m futures_markets;
  why text;
  bid bigint;
  most integer;
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
  if floor(p_stake * frac_decimal(s.price)) > future_max_return() then
    most := floor(future_max_return() / frac_decimal(s.price));
    raise exception 'The most one futures bet can win is % tokens, so the biggest stake at % is %',
      to_char(future_max_return(), 'FM999,999'), s.price, most;
  end if;

  update accounts set tokens = tokens - p_stake where user_id = uid;
  insert into bets (user_id, tournament_id, future_id, player_id, selection, market, price, decimal_odds, stake)
  values (uid, null, s.id, s.player_id, s.name, m.title, s.price, frac_decimal(s.price), p_stake)
  returning id into bid;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake);
end $$;
