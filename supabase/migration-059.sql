-- Fantasy darts.
--
-- Each account picks five starters and one bench player within a budget,
-- and a captain whose points count double. A gameweek is a Monday-to-Sunday
-- week with at least one PC or major in it. Squads lock when the first of
-- those starts; changes after that apply to the next gameweek. If a starter
-- plays no match in a counted event that week, the bench player comes in.
-- One free change a week; each extra one costs 4 points. Prices are set by
-- a super admin and move a little each week with form.
--
-- Points per match in a PC or major: 2 for a win, 1 per leg won, 3 per 180,
-- 5 per 100+ checkout, 1 for averaging 50+ (2 for 60+). Winning the event
-- adds 10, runner-up 5. Only live-scored games have 180s, checkouts and
-- averages; a result entered by hand still gives the win and legs.

create table if not exists public.fantasy_prices (
  player_id uuid primary key references public.players(id) on delete cascade,
  suggested numeric(4,1),
  price numeric(4,1) check (price is null or price between 1 and 30),
  updated_at timestamptz not null default now()
);

create table if not exists public.fantasy_teams (
  user_id uuid primary key references public.accounts(user_id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 30),
  created_at timestamptz not null default now()
);

-- A squad applies from its gameweek until a later one replaces it.
create table if not exists public.fantasy_picks (
  user_id uuid not null references public.accounts(user_id) on delete cascade,
  gw date not null,
  slot smallint not null check (slot between 1 and 6),   -- 6 is the bench
  player_id uuid not null references public.players(id) on delete cascade,
  captain boolean not null default false,
  price numeric(4,1) not null,
  primary key (user_id, gw, slot)
);

-- Gameweeks already repriced, so the weekly job only does each once.
create table if not exists public.fantasy_repriced (
  gw date primary key,
  done_at timestamptz not null default now()
);

alter table public.fantasy_prices enable row level security;
alter table public.fantasy_teams enable row level security;
alter table public.fantasy_picks enable row level security;
alter table public.fantasy_repriced enable row level security;

create or replace function public.fantasy_budget() returns numeric language sql immutable as $$ select 50.0 $$;
create or replace function public.fantasy_hit() returns integer language sql immutable as $$ select 4 $$;
create or replace function public.fantasy_start() returns date language sql immutable as $$ select date '2026-11-30' $$;

create or replace function public.fantasy_gw_of(p_at timestamptz) returns date
language sql stable as $$ select date_trunc('week', p_at at time zone 'Europe/London')::date $$;

-- Counted events: PCs and majors, not friendlies or team matches.
create or replace function public.fantasy_events(p_gw date)
returns setof public.tournaments language sql stable security definer set search_path = public as $$
  select t.* from tournaments t
   where t.deleted_at is null and not t.is_friendly and t.kind is null and (t.is_pc or t.is_major)
     and t.status <> 'cancelled' and fantasy_gw_of(t.starts_at) = p_gw;
$$;

-- When a gameweek's squads lock: its first event's start, or its first
-- match going live if that's earlier. Null for a week with no events.
create or replace function public.fantasy_lock(p_gw date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select least(min(t.starts_at), (select min(m.started_at) from matches m where m.tournament_id in (select id from fantasy_events(p_gw))))
    from fantasy_events(p_gw) t;
$$;

-- Every gameweek from the start with at least one event, in order.
create or replace function public.fantasy_gws() returns table(gw date, locks_at timestamptz)
language sql stable security definer set search_path = public as $$
  select g, fantasy_lock(g) from (
    select distinct fantasy_gw_of(t.starts_at) g from tournaments t
     where t.deleted_at is null and not t.is_friendly and t.kind is null and (t.is_pc or t.is_major)
       and t.status <> 'cancelled' and fantasy_gw_of(t.starts_at) >= fantasy_start()) x
  order by g;
$$;

-- The gameweek squads are being picked for now.
create or replace function public.fantasy_next_gw() returns date
language sql stable security definer set search_path = public as $$
  select gw from fantasy_gws() where locks_at > now() order by gw limit 1;
$$;

-- The squad a team has for a gameweek (the latest one saved for it or before).
create or replace function public.fantasy_squad(p_user uuid, p_gw date)
returns setof public.fantasy_picks language sql stable security definer set search_path = public as $$
  select * from fantasy_picks
   where user_id = p_user and gw = (select max(gw) from fantasy_picks where user_id = p_user and gw <= p_gw);
$$;

-- Changes made for a gameweek: players in its squad who weren't in the one before.
create or replace function public.fantasy_changes(p_user uuid, p_gw date) returns integer
language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from fantasy_picks where user_id = p_user and gw = p_gw) then 0
    when not exists (select 1 from fantasy_picks where user_id = p_user and gw < p_gw) then 0
    else (select count(*)::int from fantasy_picks n
           where n.user_id = p_user and n.gw = p_gw
             and n.player_id not in (select player_id from fantasy_squad(p_user, p_gw - 1)))
  end;
$$;

-- Each player's points for a gameweek, with what they came from.
create or replace function public.fantasy_player_points(p_gw date)
returns table(player_id uuid, played boolean, points integer, detail jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (select id, champion_id, status from fantasy_events(p_gw)),
  ms as (
    select m.*, coalesce(m.player1_id, m.counted_p1_id) as a, coalesce(m.player2_id, m.counted_p2_id) as b
      from matches m join ev on ev.id = m.tournament_id
     where m.status = 'complete' and m.winner_id is not null
       and (m.player1_id is not null or m.counted_p1_id is not null or m.p1_name is not null)
       and (m.player2_id is not null or m.counted_p2_id is not null or m.p2_name is not null)),
  side as (
    select ms.id as match_id, ms.tournament_id, 1 as s, ms.a as pid, ms.p1_legs as legs,
           ms.winner_id = ms.a as won, ms.next_match_id is null and ms.stage = 'knockout' as final
      from ms where ms.a is not null
    union all
    select ms.id, ms.tournament_id, 2, ms.b, ms.p2_legs, ms.winner_id = ms.b, ms.next_match_id is null and ms.stage = 'knockout'
      from ms where ms.b is not null),
  vis as (
    select v.match_id, v.player as s,
           count(*) filter (where v.score = 180 and not v.is_bust) as tons180,
           count(*) filter (where v.remaining = 0 and v.score >= 100 and not v.is_bust) as big_out,
           case when sum(v.darts) > 0 then sum(v.score)::numeric / sum(v.darts) * 3 end as avg
      from visits v where v.match_id in (select id from ms)
     group by v.match_id, v.player),
  per as (
    select x.pid, x.tournament_id, x.won, x.final, coalesce(x.legs, 0) as legs,
           coalesce(v.tons180, 0) as t180, coalesce(v.big_out, 0) as bigout, v.avg
      from side x left join vis v on v.match_id = x.match_id and v.s = x.s),
  agg as (
    select pid,
           count(*) filter (where won) as wins, sum(legs) as legs, sum(t180) as t180, sum(bigout) as bigout,
           count(*) filter (where avg >= 60) as avg60, count(*) filter (where avg >= 50 and avg < 60) as avg50,
           (select count(*) from ev where ev.champion_id = per.pid and ev.status = 'complete') as titles,
           count(*) filter (where final and not won) as finals_lost
      from per group by pid)
  select pid, true,
         (2 * wins + legs + 3 * t180 + 5 * bigout + 2 * avg60 + avg50 + 10 * titles + 5 * finals_lost)::int,
         jsonb_build_object('wins', wins, 'legs', legs, '180s', t180, '100+ outs', bigout,
                            '60+ avg', avg60, '50+ avg', avg50, 'titles', titles, 'runner-up', finals_lost)
    from agg;
$$;

-- A team's points for a gameweek: starters (bench in for the first starter
-- who didn't play), captain doubled, less any change hits.
create or replace function public.fantasy_team_points(p_user uuid, p_gw date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  sq jsonb; total integer := 0; sub_done boolean := false; bench_id uuid; r record; pts integer; played boolean;
  hits integer;
begin
  select player_id into bench_id from fantasy_squad(p_user, p_gw) where slot = 6;
  sq := '[]'::jsonb;
  for r in
    select s.slot, s.player_id, s.captain, p.name, coalesce(pp.points, 0) as pts, coalesce(pp.played, false) as played, pp.detail
      from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
      left join fantasy_player_points(p_gw) pp on pp.player_id = s.player_id
     order by s.slot
  loop
    if r.slot = 6 then continue; end if;
    pts := r.pts * case when r.captain and r.played then 2 else 1 end;
    sq := sq || jsonb_build_object('slot', r.slot, 'player_id', r.player_id, 'name', r.name, 'captain', r.captain,
                                   'played', r.played, 'points', pts, 'detail', r.detail);
    total := total + pts;
  end loop;
  -- The bench player comes on for the first starter who didn't play.
  if bench_id is not null and exists (select 1 from jsonb_array_elements(sq) x where not (x->>'played')::boolean) then
    select coalesce(pp.points, 0), coalesce(pp.played, false) into pts, played
      from (select 1) z left join fantasy_player_points(p_gw) pp on pp.player_id = bench_id;
    if played then
      total := total + pts;
      sub_done := true;
    end if;
  end if;
  hits := greatest(0, fantasy_changes(p_user, p_gw) - 1) * fantasy_hit();
  return jsonb_build_object('gw', p_gw, 'starters', sq, 'bench_player_id', bench_id,
           'bench_name', (select name from players where id = bench_id),
           'bench_points', coalesce((select points from fantasy_player_points(p_gw) where player_id = bench_id), 0),
           'bench_came_on', sub_done, 'hits', hits, 'total', total - hits);
end $$;

-- Players to pick from: priced ones, with season points and last week's.
create or replace function public.fantasy_market()
returns jsonb language sql stable security definer set search_path = public as $$
  with done as (select gw from fantasy_gws() where locks_at <= now()),
  pts as (select pp.player_id, sum(pp.points) as season, max(case when d.gw = (select max(gw) from done) then pp.points end) as last
            from done d cross join lateral fantasy_player_points(d.gw) pp group by pp.player_id)
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price', f.price,
                    'season', coalesce(pts.season, 0), 'last', coalesce(pts.last, 0)) order by f.price desc, p.name), '[]'::jsonb)
    from fantasy_prices f join players p on p.id = f.player_id
    left join pts on pts.player_id = f.player_id
   where f.price is not null;
$$;

-- The signed-in user's team: the squad being picked, its cost, the changes
-- so far, and each past gameweek's points.
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
    'squad', (select coalesce(jsonb_agg(jsonb_build_object('slot', s.slot, 'player_id', s.player_id, 'captain', s.captain,
                     'name', p.name, 'price', f.price) order by s.slot), '[]'::jsonb)
                from fantasy_squad(uid, coalesce(nxt, cur, fantasy_start())) s join players p on p.id = s.player_id
                left join fantasy_prices f on f.player_id = s.player_id),
    'previous', (select coalesce(jsonb_agg(s.player_id), '[]'::jsonb) from fantasy_squad(uid, coalesce(nxt, fantasy_start()) - 1) s),
    'first_squad', not exists (select 1 from fantasy_picks where user_id = uid and gw < coalesce(nxt, fantasy_start())),
    'history', (select coalesce(jsonb_agg(fantasy_team_points(uid, g.gw) order by g.gw desc), '[]'::jsonb)
                  from fantasy_gws() g where g.locks_at <= now() and exists (select 1 from fantasy_picks where user_id = uid and gw <= g.gw)));
end $$;

create or replace function public.fantasy_save(p_name text, p_players uuid[], p_captain uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); a accounts; nxt date := fantasy_next_gw(); cost numeric; i integer;
begin
  if uid is null then raise exception 'Log in to play'; end if;
  select * into a from accounts where user_id = uid;
  if not found then raise exception 'Confirm your email to play'; end if;
  if a.banned then raise exception 'Your account is blocked'; end if;
  if nxt is null then raise exception 'There''s no PC or major coming up to pick a team for'; end if;
  if coalesce(array_length(p_players, 1), 0) <> 6 then raise exception 'Pick five starters and a bench player'; end if;
  if (select count(distinct x) from unnest(p_players) x) <> 6 then raise exception 'Each player can only be picked once'; end if;
  if p_captain is null or not (p_captain = any (p_players[1:5])) then raise exception 'Pick a captain from your starting five'; end if;
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
    select uid, nxt, i, p_players[i], p_players[i] = p_captain and i <= 5, price from fantasy_prices where player_id = p_players[i];
  end loop;
  return jsonb_build_object('gw', nxt, 'cost', cost, 'changes', fantasy_changes(uid, nxt));
end $$;

-- Season standings, plus the latest gameweek that has locked.
create or replace function public.fantasy_leaderboard()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare cur date;
begin
  select max(gw) into cur from fantasy_gws() where locks_at <= now();
  return coalesce((
    select jsonb_agg(x order by x.total desc, x.name) from (
      select t.user_id, t.name, a.display_name as manager, t.user_id = auth.uid() as me,
             coalesce((select sum((fantasy_team_points(t.user_id, g.gw)->>'total')::int)
                         from fantasy_gws() g where g.locks_at <= now()
                          and exists (select 1 from fantasy_picks where user_id = t.user_id and gw <= g.gw)), 0) as total,
             case when cur is not null and exists (select 1 from fantasy_picks where user_id = t.user_id and gw <= cur)
                  then (fantasy_team_points(t.user_id, cur)->>'total')::int end as week
        from fantasy_teams t join accounts a on a.user_id = t.user_id
       where not a.banned) x), '[]'::jsonb);
end $$;

-- Anyone's team for a gameweek that has locked (so squads stay secret until then).
create or replace function public.fantasy_team_view(p_user uuid, p_gw date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_user is distinct from auth.uid() and coalesce(fantasy_lock(p_gw) > now(), true) then
    raise exception 'Teams are shown once the gameweek starts';
  end if;
  return fantasy_team_points(p_user, p_gw) || jsonb_build_object('name', (select name from fantasy_teams where user_id = p_user));
end $$;

-- Weekly form changes, once per finished gameweek: the top fifth of scorers
-- among priced players rise 0.2, the next fifth 0.1; the bottom fifth drop
-- 0.2, the next 0.1. Priced players who didn't play drop 0.1. Prices stay
-- between 4.0 and 14.0.
create or replace function public.fantasy_reprice_due()
returns jsonb language plpgsql security definer set search_path = public as $$
declare g record; moved jsonb := '[]'::jsonb;
begin
  for g in select gw from fantasy_gws()
            where gw + 7 <= (now() at time zone 'Europe/London')::date
              and gw not in (select gw from fantasy_repriced)
              and not exists (select 1 from fantasy_events(gw) e where e.status <> 'complete' and e.status <> 'cancelled')
            order by gw
  loop
    with pts as (
      select f.player_id, pp.points, pp.played,
             percent_rank() over (order by pp.points) as pr
        from fantasy_prices f left join fantasy_player_points(g.gw) pp on pp.player_id = f.player_id
       where f.price is not null and pp.played),
    delta as (
      select f.player_id, f.price as old,
             case when p.player_id is null then -0.1
                  when p.pr >= 0.8 then 0.2 when p.pr >= 0.6 then 0.1
                  when p.pr < 0.2 then -0.2 when p.pr < 0.4 then -0.1 else 0 end as d
        from fantasy_prices f left join pts p on p.player_id = f.player_id
       where f.price is not null),
    upd as (
      update fantasy_prices f set price = least(14.0, greatest(4.0, f.price + d.d)), updated_at = now()
        from delta d where d.player_id = f.player_id and d.d <> 0
               and least(14.0, greatest(4.0, f.price + d.d)) <> f.price
      returning f.player_id, d.old, f.price)
    select moved || coalesce(jsonb_agg(jsonb_build_object('gw', g.gw, 'name', p.name, 'from', u.old, 'to', u.price)), '[]'::jsonb)
      into moved from upd u join players p on p.id = u.player_id;
    insert into fantasy_repriced (gw) values (g.gw);
  end loop;
  return moved;
end $$;
revoke execute on function public.fantasy_reprice_due() from public, anon, authenticated;

-- ------------------------------------------------------------ super admin

create or replace function public.super_fantasy_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'suggested', f.suggested, 'price', f.price,
                   'picked', (select count(*) from fantasy_teams t
                               where exists (select 1 from fantasy_squad(t.user_id, coalesce(fantasy_next_gw(), fantasy_start())) s
                                              where s.player_id = p.id)))
                   order by coalesce(f.price, f.suggested) desc nulls last, p.name)
                     from fantasy_prices f join players p on p.id = f.player_id), '[]'::jsonb);
end $$;

-- { "<player id>": 9.5 | null, ... }. Adds the player if they aren't listed.
create or replace function public.super_fantasy_set_prices(p_prices jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare k text; v numeric; n integer := 0;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  for k, v in select key, nullif(value #>> '{}', '')::numeric from jsonb_each(p_prices) loop
    if v is not null and (v < 1 or v > 30) then raise exception 'Prices go from 1.0 to 30.0'; end if;
    insert into fantasy_prices (player_id, price) values (k::uuid, round(v, 1))
    on conflict (player_id) do update set price = excluded.price, updated_at = now()
      where fantasy_prices.price is distinct from excluded.price;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Suggested prices from how the model rates each player who has played a
-- PC or major this season (Aidan Garratt lifted to 8.0). A super admin sets
-- the real prices; nobody can be picked until they have one.
insert into public.fantasy_prices (player_id, suggested)
select p.id, s.value::numeric from jsonb_each_text('{"Lewis Forrest":12.5,"Luke Davies":12.0,"Mikey Guinness":12.0,"Oli Graham":12.0,"Dan Wells":11.5,"Matt Watts":11.0,"Adam Khalil":10.5,"Luke Egan":10.5,"Joel Keaney":10.0,"Matt Duke":10.0,"Max Halder":9.5,"Barney Chaudhry":9.0,"Liam English":9.0,"Ben O''Callaghan":8.5,"Jack Warby":8.5,"Joseph D''Ambrosio":8.5,"Dan Buckley":8.5,"Rory Peach":8.0,"James Lauer":8.0,"James Beer":7.5,"Cian Hughes":7.5,"Dan Campbell":7.5,"Tom Sibley":7.0,"Evan Buxton":7.0,"Iwan James":7.0,"Ed Browne":7.0,"Alfie Mortimer":7.0,"Sam Tookey":6.5,"Aidan Garratt":8.0,"Finley Bowden":6.5,"Aidan Wood":6.5,"James Phillips":6.5,"Adam Butcher":6.5,"Harvey Simpson":6.5,"Oli Makin":6.5,"George Burton":6.5,"Luke Lavery":6.5,"Matt Hawkins":6.0,"Danny Hartland":6.0,"Jude Cockin":6.0,"Ben Clarke":6.0,"Mike Britland":6.0,"Finley Jackson":6.0,"Leila Mitchell":6.0,"Ben Browne":6.0,"Thomas Batho":6.0,"Jack Vicars":6.0,"Jono Blatch":5.5,"Alex Vienna":5.5,"Ollie Preece":5.5,"Freddie Taylor":5.5,"James Payne":5.0,"Max Cutler":5.0,"Harvey Richards":5.0,"Archie Shelbourne":5.0,"Jack Redfern":5.0,"Jack Hawley":5.0,"Ethan Warren":5.0,"Callum Ellis":5.0,"Sam Oddy":5.0,"Ruben Parker":5.0,"Seth Cluewes":5.0,"Max Browne":5.0,"Oliver Pratt":5.0,"Lewis Collet":4.5,"Quinn Collins":4.5,"Nathan Barrow":4.5,"Tom Ainger":4.5,"Michael Davy":4.0,"Henry Gascoigne":4.0,"Oliver Shaw":4.0}'::jsonb) s
  join public.players p on p.name = s.key
on conflict (player_id) do update set suggested = excluded.suggested;
