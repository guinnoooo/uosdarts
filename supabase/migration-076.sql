-- Migration 076: fantasy chips, player profile pages, and linking accounts
-- to player profiles.

------------------------------------------------------------------ chips
-- Three chips, each usable once a season: Triple Captain (captain scores
-- x3 instead of x2), Bench Boost (the bench player's points count too) and
-- Wildcard (any number of changes that week with no points taken off).
create table if not exists public.fantasy_chips (
  user_id uuid not null references public.accounts(user_id) on delete cascade,
  chip text not null check (chip in ('triple_captain', 'bench_boost', 'wildcard')),
  gw date not null,
  played_at timestamptz not null default now(),
  primary key (user_id, chip)
);
alter table public.fantasy_chips enable row level security;

create or replace function public.fantasy_chip_on(p_user uuid, p_gw date, p_chip text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from fantasy_chips where user_id = p_user and gw = p_gw and chip = p_chip);
$$;

-- Play a chip on the coming week. Only one chip a week.
create or replace function public.fantasy_play_chip(p_chip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); nxt date := fantasy_next_gw(); used date;
begin
  if uid is null then raise exception 'Log in to play'; end if;
  if p_chip not in ('triple_captain', 'bench_boost', 'wildcard') then raise exception 'Unknown chip'; end if;
  if nxt is null or fantasy_lock(nxt) <= now() then raise exception 'There''s no week open to play a chip on'; end if;
  if not exists (select 1 from fantasy_teams where user_id = uid) then raise exception 'Save a team first'; end if;
  select gw into used from fantasy_chips where user_id = uid and chip = p_chip;
  if used is not null then raise exception 'You''ve already used that chip'; end if;
  if exists (select 1 from fantasy_chips where user_id = uid and gw = nxt) then
    raise exception 'Only one chip a week. Cancel the other one first.';
  end if;
  if p_chip = 'wildcard' and not exists (select 1 from fantasy_picks where user_id = uid and gw < nxt) then
    raise exception 'Your first team is free anyway. Save the wildcard for later.';
  end if;
  insert into fantasy_chips (user_id, chip, gw) values (uid, p_chip, nxt);
  return jsonb_build_object('chip', p_chip, 'gw', nxt);
end $$;

-- Take a chip back, any time before the deadline.
create or replace function public.fantasy_cancel_chip(p_chip text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); g date;
begin
  if uid is null then raise exception 'Log in to play'; end if;
  select gw into g from fantasy_chips where user_id = uid and chip = p_chip;
  if g is null then raise exception 'That chip isn''t in use'; end if;
  if fantasy_lock(g) <= now() then raise exception 'That week has started, so the chip is used'; end if;
  delete from fantasy_chips where user_id = uid and chip = p_chip;
end $$;

-- A super admin changing chips by hand still gets fresh points.
create or replace function public.fantasy_bust_chips()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from fantasy_team_cache where user_id = coalesce(new.user_id, old.user_id) and gw = coalesce(new.gw, old.gw);
  return null;
end $$;
drop trigger if exists fantasy_chips_cache on public.fantasy_chips;
create trigger fantasy_chips_cache after insert or update or delete on public.fantasy_chips
  for each row execute function public.fantasy_bust_chips();

create or replace function public.fantasy_team_points(p_user uuid, p_gw date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cached jsonb;
  sq jsonb := '[]'::jsonb; total integer := 0; r record; pts integer; hits integer;
  b record; empty_slot integer; sub_pts integer := 0; sub_on boolean := false;
  tc boolean := fantasy_chip_on(p_user, p_gw, 'triple_captain');
  bb boolean := fantasy_chip_on(p_user, p_gw, 'bench_boost');
  wc boolean := fantasy_chip_on(p_user, p_gw, 'wildcard');
  boost integer := 0;
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
                then fantasy_role_points(r.slot, r.points, r.power, r.finish, r.dark, r.eu_points)
                     + case when r.slot = 1 and tc then coalesce(r.points, 0) else 0 end
                else 0 end;
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
    sub_pts := fantasy_role_points(empty_slot, b.points, b.power, b.finish, b.dark, b.eu_points)
               + case when empty_slot = 1 and tc then coalesce(b.points, 0) else 0 end;
    sub_on := true;
    total := total + sub_pts;
  elsif b.player_id is not null and bb and b.played then
    -- Bench Boost: the bench player's own points count as well.
    boost := coalesce(b.points, 0);
    total := total + boost;
  end if;

  hits := case when wc then 0 else greatest(0, fantasy_changes(p_user, p_gw) - 1) * fantasy_hit() end;
  cached := jsonb_build_object('gw', p_gw, 'starters', sq,
           'bench_player_id', b.player_id, 'bench_name', b.name, 'bench_slug', b.slug,
           'bench_points', case when sub_on then sub_pts else coalesce(b.points, 0) end,
           'bench_came_on', sub_on, 'bench_role', case when sub_on then fantasy_role(empty_slot) end,
           'bench_boost', boost,
           'chip', (select chip from fantasy_chips where user_id = p_user and gw = p_gw),
           'hits', hits, 'total', total - hits);
  if fantasy_lock(p_gw) <= now() then
    insert into fantasy_team_cache values (p_user, p_gw, cached) on conflict (user_id, gw) do update set data = excluded.data;
  end if;
  return cached;
end $$;

-- The team panel needs to know which chips are used and which is on.
create or replace function public.fantasy_my_chips()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(chip, gw), '{}'::jsonb) from fantasy_chips where user_id = auth.uid();
$$;

revoke all on function public.fantasy_play_chip(text) from public, anon;
revoke all on function public.fantasy_cancel_chip(text) from public, anon;
revoke all on function public.fantasy_my_chips() from public, anon;
grant execute on function public.fantasy_play_chip(text) to authenticated;
grant execute on function public.fantasy_cancel_chip(text) to authenticated;
grant execute on function public.fantasy_my_chips() to authenticated;

------------------------------------------------------- linking accounts
-- An account can be linked to the player it belongs to, for emailing
-- results and the like later. One account per player.
alter table public.accounts add column if not exists player_id uuid references public.players(id) on delete set null;
create unique index if not exists accounts_player_unique on public.accounts (player_id) where player_id is not null;

create or replace function public.super_link_account(p_user uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare other text;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_player is not null then
    select display_name into other from accounts where player_id = p_player and user_id <> p_user;
    if other is not null then raise exception 'That player is already linked to %', other; end if;
  end if;
  update accounts set player_id = p_player where user_id = p_user;
  if not found then raise exception 'Account not found'; end if;
end $$;
revoke all on function public.super_link_account(uuid, uuid) from public, anon;
grant execute on function public.super_link_account(uuid, uuid) to authenticated;

------------------------------------------------------- player profiles
-- Everything the player page shows, in one call.
create or replace function public.player_profile(p_slug text, p_season text default '2026/27')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p players; season_start date := make_date(left(p_season, 4)::int, 8, 1);
begin
  select * into p from players where slug = p_slug;
  if not found then return null; end if;
  return jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug, 'nickname', p.nickname, 'year', p.year),
    'career', (select to_jsonb(a) - 'player_id' - 'player_slug' from player_averages_for(array[p.id]) a),
    'stats', (select to_jsonb(s) - 'player_slug' - 'player_name' from player_stats(p_season) s where s.player_slug = p.slug),
    'oom', (select jsonb_build_object('rank', o.rank, 'points', o.total_points, 'events', o.events_scored)
              from oom_table(p_season, false) o where o.player_slug = p.slug),
    'pc_oom', (select jsonb_build_object('rank', o.rank, 'points', o.total_points)
                 from oom_table(p_season, true) o where o.player_slug = p.slug),
    -- One row per event this season: site events from the scored throws,
    -- other events (Darts Atlas and so on) from what was imported.
    'events', coalesce((select jsonb_agg(e order by e.day nulls first, e.name) from (
        select t.id::text as id, t.name, t.starts_at::date as day,
               case when t.is_major then 'major' when t.is_pc then 'pc' else 'event' end as kind,
               round(sum(v.score)::numeric / nullif(sum(v.darts), 0) * 3, 2) as avg,
               (select count(*) from matches m2 where m2.tournament_id = t.id and m2.status = 'complete'
                   and p.id in (coalesce(m2.player1_id, m2.counted_p1_id), coalesce(m2.player2_id, m2.counted_p2_id))) as played,
               (select count(*) from matches m2 where m2.tournament_id = t.id and m2.status = 'complete' and m2.winner_id = p.id) as won,
               (select op.reached from oom_points op where op.player_id = p.id and op.tournament_id = t.id limit 1) as reached,
               (select op.points from oom_points op where op.player_id = p.id and op.tournament_id = t.id limit 1) as points
          from tournaments t
          join matches m on m.tournament_id = t.id
          join visits v on v.match_id = m.id
               and ((v.player = 1 and coalesce(m.player1_id, m.counted_p1_id) = p.id)
                 or (v.player = 2 and coalesce(m.player2_id, m.counted_p2_id) = p.id))
         where t.deleted_at is null and t.season = p_season and not coalesce(t.is_friendly, false)
         group by t.id
        union all
        select 'x' || e.id, e.event, e.played_on, 'external', e.avg, null, null, null, null
          from external_events e where e.player_id = p.id and e.played_on >= season_start
        union all
        -- Order of merit events entered by hand, with no scoring on the site.
        select 'o' || op.id, op.event_name, null, case when op.is_major then 'major' when op.is_pc then 'pc' else 'event' end,
               null, null, null, op.reached, op.points
          from oom_points op where op.player_id = p.id and op.season = p_season and op.tournament_id is null
      ) e), '[]'::jsonb),
    -- The last 15 finished matches on the site.
    'matches', coalesce((select jsonb_agg(x order by x.at desc) from (
        select m.id, t.name as event, coalesce(m.finished_at, m.updated_at) as at,
               case when coalesce(m.player1_id, m.counted_p1_id) = p.id
                    then coalesce(p2.name, m.p2_name) else coalesce(p1.name, m.p1_name) end as opponent,
               case when coalesce(m.player1_id, m.counted_p1_id) = p.id then m.p1_legs else m.p2_legs end as legs_for,
               case when coalesce(m.player1_id, m.counted_p1_id) = p.id then m.p2_legs else m.p1_legs end as legs_against,
               m.winner_id = p.id as won,
               (select round(sum(v.score)::numeric / nullif(sum(v.darts), 0) * 3, 2) from visits v where v.match_id = m.id
                   and v.player = case when coalesce(m.player1_id, m.counted_p1_id) = p.id then 1 else 2 end) as avg
          from matches m
          join tournaments t on t.id = m.tournament_id and t.deleted_at is null
          left join players p1 on p1.id = coalesce(m.player1_id, m.counted_p1_id)
          left join players p2 on p2.id = coalesce(m.player2_id, m.counted_p2_id)
         where m.status = 'complete'
           and p.id in (coalesce(m.player1_id, m.counted_p1_id), coalesce(m.player2_id, m.counted_p2_id))
         order by coalesce(m.finished_at, m.updated_at) desc limit 15) x), '[]'::jsonb),
    'linked', case when is_super() then (select jsonb_build_object('name', a.display_name, 'email', a.email)
                                           from accounts a where a.player_id = p.id) end);
end $$;
grant execute on function public.player_profile(text, text) to anon, authenticated;

-- The accounts list shows who each account is linked to.
create or replace function public.super_list_accounts()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  perform apply_topups(null);
  return coalesce((
    select jsonb_agg(x order by x.created_at desc) from (
      select a.user_id, a.display_name, a.email, a.tokens, a.banned, a.created_at,
             a.player_id, pl.name as player_name,
             (select count(*) from bets b where b.user_id = a.user_id) as bets,
             (select count(*) from match_chat c where c.user_id = a.user_id) as messages
        from accounts a left join players pl on pl.id = a.player_id) x), '[]'::jsonb);
end $$;
