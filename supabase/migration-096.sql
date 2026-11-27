-- Superboosts: a hand-priced bet for a comp at better odds than usual,
-- shown first in that comp on the Odds page as "was X/Y, now A/B". Single
-- bets only (not in accas). An optional max stake per person keeps the
-- generous price from being hammered. Settled by a super admin.
--
-- Boost bets deliberately carry no tournament_id: the outright settlement
-- (resettle_outright) treats every tournament bet without a match as a
-- winner bet. They link to their boost through boost_id instead.

create table if not exists superboosts (
  id            bigserial primary key,
  tournament_id uuid references tournaments(id) on delete set null,
  title         text not null check (btrim(title) != ''),
  detail        text,
  was_price     text,
  price         text not null,
  max_stake     integer check (max_stake is null or max_stake >= 10),
  status        text not null default 'draft' check (status in ('draft', 'open', 'closed', 'settled')),
  result        text check (result in ('won', 'lost', 'void')),
  closes_at     timestamptz,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);
alter table superboosts enable row level security;
revoke all on superboosts from anon, authenticated;

alter table bets add column if not exists boost_id bigint references superboosts(id) on delete restrict;
alter table bets drop constraint if exists bets_kind_check;
alter table bets add constraint bets_kind_check check (kind in ('single', 'market', 'acca', 'boost'));
alter table bets drop constraint if exists bets_has_target;
alter table bets add constraint bets_has_target check (tournament_id is not null or future_id is not null or boost_id is not null or kind in ('market', 'acca'));
create index if not exists bets_boost_idx on bets (boost_id) where boost_id is not null;

-- Why a boost can't be bet on (or cancelled) right now, or null.
create or replace function public.boost_bet_block(p_boost bigint)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
    when b.id is null then 'That superboost isn''t there any more'
    when b.status = 'draft' then 'That superboost isn''t open yet'
    when b.status != 'open' or b.closes_at <= now() then 'Betting on that superboost has closed'
  end
  from (select 1) x left join superboosts b on b.id = p_boost;
$function$;

create or replace function public.place_boost_bet(p_boost bigint, p_price text, p_stake integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  a accounts;
  b superboosts;
  why text;
  bid bigint;
  already integer;
begin
  if uid is null then raise exception 'Log in to bet'; end if;
  perform apply_topups(uid);
  select * into a from accounts where user_id = uid for update;
  if not found then raise exception 'Confirm your email to start betting'; end if;
  if a.banned then raise exception 'Your account can''t place bets'; end if;
  if not a.can_bet then raise exception 'Admin logins can''t bet. Sign up with your email to bet.'; end if;
  if p_stake is null or p_stake < 10 then raise exception 'The smallest bet is 10 tokens'; end if;
  if p_stake > a.tokens then raise exception 'You only have % tokens', a.tokens; end if;

  select * into b from superboosts where id = p_boost for share;
  why := boost_bet_block(p_boost);
  if why is not null then raise exception '%', why; end if;
  if p_price is distinct from b.price then
    return jsonb_build_object('changed', true, 'price', b.price);
  end if;
  if b.max_stake is not null then
    select coalesce(sum(stake), 0) into already from bets
     where boost_id = p_boost and user_id = uid and status != 'cancelled';
    if already + p_stake > b.max_stake then
      raise exception 'The most you can stake on this superboost is % tokens%', b.max_stake,
        case when already > 0 then format(' (you have %s on already)', already) else '' end;
    end if;
  end if;

  update accounts set tokens = tokens - p_stake where user_id = uid;
  insert into bets (user_id, kind, boost_id, selection, market, price, decimal_odds, stake)
  values (uid, 'boost', b.id, b.title,
          'Superboost' || coalesce(' (was ' || b.was_price || ')', ''), b.price, frac_decimal(b.price), p_stake)
  returning id into bid;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake);
end $function$;
revoke all on function public.place_boost_bet(bigint, text, integer) from public, anon;
grant execute on function public.place_boost_bet(bigint, text, integer) to authenticated;

-- Settle (or unsettle, with null) a boost: undoes any earlier result first,
-- so a wrong result can be corrected.
create or replace function public.settle_boost(p_boost bigint, p_result text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_result is not null and p_result not in ('won', 'lost', 'void') then raise exception 'Unknown result %', p_result; end if;
  perform 1 from superboosts where id = p_boost for update;
  if not found then raise exception 'Superboost not found'; end if;
  update accounts a set tokens = a.tokens - x.back
    from (select user_id, sum(case status when 'won' then payout when 'void' then stake else 0 end) as back
            from bets where boost_id = p_boost and status in ('won', 'void') and not void_manual group by user_id) x
   where a.user_id = x.user_id;
  update bets set status = 'open', payout = 0, settled_at = null
   where boost_id = p_boost and status in ('won', 'lost', 'void') and not void_manual;
  if p_result is not null then
    update bets set status = p_result,
                    payout = case when p_result = 'won' then floor(stake * decimal_odds)::bigint else 0 end,
                    settled_at = now()
     where boost_id = p_boost and status = 'open';
    update accounts a set tokens = a.tokens + x.back
      from (select user_id, sum(case status when 'won' then payout when 'void' then stake else 0 end) as back
              from bets where boost_id = p_boost and status in ('won', 'void') and not void_manual group by user_id) x
     where a.user_id = x.user_id;
  end if;
  update superboosts set result = p_result,
         status = case when p_result is null then (case when status = 'settled' then 'closed' else status end) else 'settled' end,
         settled_at = case when p_result is null then null else now() end
   where id = p_boost;
end $function$;
revoke all on function public.settle_boost(bigint, text) from public, anon;

create or replace function public.super_boost_settle(p_boost bigint, p_result text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  perform settle_boost(p_boost, nullif(p_result, ''));
end $function$;

create or replace function public.super_boosts()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
           'id', b.id, 'tournament_id', b.tournament_id, 'tournament', t.name, 'title', b.title, 'detail', b.detail,
           'was_price', b.was_price, 'price', b.price, 'max_stake', b.max_stake, 'status', b.status, 'result', b.result,
           'closes_at', b.closes_at, 'bets', coalesce(x.n, 0), 'staked', coalesce(x.staked, 0), 'liability', coalesce(x.liability, 0))
         order by (b.status = 'settled'), t.starts_at nulls last, b.sort, b.id)
    from superboosts b
    left join tournaments t on t.id = b.tournament_id
    left join lateral (select count(*) as n, sum(stake) as staked, sum(floor(stake * decimal_odds)) filter (where status = 'open') as liability
                         from bets where boost_id = b.id and status != 'cancelled') x on true), '[]'::jsonb);
end $function$;

-- Add (no id) or edit a boost.
create or replace function public.super_boost_save(p_id bigint, p_tournament uuid, p_title text, p_detail text,
                                                    p_was text, p_price text, p_max integer, p_status text, p_closes_at timestamptz)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare bid bigint; now_p text := nullif(btrim(coalesce(p_price, '')), ''); was text := nullif(btrim(coalesce(p_was, '')), '');
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if nullif(btrim(p_title), '') is null then raise exception 'Say what the superboost is'; end if;
  if now_p ~* '^evens$' then now_p := 'Evens'; end if;
  if was ~* '^evens$' then was := 'Evens'; end if;
  if frac_decimal(now_p) is null or frac_decimal(now_p) <= 1 then raise exception 'Can''t read % as a price. Use 5/2, 8/11 or Evens.', coalesce(now_p, 'that'); end if;
  if was is not null and (frac_decimal(was) is null or frac_decimal(was) <= 1) then raise exception 'Can''t read % as the old price', was; end if;
  if was is not null and frac_decimal(was) >= frac_decimal(now_p) then raise exception 'The boosted price should be bigger than the old one'; end if;
  if p_status not in ('draft', 'open', 'closed') then raise exception 'Pick draft, open or closed (settle it with a result)'; end if;
  if p_id is null then
    insert into superboosts (tournament_id, title, detail, was_price, price, max_stake, status, closes_at, sort)
    values (p_tournament, btrim(p_title), nullif(btrim(coalesce(p_detail, '')), ''), was, now_p, p_max, p_status, p_closes_at,
            coalesce((select max(sort) from superboosts where tournament_id is not distinct from p_tournament), 0) + 1)
    returning id into bid;
  else
    update superboosts set tournament_id = p_tournament, title = btrim(p_title), detail = nullif(btrim(coalesce(p_detail, '')), ''),
           was_price = was, price = now_p, max_stake = p_max,
           status = case when status = 'settled' then status else p_status end, closes_at = p_closes_at
     where id = p_id returning id into bid;
    if bid is null then raise exception 'Superboost not found'; end if;
  end if;
  return bid;
end $function$;

create or replace function public.super_boost_delete(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if exists (select 1 from bets where boost_id = p_id) then raise exception 'People have bet on this. Close or settle it instead.'; end if;
  delete from superboosts where id = p_id;
end $function$;

revoke all on function public.super_boost_settle(bigint, text) from public, anon;
revoke all on function public.super_boosts() from public, anon;
revoke all on function public.super_boost_save(bigint, uuid, text, text, text, text, integer, text, timestamptz) from public, anon;
revoke all on function public.super_boost_delete(bigint) from public, anon;
grant execute on function public.super_boost_settle(bigint, text) to authenticated;
grant execute on function public.super_boosts() to authenticated;
grant execute on function public.super_boost_save(bigint, uuid, text, text, text, text, integer, text, timestamptz) to authenticated;
grant execute on function public.super_boost_delete(bigint) to authenticated;

-- Open boosts for the Odds page, with their comp.
create or replace function public.open_boosts()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'tournament_id', b.tournament_id, 'tournament', coalesce(t.name, 'Superboosts'), 'starts_at', t.starts_at,
           'title', b.title, 'detail', b.detail, 'was', b.was_price, 'price', b.price, 'max_stake', b.max_stake, 'closes_at', b.closes_at)
         order by t.starts_at nulls last, b.sort, b.id), '[]'::jsonb)
    from superboosts b left join tournaments t on t.id = b.tournament_id and t.deleted_at is null
   where b.status = 'open' and (b.closes_at is null or b.closes_at > now());
$function$;
grant execute on function public.open_boosts() to anon, authenticated;

-- Cancelling a boost bet follows the boost: allowed while it's open.
do $$ declare d text; begin
  select pg_get_functiondef('public.cancel_bet'::regproc) into d;
  if position('boost_bet_block' in d) = 0 then
    d := replace(d, $r$              when b.future_id is not null then$r$,
                    $r$              when b.boost_id is not null then boost_bet_block(b.boost_id)
              when b.future_id is not null then$r$);
    execute d;
  end if;
end $$;
