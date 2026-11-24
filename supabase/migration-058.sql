-- Futures: a free cancel for 24 hours after placing, then cash out.
--
-- For the first 24 hours a futures bet can be cancelled for the full stake,
-- as long as the market is still taking bets. After that it can be cashed
-- out instead: the stake times the price it was placed at over the price
-- now, less a 10% fee, and never more than the bet would return if it won.
-- Match and outright bets are unchanged.

alter table public.bets drop constraint if exists bets_status_check;
alter table public.bets add constraint bets_status_check
  check (status in ('open', 'won', 'lost', 'void', 'cancelled', 'cashed_out'));

create or replace function public.future_free_cancel_hours() returns integer
language sql immutable as $$ select 24 $$;
create or replace function public.future_cash_out_fee() returns numeric
language sql immutable as $$ select 0.10 $$;

-- What a futures bet can be cashed out for right now, or null if it can't
-- (still inside the free cancel window, market not taking bets, no price).
create or replace function public.future_cash_out_value(p_bet bigint)
returns bigint language sql stable security definer set search_path = public as $$
  select case
    when b.id is null or b.status <> 'open' or b.future_id is null then null
    when b.placed_at > now() - make_interval(hours => future_free_cancel_hours()) then null
    when future_bet_block(b.future_id) is not null then null
    else least(floor(b.stake * b.decimal_odds),
               floor(b.stake * b.decimal_odds / frac_decimal(s.price) * (1 - future_cash_out_fee())))::bigint
  end
  from (select 1) x
  left join bets b on b.id = p_bet
  left join futures_selections s on s.id = b.future_id;
$$;

-- p_value is the amount the page showed. If the price has moved since, the
-- bet stays open and the new value comes back to confirm.
create or replace function public.cash_out_bet(p_bet bigint, p_value bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b bets;
  v bigint;
begin
  select * into b from bets where id = p_bet and user_id = auth.uid() for update;
  if not found then raise exception 'Bet not found'; end if;
  if b.status <> 'open' then raise exception 'That bet has already been settled'; end if;
  if b.future_id is null then raise exception 'Only futures bets can be cashed out'; end if;
  if b.placed_at > now() - make_interval(hours => future_free_cancel_hours()) then
    raise exception 'You can still cancel this bet for free';
  end if;
  v := future_cash_out_value(b.id);
  if v is null then raise exception 'Cash out isn''t available on this bet right now'; end if;
  if v is distinct from p_value then
    return jsonb_build_object('changed', true, 'value', v);
  end if;
  update bets set status = 'cashed_out', payout = v, settled_at = now() where id = b.id;
  update accounts set tokens = tokens + v where user_id = b.user_id;
  return jsonb_build_object('value', v, 'tokens', (select tokens from accounts where user_id = b.user_id));
end $$;

-- Free cancels on futures only within the window.
create or replace function public.cancel_bet(p_bet bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  b bets;
  why text;
begin
  select * into b from bets where id = p_bet and user_id = auth.uid() for update;
  if not found then raise exception 'Bet not found'; end if;
  if b.status <> 'open' then raise exception 'That bet has already been settled'; end if;
  why := case when b.match_id is not null then match_bet_block(b.match_id)
              when b.future_id is not null then coalesce(future_bet_block(b.future_id, true),
                case when b.placed_at <= now() - make_interval(hours => future_free_cancel_hours())
                     then 'The free cancel window has closed. You can cash out instead' end)
              else outright_bet_block(b.tournament_id) end;
  if why is not null then raise exception 'Too late to cancel: %', lower(left(why, 1)) || substr(why, 2); end if;
  update bets set status = 'cancelled', settled_at = now() where id = b.id;
  update accounts set tokens = tokens + b.stake where user_id = b.user_id;
  return (select tokens from accounts where user_id = b.user_id);
end $$;

create or replace function public.my_bets(p_limit integer default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.tournament_id, b.match_id, b.side, b.player_id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as tournament, fs.market_id as future_market,
           b.status = 'open' and (case when b.match_id is not null then match_bet_block(b.match_id)
                                       when b.future_id is not null then coalesce(future_bet_block(b.future_id, true),
                                         case when b.placed_at <= now() - make_interval(hours => future_free_cancel_hours()) then 'late' end)
                                       else outright_bet_block(b.tournament_id) end) is null as can_cancel,
           case when b.future_id is not null and b.status = 'open'
                then b.placed_at + make_interval(hours => future_free_cancel_hours()) end as free_cancel_until,
           future_cash_out_value(b.id) as cash_out
      from bets b
      left join tournaments t on t.id = b.tournament_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     where b.user_id = auth.uid()
     order by b.placed_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
$$;
