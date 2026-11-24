-- Speed.
--
-- 1. match_preview worked out each player's averages and form twice (once
--    per side). Now once. It runs when a match starts (the model snapshot)
--    and every time a match page opens, so this is on the scoring path.
--
-- 2. Fantasy points are cached. Working out a week's points reads every
--    visit in that week's events (about 20ms), and the leaderboard did that
--    four times per team per week. Now each week's player points are worked
--    out once and kept until something that changes them happens: a match in
--    that week finishing or being corrected, an event's result or details
--    changing, a pre-match chance arriving, or the scoring values changing.
--    Team totals are kept the same way. Scoring a visit never touches the
--    cache; only a match finishing (or being reopened) clears its week.

-- ------------------------------------------------------------ match_preview

create or replace function public.match_preview(p_match uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m matches;
  av jsonb;
  fm jsonb;
  res jsonb;
begin
  select * into m from matches where id = p_match;
  if not found or m.player1_id is null or m.player2_id is null then return null; end if;

  select coalesce(jsonb_object_agg(a.player_id, to_jsonb(a)), '{}'::jsonb) into av
    from player_averages_for(array[m.player1_id, m.player2_id]) a;
  select coalesce(jsonb_object_agg(f.player_id, to_jsonb(f)), '{}'::jsonb) into fm
    from player_form_for(array[m.player1_id, m.player2_id]) f;

  select jsonb_build_object(
    'p1', av -> m.player1_id::text,
    'p2', av -> m.player2_id::text,
    'p1_prov', (select provisional_avg from players where id = m.player1_id),
    'p2_prov', (select provisional_avg from players where id = m.player2_id),
    'p1_form', fm -> m.player1_id::text,
    'p2_form', fm -> m.player2_id::text,
    'p1_played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and m.player1_id in (x.player1_id, x.player2_id)
                     and x.player1_id is not null and x.player2_id is not null) + ext_played(m.player1_id),
    'p2_played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and m.player2_id in (x.player1_id, x.player2_id)
                     and x.player1_id is not null and x.player2_id is not null) + ext_played(m.player2_id),
    'p1_won',    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and x.winner_id = m.player1_id
                     and x.player1_id is not null and x.player2_id is not null) + ext_won(m.player1_id),
    'p2_won',    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and x.winner_id = m.player2_id
                     and x.player1_id is not null and x.player2_id is not null) + ext_won(m.player2_id),
    'h2h', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tournament', t.name,
               'date', coalesce(x.finished_at, t.starts_at),
               'p1_legs', case when x.player1_id = m.player1_id then x.p1_legs else x.p2_legs end,
               'p2_legs', case when x.player1_id = m.player1_id then x.p2_legs else x.p1_legs end,
               'p1_won', x.winner_id = m.player1_id)
             order by coalesce(x.finished_at, t.starts_at) desc)
        from matches x
        join tournaments t on t.id = x.tournament_id and t.deleted_at is null
       where x.status = 'complete' and x.id <> m.id
         and ((x.player1_id = m.player1_id and x.player2_id = m.player2_id)
           or (x.player1_id = m.player2_id and x.player2_id = m.player1_id))
    ), '[]'::jsonb) || ext_h2h(m.player1_id, m.player2_id)
  ) || coalesce(player_extra_json(m.player1_id, m.player2_id, now()), '{}'::jsonb) into res;
  return res;
end $$;

-- ------------------------------------------------------------ fantasy cache

create table if not exists public.fantasy_pp_cache (
  gw date not null,
  europa boolean not null,
  player_id uuid not null,
  played boolean, points integer, power integer, finish integer, dark integer, detail jsonb,
  primary key (gw, europa, player_id)
);
create table if not exists public.fantasy_pp_done (
  gw date not null,
  europa boolean not null,
  primary key (gw, europa)
);
create table if not exists public.fantasy_team_cache (
  user_id uuid not null,
  gw date not null,
  data jsonb not null,
  primary key (user_id, gw)
);
alter table public.fantasy_pp_cache enable row level security;
alter table public.fantasy_pp_done enable row level security;
alter table public.fantasy_team_cache enable row level security;

-- A week's player points, from the cache, working them out first if needed.
create or replace function public.fantasy_pp(p_gw date, p_europa boolean default false)
returns setof public.fantasy_pp_cache language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from fantasy_pp_done where gw = p_gw and europa = p_europa) then
    insert into fantasy_pp_cache
    select p_gw, p_europa, x.player_id, x.played, x.points, x.power, x.finish, x.dark, x.detail
      from fantasy_player_points(p_gw, p_europa) x
    on conflict do nothing;
    insert into fantasy_pp_done values (p_gw, p_europa) on conflict do nothing;
  end if;
  return query select * from fantasy_pp_cache where gw = p_gw and europa = p_europa;
end $$;

create or replace function public.fantasy_bust(p_gw date) returns void
language sql security definer set search_path = public as $$
  delete from fantasy_pp_done where gw = p_gw;
  delete from fantasy_pp_cache where gw = p_gw;
  delete from fantasy_team_cache where gw = p_gw;
$$;

create or replace function public.fantasy_bust_match() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform fantasy_bust(fantasy_gw_of(t.starts_at)) from tournaments t where t.id = new.tournament_id;
  return null;
end $$;
drop trigger if exists matches_fantasy_cache on public.matches;
create trigger matches_fantasy_cache
after update of status, winner_id, p1_legs, p2_legs, player1_id, player2_id, counted_p1_id, counted_p2_id on public.matches
for each row when (new.status = 'complete' or old.status = 'complete')
execute function public.fantasy_bust_match();

create or replace function public.fantasy_bust_tournament() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' then perform fantasy_bust(fantasy_gw_of(old.starts_at)); end if;
  if tg_op <> 'DELETE' then perform fantasy_bust(fantasy_gw_of(new.starts_at)); end if;
  return null;
end $$;
drop trigger if exists tournaments_fantasy_cache on public.tournaments;
create trigger tournaments_fantasy_cache
after update of status, champion_id, starts_at, deleted_at, is_pc, is_major, is_friendly, name on public.tournaments
for each row execute function public.fantasy_bust_tournament();

create or replace function public.fantasy_bust_odds() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform fantasy_bust(fantasy_gw_of(t.starts_at))
     from matches m join tournaments t on t.id = m.tournament_id where m.id = new.match_id;
  return null;
end $$;
drop trigger if exists match_odds_fantasy_cache on public.match_odds;
create trigger match_odds_fantasy_cache after insert or update on public.match_odds
for each row execute function public.fantasy_bust_odds();

create or replace function public.fantasy_bust_all() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from fantasy_pp_done; delete from fantasy_pp_cache; delete from fantasy_team_cache;
  return null;
end $$;
drop trigger if exists fantasy_scoring_cache on public.fantasy_scoring;
create trigger fantasy_scoring_cache after insert or update or delete on public.fantasy_scoring
for each statement execute function public.fantasy_bust_all();

-- A squad saved for a week changes that team's totals from that week on.
create or replace function public.fantasy_bust_picks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from fantasy_team_cache where user_id = coalesce(new.user_id, old.user_id) and gw >= coalesce(new.gw, old.gw);
  return null;
end $$;
drop trigger if exists fantasy_picks_cache on public.fantasy_picks;
create trigger fantasy_picks_cache after insert or update or delete on public.fantasy_picks
for each row execute function public.fantasy_bust_picks();

-- ------------------------------------------- fantasy functions on the cache

create or replace function public.fantasy_team_points(p_user uuid, p_gw date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cached jsonb;
  sq jsonb := '[]'::jsonb; total integer := 0; r record; pts integer; hits integer;
  b record; empty_slot integer; sub_pts integer := 0; sub_on boolean := false;
begin
  select data into cached from fantasy_team_cache where user_id = p_user and gw = p_gw;
  if cached is not null then return cached; end if;

  perform 1 from fantasy_pp(p_gw) limit 1;
  perform 1 from fantasy_pp(p_gw, true) limit 1;

  for r in
    select s.slot, s.player_id, p.name, p.slug,
           coalesce(pp.played, false) as played, coalesce(eu.played, false) as eu_played,
           pp.points, pp.power, pp.finish, pp.dark, pp.detail, eu.points as eu_points, eu.detail as eu_detail
      from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
      left join fantasy_pp_cache pp on pp.gw = p_gw and not pp.europa and pp.player_id = s.player_id
      left join fantasy_pp_cache eu on eu.gw = p_gw and eu.europa and eu.player_id = s.player_id
     where s.slot <= 5 order by s.slot
  loop
    pts := case when r.played or (r.slot = 5 and r.eu_played)
                then fantasy_role_points(r.slot, r.points, r.power, r.finish, r.dark, r.eu_points) else 0 end;
    if not (r.played or (r.slot = 5 and r.eu_played)) and empty_slot is null then empty_slot := r.slot; end if;
    sq := sq || jsonb_build_object('slot', r.slot, 'role', fantasy_role(r.slot), 'player_id', r.player_id, 'name', r.name,
                                   'slug', r.slug, 'played', r.played or (r.slot = 5 and r.eu_played),
                                   'base', coalesce(r.points, 0), 'points', pts, 'detail', r.detail,
                                   'europa', case when r.slot = 5 then coalesce(r.eu_points, 0) end,
                                   'europa_detail', case when r.slot = 5 then r.eu_detail end);
    total := total + pts;
  end loop;

  select s.player_id, p.name, p.slug, coalesce(pp.played, false) as played, coalesce(eu.played, false) as eu_played,
         pp.points, pp.power, pp.finish, pp.dark, eu.points as eu_points
    into b
    from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
    left join fantasy_pp_cache pp on pp.gw = p_gw and not pp.europa and pp.player_id = s.player_id
    left join fantasy_pp_cache eu on eu.gw = p_gw and eu.europa and eu.player_id = s.player_id
   where s.slot = 6;
  if b.player_id is not null and empty_slot is not null and (b.played or (empty_slot = 5 and b.eu_played)) then
    sub_pts := fantasy_role_points(empty_slot, b.points, b.power, b.finish, b.dark, b.eu_points);
    sub_on := true;
    total := total + sub_pts;
  end if;

  hits := greatest(0, fantasy_changes(p_user, p_gw) - 1) * fantasy_hit();
  cached := jsonb_build_object('gw', p_gw, 'starters', sq,
           'bench_player_id', b.player_id, 'bench_name', b.name, 'bench_slug', b.slug,
           'bench_points', case when sub_on then sub_pts else coalesce(b.points, 0) end,
           'bench_came_on', sub_on, 'bench_role', case when sub_on then fantasy_role(empty_slot) end,
           'hits', hits, 'total', total - hits);
  -- Only weeks that have locked are kept; an unlocked week's squad can still change.
  if fantasy_lock(p_gw) <= now() then
    insert into fantasy_team_cache values (p_user, p_gw, cached) on conflict (user_id, gw) do update set data = excluded.data;
  end if;
  return cached;
end $$;

create or replace function public.fantasy_market()
returns jsonb language plpgsql security definer set search_path = public as $$
declare g record; last_gw date;
begin
  select max(gw) into last_gw from fantasy_gws() where locks_at <= now();
  for g in select gw from fantasy_gws() where locks_at <= now() loop
    perform 1 from fantasy_pp(g.gw) limit 1;
  end loop;
  return (
    with pts as (
      select c.player_id, sum(c.points) as season, max(case when c.gw = last_gw then c.points end) as last
        from fantasy_pp_cache c where not c.europa and c.gw in (select gw from fantasy_gws() where locks_at <= now())
       group by c.player_id)
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug, 'price', f.price,
                      'season', coalesce(pts.season, 0), 'last', coalesce(pts.last, 0)) order by f.price desc, p.name), '[]'::jsonb)
      from fantasy_prices f join players p on p.id = f.player_id
      left join pts on pts.player_id = f.player_id
     where f.price is not null);
end $$;

create or replace function public.fantasy_leaderboard()
returns jsonb language plpgsql security definer set search_path = public as $$
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

create or replace function public.fantasy_my_team()
returns jsonb language plpgsql security definer set search_path = public as $$
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

create or replace function public.fantasy_team_view(p_user uuid, p_gw date)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_user is distinct from auth.uid() and coalesce(fantasy_lock(p_gw) > now(), true) then
    raise exception 'Teams are shown once the gameweek starts';
  end if;
  return fantasy_team_points(p_user, p_gw) || jsonb_build_object('name', (select name from fantasy_teams where user_id = p_user));
end $$;
