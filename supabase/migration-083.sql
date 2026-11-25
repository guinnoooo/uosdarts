-- GuinnessBet match markets and accas.
--
-- A bet on one of the new match markets (correct score, handicap, 100+
-- visits, averages, 180...) or an acca is a bets row with kind 'market' or
-- 'acca' and one row per selection in bet_selections. These bets have no
-- tournament_id or match_id of their own, so the existing winner and
-- outright settlement never touches them; the selections carry the match.
--
-- Nothing here runs while a match is being scored. Selections are settled
-- in one pass when a match is completed (or un-completed), from the same
-- trigger that already settles winner bets, and voided when a match is
-- deleted or its players change before it starts.

alter table bets add column if not exists kind text not null default 'single';
alter table bets drop constraint if exists bets_kind_check;
alter table bets add constraint bets_kind_check check (kind in ('single', 'market', 'acca'));
alter table bets drop constraint if exists bets_has_target;
alter table bets add constraint bets_has_target
  check (tournament_id is not null or future_id is not null or kind in ('market', 'acca'));

create table if not exists bet_selections (
  id bigserial primary key,
  bet_id bigint not null references bets(id) on delete cascade,
  match_id uuid references matches(id) on delete set null,
  market text not null,          -- win, cs, hcap, legs, first, tons, tons1, tons2, avg1, avg2, 180
  pick text not null,            -- '1'/'2' for win, 'a'/'b' for two-way markets, '3-1' for correct score
  line numeric,                  -- the over/under or handicap line
  fav smallint,                  -- which player gives the handicap
  title text not null,           -- 'Egan v Wells: Correct score'
  label text not null,           -- 'Egan 3-1'
  price text not null,
  decimal_odds numeric not null check (decimal_odds > 1),
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'void')),
  settled_at timestamptz
);
create index if not exists bet_selections_match on bet_selections (match_id);
create index if not exists bet_selections_bet on bet_selections (bet_id);
alter table bet_selections enable row level security;
drop policy if exists "own selections" on bet_selections;
create policy "own selections" on bet_selections for select
  using (exists (select 1 from bets b where b.id = bet_id and b.user_id = (select auth.uid())));

-- Is this set of figures for a market a win, a loss or void? r: the match's results.
create or replace function selection_outcome(s bet_selections, w smallint, l1 int, l2 int, first smallint,
                                             t1 int, t2 int, x1 int, x2 int, a1 numeric, a2 numeric, nv int)
returns text language sql immutable as $$
  select case
    when s.market = 'win' then case when w is null then 'void' when s.pick = w::text then 'won' else 'lost' end
    when s.market = 'cs' then case when s.pick = l1 || '-' || l2 then 'won' else 'lost' end
    when s.market = 'hcap' then case when ((case when s.fav = 1 then l1 - l2 else l2 - l1 end) > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = 'legs' then case when (l1 + l2 > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = 'first' then case when first is null then 'void' when first::text = case s.pick when 'a' then '1' else '2' end then 'won' else 'lost' end
    -- Scoring markets need the visits: a result entered without them is void.
    when nv = 0 then 'void'
    when s.market = 'tons' then case when (t1 + t2 > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = 'tons1' then case when (t1 > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = 'tons2' then case when (t2 > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = 'avg1' then case when a1 is null then 'void' when (a1 > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = 'avg2' then case when a2 is null then 'void' when (a2 > s.line) = (s.pick = 'a') then 'won' else 'lost' end
    when s.market = '180' then case when (x1 + x2 > 0) = (s.pick = 'a') then 'won' else 'lost' end
    else 'void' end;
$$;

-- A market or acca bet from its selections: lost as soon as one loses, won
-- once every one is in (void ones drop out of the price), void if all are.
-- Pays or takes back only the difference from what it had paid before, so
-- running it again is safe.
create or replace function settle_bet_from_selections(p_bet bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  b bets;
  n_lost int; n_open int; n_won int; prod numeric;
  new_status text; new_payout bigint; old_credit bigint; new_credit bigint;
begin
  select * into b from bets where id = p_bet for update;
  if not found or b.kind not in ('market', 'acca') or b.status in ('cancelled', 'cashed_out') then return; end if;
  select count(*) filter (where status = 'lost'), count(*) filter (where status = 'open'), count(*) filter (where status = 'won'),
         coalesce(exp(sum(ln(decimal_odds)) filter (where status = 'won')), 1)
    into n_lost, n_open, n_won, prod
    from bet_selections where bet_id = p_bet;
  if n_lost > 0 then new_status := 'lost'; new_payout := 0;
  elsif n_open > 0 then new_status := 'open'; new_payout := 0;
  elsif n_won = 0 then new_status := 'void'; new_payout := 0;
  else new_status := 'won'; new_payout := floor(b.stake * round(prod, 4))::bigint;
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

-- Settle (or unsettle) every selection on a match. One read of its visits.
create or replace function settle_match_selections(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m matches;
  w smallint; f smallint;
  t1 int; t2 int; x1 int; x2 int; a1 numeric; a2 numeric; nv int;
  ids bigint[];
begin
  if not exists (select 1 from bet_selections where match_id = p_match) then return; end if;
  select * into m from matches where id = p_match;
  if m.status is distinct from 'complete' then
    with u as (update bet_selections set status = 'open', settled_at = null
                where match_id = p_match and status in ('won', 'lost') returning bet_id)
    select array_agg(distinct bet_id) into ids from u;
  else
    w := match_winner_side(m);
    select l.winner::smallint into f from legs l
     where l.match_id = p_match and not coalesce(l.bull_off, false) and l.winner is not null
     order by l.leg_no limit 1;
    select count(*) filter (where player = 1 and score >= 100), count(*) filter (where player = 2 and score >= 100),
           count(*) filter (where player = 1 and score = 180), count(*) filter (where player = 2 and score = 180),
           round(sum(score) filter (where player = 1)::numeric / nullif(sum(darts) filter (where player = 1), 0) * 3, 2),
           round(sum(score) filter (where player = 2)::numeric / nullif(sum(darts) filter (where player = 2), 0) * 3, 2),
           count(*)
      into t1, t2, x1, x2, a1, a2, nv
      from visits where match_id = p_match;
    with u as (
      update bet_selections s set status = x.st, settled_at = case when x.st = 'open' then null else now() end
        from (select s2.id, selection_outcome(s2, w, coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0), f,
                                              t1, t2, x1, x2, a1, a2, nv) as st
                from bet_selections s2 where s2.match_id = p_match and s2.status <> 'void'
                  and not exists (select 1 from bets b where b.id = s2.bet_id and b.status in ('cancelled', 'cashed_out'))) x
       where s.id = x.id and s.status is distinct from x.st
       returning s.bet_id)
    select array_agg(distinct bet_id) into ids from u;
  end if;
  if ids is not null then perform settle_bet_from_selections(i) from unnest(ids) i; end if;
end $$;

-- A match deleted, or its players changed before it started: its selections are void.
create or replace function void_match_selections(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare ids bigint[];
begin
  if not exists (select 1 from bet_selections where match_id = p_match and status = 'open') then return; end if;
  with u as (update bet_selections set status = 'void', settled_at = now()
              where match_id = p_match and status = 'open' returning bet_id)
  select array_agg(distinct bet_id) into ids from u;
  perform settle_bet_from_selections(i) from unnest(ids) i;
end $$;

create or replace function public.bets_follow_match()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if tg_op = 'DELETE' then
    perform void_open_bets(old.tournament_id, old.id);
    perform void_match_selections(old.id);
    return old;
  end if;
  if new.status = 'pending' and (
       (old.player1_id is not null and old.player1_id is distinct from new.player1_id)
    or (old.player2_id is not null and old.player2_id is distinct from new.player2_id)
    or (old.p1_name is not null and old.p1_name is distinct from new.p1_name)
    or (old.p2_name is not null and old.p2_name is distinct from new.p2_name)) then
    perform void_open_bets(new.tournament_id, new.id);
    perform void_match_selections(new.id);
  end if;
  if old.status = 'complete' or new.status = 'complete' then
    perform resettle_match(new.id);
    perform settle_match_selections(new.id);
  end if;
  return new;
end $function$;

-- Placing a market bet or an acca. Called by the place-bet edge function
-- with prices it has worked out itself. p_sels: [{ match_id, market, pick,
-- line, fav, title, label, price, decimal }]. One selection per match.
create or replace function place_selections_internal(p_user uuid, p_stake int, p_sels jsonb, p_version int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a accounts;
  n int;
  why text;
  s jsonb;
  prod numeric := 1;
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

  update accounts set tokens = tokens - p_stake where user_id = p_user;
  insert into bets (user_id, kind, selection, market, price, decimal_odds, stake, model_version)
  values (p_user, k,
          case when n = 1 then p_sels->0->>'label' else (select string_agg(x->>'label', ' + ') from jsonb_array_elements(p_sels) x) end,
          case when n = 1 then p_sels->0->>'title' else n || '-fold acca' end,
          case when n = 1 then p_sels->0->>'price' else to_char(prod, 'FM999999990.00') end,
          prod, p_stake, p_version)
  returning id into bid;
  insert into bet_selections (bet_id, match_id, market, pick, line, fav, title, label, price, decimal_odds)
  select bid, (x->>'match_id')::uuid, x->>'market', x->>'pick', (x->>'line')::numeric, (x->>'fav')::smallint,
         x->>'title', x->>'label', x->>'price', (x->>'decimal')::numeric
    from jsonb_array_elements(p_sels) x;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake, 'decimal', prod);
end $$;
revoke all on function place_selections_internal(uuid, int, jsonb, int) from public, anon, authenticated;
revoke all on function settle_bet_from_selections(bigint) from public, anon, authenticated;
revoke all on function settle_match_selections(uuid) from public, anon, authenticated;
revoke all on function void_match_selections(uuid) from public, anon, authenticated;

-- What each player has thrown on the site before now, for the scoring markets.
create or replace function market_figures(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with m as (select coalesce(player1_id, counted_p1_id) a, coalesce(player2_id, counted_p2_id) b from matches where id = p_match),
  v as (
    select case when vi.player = 1 then coalesce(x.player1_id, x.counted_p1_id) else coalesce(x.player2_id, x.counted_p2_id) end pid, vi.score
      from matches x
      join tournaments t on t.id = x.tournament_id and t.deleted_at is null
      join visits vi on vi.match_id = x.id
     where coalesce(x.start_score, 501) = 501
       and ((select a from m) in (x.player1_id, x.player2_id, x.counted_p1_id, x.counted_p2_id)
         or (select b from m) in (x.player1_id, x.player2_id, x.counted_p1_id, x.counted_p2_id)))
  select jsonb_build_object(
    'p1', (select jsonb_build_object('v', count(*), 'tons', count(*) filter (where score >= 100), 'm180', count(*) filter (where score = 180))
             from v where pid = (select a from m)),
    'p2', (select jsonb_build_object('v', count(*), 'tons', count(*) filter (where score >= 100), 'm180', count(*) filter (where score = 180))
             from v where pid = (select b from m)));
$$;

-- Cancelling: market bets and accas can be cancelled until any of their matches starts.
create or replace function public.cancel_bet(p_bet bigint)
returns bigint language plpgsql security definer set search_path to 'public' as $function$
declare
  b bets;
  why text;
begin
  select * into b from bets where id = p_bet and user_id = auth.uid() for update;
  if not found then raise exception 'Bet not found'; end if;
  if b.status <> 'open' then raise exception 'That bet has already been settled'; end if;
  why := case when b.kind in ('market', 'acca') then
                (select match_bet_block(s.match_id) from bet_selections s
                  where s.bet_id = b.id and (s.match_id is null or match_bet_block(s.match_id) is not null) limit 1)
              when b.match_id is not null then match_bet_block(b.match_id)
              when b.future_id is not null then coalesce(future_bet_block(b.future_id, true),
                case when b.placed_at <= now() - make_interval(hours => future_free_cancel_hours())
                     then 'The free cancel window has closed. You can cash out instead' end)
              else outright_bet_block(b.tournament_id) end;
  if why is not null then raise exception 'Too late to cancel: %', lower(left(why, 1)) || substr(why, 2); end if;
  update bets set status = 'cancelled', settled_at = now() where id = b.id;
  update bet_selections set status = 'void', settled_at = now() where bet_id = b.id and status = 'open';
  update accounts set tokens = tokens + b.stake where user_id = b.user_id;
  return (select tokens from accounts where user_id = b.user_id);
end $function$;

-- Scorers can't take on a match they've bet on, accas included.
create or replace function public.no_scoring_own_bets()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if (new.scorer_id is not null and new.scorer_id is distinct from old.scorer_id
        and (exists (select 1 from bets where match_id = new.id and user_id = new.scorer_id and status <> 'cancelled')
          or exists (select 1 from bet_selections s join bets b on b.id = s.bet_id
                      where s.match_id = new.id and b.user_id = new.scorer_id and b.status <> 'cancelled')))
  or (new.scorer2_id is not null and new.scorer2_id is distinct from old.scorer2_id
        and (exists (select 1 from bets where match_id = new.id and user_id = new.scorer2_id and status <> 'cancelled')
          or exists (select 1 from bet_selections s join bets b on b.id = s.bet_id
                      where s.match_id = new.id and b.user_id = new.scorer2_id and b.status <> 'cancelled'))) then
    raise exception 'You''ve bet on this match, so someone else needs to score it';
  end if;
  return new;
end $function$;

-- The selections of a bet, for the bet lists.
create or replace function bet_legs_json(p_bet bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('match_id', s.match_id, 'title', s.title, 'label', s.label,
                                               'price', s.price, 'status', s.status) order by s.id), '[]'::jsonb)
    from bet_selections s where s.bet_id = p_bet;
$$;

create or replace function public.my_bets(p_limit integer default 50)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.kind, b.tournament_id, b.match_id, b.side, b.player_id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as tournament, fs.market_id as future_market,
           b.status = 'open' and (case when b.kind in ('market', 'acca') then
                                         (select 'x' from bet_selections s where s.bet_id = b.id
                                           and (s.match_id is null or match_bet_block(s.match_id) is not null) limit 1)
                                       when b.match_id is not null then match_bet_block(b.match_id)
                                       when b.future_id is not null then coalesce(future_bet_block(b.future_id, true),
                                         case when b.placed_at <= now() - make_interval(hours => future_free_cancel_hours()) then 'late' end)
                                       else outright_bet_block(b.tournament_id) end) is null as can_cancel,
           case when b.future_id is not null and b.status = 'open'
                then b.placed_at + make_interval(hours => future_free_cancel_hours()) end as free_cancel_until,
           future_cash_out_value(b.id) as cash_out,
           case when b.kind in ('market', 'acca') then bet_legs_json(b.id) end as legs
      from bets b
      left join tournaments t on t.id = b.tournament_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     where b.user_id = auth.uid()
     order by b.placed_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
$function$;

create or replace function public.my_bets_on(p_match uuid, p_tournament uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.kind, b.selection, b.market, b.price, b.stake, b.status, b.payout, floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at,
           b.status = 'open' and (case when b.kind in ('market', 'acca') then
                                         (select 'x' from bet_selections s where s.bet_id = b.id
                                           and (s.match_id is null or match_bet_block(s.match_id) is not null) limit 1)
                                       when b.match_id is not null then match_bet_block(b.match_id)
                                       else outright_bet_block(b.tournament_id) end) is null as can_cancel,
           case when b.kind in ('market', 'acca') then bet_legs_json(b.id) end as legs
      from bets b
     where b.user_id = auth.uid()
       and ((p_match is not null and (b.match_id = p_match
              or exists (select 1 from bet_selections s where s.bet_id = b.id and s.match_id = p_match)))
         or (p_match is null and b.tournament_id = p_tournament and b.match_id is null))
       and b.status <> 'cancelled') x;
$function$;

create or replace function public.super_account_bets(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.kind, b.selection, b.market, b.price, b.stake, b.status, b.payout,
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

create or replace function public.super_all_bets(p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.kind, b.user_id, a.display_name as account, b.selection, b.market, b.price, b.stake, b.status, b.payout,
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
