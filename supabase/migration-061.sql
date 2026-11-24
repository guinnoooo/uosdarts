-- Fantasy roles. The five starting spots are each a role:
--   1 Captain        all points double
--   2 Power Scorer   points for 180s and 140+ visits triple
--   3 Big Finisher   points for 100+ checkouts triple
--   4 Dark Horse     match-win points triple for beating someone they were
--                    the betting underdog against
--   5 Tricky Player  match-win points triple for winning with a lower
--                    average than their opponent
-- and slot 6 is the bench, who comes on in the role of the first starter
-- who didn't play that week.
--
-- Base points per match: 2 for a win, 1 per leg won, 1 per 140+ visit
-- (140 to 179), 3 per 180, 5 per 100+ checkout, 1 for a 50+ average (2 for
-- 60+). Winning an event is 10, runner-up 5.
--
-- "Underdog" is the pre-match chance from the odds model, worked out from
-- the snapshot taken when the match started. The place-bet edge function
-- fills match_odds for any snapshot that hasn't got one (kind 'prematch');
-- the fantasy page asks it to whenever it loads. A match with no snapshot
-- (a result entered by hand) can't count as an upset.

create table if not exists public.match_odds (
  match_id uuid primary key references public.matches(id) on delete cascade,
  p1_win numeric not null,
  model_version integer,
  computed_at timestamptz not null default now()
);
alter table public.match_odds enable row level security;
drop policy if exists "match odds readable" on public.match_odds;
create policy "match odds readable" on public.match_odds for select using (true);
grant select on public.match_odds to anon, authenticated;

-- Snapshots still waiting for their pre-match chance (for the edge function).
create or replace function public.prematch_missing(p_limit integer default 500)
returns table(match_id uuid, features jsonb)
language sql stable security definer set search_path = public as $$
  select s.match_id, s.features from model_snapshots s
   where not exists (select 1 from match_odds o where o.match_id = s.match_id)
   order by s.taken_at desc
   limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

drop function if exists public.fantasy_player_points(date);
create or replace function public.fantasy_player_points(p_gw date)
returns table(player_id uuid, played boolean, points integer, power integer, finish integer, dark integer, tricky integer, detail jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (select id, champion_id, status from fantasy_events(p_gw)),
  ms as (
    select m.*, coalesce(m.player1_id, m.counted_p1_id) as a, coalesce(m.player2_id, m.counted_p2_id) as b
      from matches m join ev on ev.id = m.tournament_id
     where m.status = 'complete' and m.winner_id is not null
       and (m.player1_id is not null or m.counted_p1_id is not null or m.p1_name is not null)
       and (m.player2_id is not null or m.counted_p2_id is not null or m.p2_name is not null)),
  vis as (
    select v.match_id, v.player as s,
           count(*) filter (where v.score = 180 and not v.is_bust) as t180,
           count(*) filter (where v.score between 140 and 179 and not v.is_bust) as t140,
           count(*) filter (where v.remaining = 0 and v.score >= 100 and not v.is_bust) as bigout,
           case when sum(v.darts) > 0 then sum(v.score)::numeric / sum(v.darts) * 3 end as avg
      from visits v where v.match_id in (select id from ms)
     group by v.match_id, v.player),
  side as (
    select ms.id as match_id, 1 as s, ms.a as pid, ms.p1_legs as legs, ms.winner_id = ms.a as won,
           ms.next_match_id is null and ms.stage = 'knockout' as final, o.p1_win as chance
      from ms left join match_odds o on o.match_id = ms.id where ms.a is not null
    union all
    select ms.id, 2, ms.b, ms.p2_legs, ms.winner_id = ms.b,
           ms.next_match_id is null and ms.stage = 'knockout', 1 - o.p1_win
      from ms left join match_odds o on o.match_id = ms.id where ms.b is not null),
  per as (
    select x.pid, x.won, x.final, coalesce(x.legs, 0) as legs,
           coalesce(v.t180, 0) as t180, coalesce(v.t140, 0) as t140, coalesce(v.bigout, 0) as bigout, v.avg,
           x.won and x.chance < 0.5 as upset,
           x.won and v.avg is not null and ov.avg is not null and v.avg < ov.avg as tricky
      from side x
      left join vis v on v.match_id = x.match_id and v.s = x.s
      left join vis ov on ov.match_id = x.match_id and ov.s = 3 - x.s),
  agg as (
    select pid,
           count(*) filter (where won) as wins, sum(legs) as legs, sum(t180) as t180, sum(t140) as t140, sum(bigout) as bigout,
           count(*) filter (where avg >= 60) as avg60, count(*) filter (where avg >= 50 and avg < 60) as avg50,
           count(*) filter (where upset) as upsets, count(*) filter (where tricky) as trickies,
           (select count(*) from ev where ev.champion_id = per.pid and ev.status = 'complete') as titles,
           count(*) filter (where final and not won) as finals_lost
      from per group by pid)
  select pid, true,
         (2 * wins + legs + t140 + 3 * t180 + 5 * bigout + 2 * avg60 + avg50 + 10 * titles + 5 * finals_lost)::int,
         (t140 + 3 * t180)::int, (5 * bigout)::int, (2 * upsets)::int, (2 * trickies)::int,
         jsonb_build_object('wins', wins, 'legs', legs, '140+', t140, '180s', t180, '100+ outs', bigout,
                            '60+ avg', avg60, '50+ avg', avg50, 'upset wins', upsets, 'lower-average wins', trickies,
                            'titles', titles, 'runner-up', finals_lost)
    from agg;
$$;

create or replace function public.fantasy_role(p_slot integer) returns text
language sql immutable as $$
  select (array['Captain', 'Power Scorer', 'Big Finisher', 'Dark Horse', 'Tricky Player', 'Bench'])[p_slot];
$$;

-- What a player scores in a role: base points plus the role's bonus.
create or replace function public.fantasy_role_points(p_slot integer, p_points integer, p_power integer, p_finish integer, p_dark integer, p_tricky integer)
returns integer language sql immutable as $$
  select coalesce(p_points, 0) + case p_slot
    when 1 then coalesce(p_points, 0)
    when 2 then 2 * coalesce(p_power, 0)
    when 3 then 2 * coalesce(p_finish, 0)
    when 4 then 2 * coalesce(p_dark, 0)
    when 5 then 2 * coalesce(p_tricky, 0)
    else 0 end;
$$;

create or replace function public.fantasy_team_points(p_user uuid, p_gw date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  sq jsonb := '[]'::jsonb; total integer := 0; r record; pts integer; hits integer;
  b record; empty_slot integer; sub_pts integer := 0; sub_on boolean := false;
begin
  for r in
    select s.slot, s.player_id, p.name, p.slug, coalesce(pp.played, false) as played,
           pp.points, pp.power, pp.finish, pp.dark, pp.tricky, pp.detail
      from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
      left join fantasy_player_points(p_gw) pp on pp.player_id = s.player_id
     where s.slot <= 5 order by s.slot
  loop
    pts := case when r.played then fantasy_role_points(r.slot, r.points, r.power, r.finish, r.dark, r.tricky) else 0 end;
    if not r.played and empty_slot is null then empty_slot := r.slot; end if;
    sq := sq || jsonb_build_object('slot', r.slot, 'role', fantasy_role(r.slot), 'player_id', r.player_id, 'name', r.name,
                                   'slug', r.slug, 'played', r.played, 'base', coalesce(r.points, 0), 'points', pts, 'detail', r.detail);
    total := total + pts;
  end loop;

  select s.player_id, p.name, p.slug, coalesce(pp.played, false) as played, pp.points, pp.power, pp.finish, pp.dark, pp.tricky
    into b
    from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
    left join fantasy_player_points(p_gw) pp on pp.player_id = s.player_id
   where s.slot = 6;
  -- The bench player takes the role of the first starter who didn't play.
  if b.player_id is not null and empty_slot is not null and b.played then
    sub_pts := fantasy_role_points(empty_slot, b.points, b.power, b.finish, b.dark, b.tricky);
    sub_on := true;
    total := total + sub_pts;
  end if;

  hits := greatest(0, fantasy_changes(p_user, p_gw) - 1) * fantasy_hit();
  return jsonb_build_object('gw', p_gw, 'starters', sq,
           'bench_player_id', b.player_id, 'bench_name', b.name, 'bench_slug', b.slug,
           'bench_points', case when sub_on then sub_pts else coalesce(b.points, 0) end,
           'bench_came_on', sub_on, 'bench_role', case when sub_on then fantasy_role(empty_slot) end,
           'hits', hits, 'total', total - hits);
end $$;

create or replace function public.fantasy_market()
returns jsonb language sql stable security definer set search_path = public as $$
  with done as (select gw from fantasy_gws() where locks_at <= now()),
  pts as (select pp.player_id, sum(pp.points) as season, max(case when d.gw = (select max(gw) from done) then pp.points end) as last
            from done d cross join lateral fantasy_player_points(d.gw) pp group by pp.player_id)
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug, 'price', f.price,
                    'season', coalesce(pts.season, 0), 'last', coalesce(pts.last, 0)) order by f.price desc, p.name), '[]'::jsonb)
    from fantasy_prices f join players p on p.id = f.player_id
    left join pts on pts.player_id = f.player_id
   where f.price is not null;
$$;

-- The captain is whoever is in slot 1; p_captain is no longer used.
create or replace function public.fantasy_save(p_name text, p_players uuid[], p_captain uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); a accounts; nxt date := fantasy_next_gw(); cost numeric; i integer;
begin
  if uid is null then raise exception 'Log in to play'; end if;
  select * into a from accounts where user_id = uid;
  if not found then raise exception 'Confirm your email to play'; end if;
  if a.banned then raise exception 'Your account is blocked'; end if;
  if nxt is null then raise exception 'There''s no PC or major coming up to pick a team for'; end if;
  if coalesce(array_length(p_players, 1), 0) <> 6 or array_position(p_players, null) is not null then
    raise exception 'Fill all five roles and the bench';
  end if;
  if (select count(distinct x) from unnest(p_players) x) <> 6 then raise exception 'Each player can only be picked once'; end if;
  if exists (select 1 from unnest(p_players) x left join fantasy_prices f on f.player_id = x where f.price is null) then
    raise exception 'One of those players can''t be picked';
  end if;
  select sum(f.price) into cost from unnest(p_players) x join fantasy_prices f on f.player_id = x;
  if cost > fantasy_budget() then raise exception 'That squad costs %, over the % budget', cost, fantasy_budget(); end if;

  insert into fantasy_teams (user_id, name) values (uid, coalesce(nullif(btrim(p_name), ''), a.display_name))
  on conflict (user_id) do update set name = coalesce(nullif(btrim(excluded.name), ''), fantasy_teams.name);
  delete from fantasy_picks where user_id = uid and gw = nxt;
  for i in 1..6 loop
    insert into fantasy_picks (user_id, gw, slot, player_id, captain, price)
    select uid, nxt, i, p_players[i], i = 1, price from fantasy_prices where player_id = p_players[i];
  end loop;
  return jsonb_build_object('gw', nxt, 'cost', cost, 'changes', fantasy_changes(uid, nxt));
end $$;

create or replace function public.fantasy_my_team()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); nxt date := fantasy_next_gw(); cur date;
begin
  if uid is null then return null; end if;
  select max(gw) into cur from fantasy_gws() where locks_at <= now();
  return jsonb_build_object(
    'name', (select name from fantasy_teams where user_id = uid),
    'budget', fantasy_budget(), 'hit', fantasy_hit(),
    'next_gw', nxt, 'locks_at', fantasy_lock(nxt), 'current_gw', cur,
    'squad', (select coalesce(jsonb_agg(jsonb_build_object('slot', s.slot, 'player_id', s.player_id,
                     'name', p.name, 'slug', p.slug, 'price', f.price) order by s.slot), '[]'::jsonb)
                from fantasy_squad(uid, coalesce(nxt, cur, fantasy_start())) s join players p on p.id = s.player_id
                left join fantasy_prices f on f.player_id = s.player_id),
    'previous', (select coalesce(jsonb_agg(s.player_id), '[]'::jsonb) from fantasy_squad(uid, coalesce(nxt, fantasy_start()) - 1) s),
    'first_squad', not exists (select 1 from fantasy_picks where user_id = uid and gw < coalesce(nxt, fantasy_start())),
    'history', (select coalesce(jsonb_agg(fantasy_team_points(uid, g.gw) order by g.gw desc), '[]'::jsonb)
                  from fantasy_gws() g where g.locks_at <= now() and exists (select 1 from fantasy_picks where user_id = uid and gw <= g.gw)));
end $$;
