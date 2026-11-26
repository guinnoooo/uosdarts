-- Voiding futures bets.
-- 1. A single open futures bet can be voided by a super admin: stake back,
--    shown as "Bet void". It's marked so that settling its selection later
--    leaves it alone.
-- 2. "Settle everyone left" can settle the rest of a market as void
--    (stakes back) as well as lost.

alter table bets add column if not exists void_manual boolean not null default false;

create or replace function public.settle_future_selection(p_selection bigint, p_result text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_result is not null and p_result not in ('won', 'lost', 'void') then raise exception 'Unknown result %', p_result; end if;
  perform 1 from futures_selections where id = p_selection for update;
  if not found then raise exception 'Selection not found'; end if;

  -- Undo any earlier settlement, except bets voided one by one.
  update accounts a set tokens = a.tokens - x.back
    from (select user_id, sum(case status when 'won' then payout when 'void' then stake else 0 end) as back
            from bets where future_id = p_selection and status in ('won', 'void') and not void_manual group by user_id) x
   where a.user_id = x.user_id;
  update bets set status = 'open', payout = 0, settled_at = null
   where future_id = p_selection and status in ('won', 'lost', 'void') and not void_manual;

  if p_result is not null then
    update bets set status = p_result,
                    payout = case when p_result = 'won' then floor(stake * decimal_odds)::bigint else 0 end,
                    settled_at = now()
     where future_id = p_selection and status = 'open';
    update accounts a set tokens = a.tokens + x.back
      from (select user_id, sum(case status when 'won' then payout when 'void' then stake else 0 end) as back
              from bets where future_id = p_selection and status in ('won', 'void') and not void_manual group by user_id) x
     where a.user_id = x.user_id;
  end if;
  update futures_selections set result = p_result, settled_at = case when p_result is null then null else now() end
   where id = p_selection;
end $function$;

drop function if exists public.super_future_settle_rest(bigint);
create function public.super_future_settle_rest(p_market bigint, p_result text default 'lost')
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s record; n integer := 0;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_result not in ('lost', 'void') then raise exception 'Settle the rest as lost or void'; end if;
  for s in select id from futures_selections where market_id = p_market and result is null loop
    perform settle_future_selection(s.id, p_result);
    n := n + 1;
  end loop;
  update futures_markets set status = 'settled' where id = p_market;
  return n;
end $function$;
revoke all on function public.super_future_settle_rest(bigint, text) from public, anon;
grant execute on function public.super_future_settle_rest(bigint, text) to authenticated;

create or replace function public.super_void_bet(p_bet bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare b record;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  select * into b from bets where id = p_bet for update;
  if not found then raise exception 'Bet not found'; end if;
  if b.future_id is null then raise exception 'Only futures bets can be voided here'; end if;
  if b.status <> 'open' then raise exception 'That bet is already settled'; end if;
  update bets set status = 'void', payout = 0, settled_at = now(), void_manual = true where id = p_bet;
  update accounts set tokens = tokens + b.stake where user_id = b.user_id;
end $function$;
revoke all on function public.super_void_bet(bigint) from public, anon;
grant execute on function public.super_void_bet(bigint) to authenticated;

-- The super admin bet lists say which bets are futures, for the Void button.
create or replace function public.super_all_bets(p_limit integer default 500)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.kind, b.future_id, b.user_id, a.display_name as account, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as event,
           case when m.id is not null then coalesce(p1.name, m.p1_name, 'TBC') || ' v ' || coalesce(p2.name, m.p2_name, 'TBC') end as match,
           case when b.kind in ('market', 'acca') then bet_legs_json(b.id) end as legs
      from bets b
      join accounts a on a.user_id = b.user_id
      left join tournaments t on t.id = b.tournament_id
      left join matches m on m.id = b.match_id
      left join players p1 on p1.id = m.player1_id
      left join players p2 on p2.id = m.player2_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     order by b.placed_at desc limit greatest(1, least(p_limit, 5000))) x), '[]'::jsonb);
end $function$;

create or replace function public.super_account_bets(p_user uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.kind, b.future_id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as event, b.match_id, b.tournament_id,
           case when m.id is not null then coalesce(p1.name, m.p1_name, 'TBC') || ' v ' || coalesce(p2.name, m.p2_name, 'TBC') end as match,
           case when b.kind in ('market', 'acca') then bet_legs_json(b.id) end as legs
      from bets b
      left join tournaments t on t.id = b.tournament_id
      left join matches m on m.id = b.match_id
      left join players p1 on p1.id = m.player1_id
      left join players p2 on p2.id = m.player2_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     where b.user_id = p_user) x), '[]'::jsonb);
end $function$;
