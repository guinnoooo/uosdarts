-- 034: venues for team matches, and editing a team match
--
-- Each UDUK or Franny match can have a venue (Crookes, Beehive, Springy or
-- anywhere typed in). update_fixture changes a match after it's been set
-- up: the teams, the venue, the start time, the scoring password, and for
-- UDUK the competition (which rebuilds the games, so only before any game
-- has started). It needs the team match password, the same one used to
-- start a match, or an admin.
--
-- Run after migration-033.sql. Safe to run more than once.

alter table public.tournaments add column if not exists venue text;
alter table public.tournaments drop constraint if exists tournaments_venue_check;
alter table public.tournaments add constraint tournaments_venue_check
  check (venue is null or length(venue) between 1 and 60);

-- The games in a team match: type, how many, start score, legs to win.
create or replace function public.fixture_plan(p_kind text, p_comp text) returns jsonb
language sql immutable as $$
  select case
    when p_kind = 'franny' then '[["singles",5,501,3],["doubles",2,701,2]]'
    when p_comp = 'league' then '[["trebles",2,701,2],["doubles",3,701,2],["singles",6,501,2]]'
    else '[["singles",9,501,3],["doubles",4,701,2],["singles",9,501,3]]'
  end::jsonb;
$$;

create or replace function public.fixture_add_games(p_tournament uuid, p_plan jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  blk jsonb;
  i int;
  slot int := 0;
  counts jsonb := '{}'::jsonb;
  n int;
begin
  for blk in select * from jsonb_array_elements(p_plan) loop
    for i in 1 .. (blk->>1)::int loop
      slot := slot + 1;
      n := coalesce((counts->>(blk->>0))::int, 0) + 1;
      counts := counts || jsonb_build_object(blk->>0, n);
      insert into matches (tournament_id, stage, round, slot, legs_to_win, start_score, game_type, game_label)
      values (p_tournament, 'knockout', 1, slot, (blk->>3)::int, (blk->>2)::int, blk->>0,
              initcap(blk->>0) || ' ' || n);
    end loop;
  end loop;
end $$;

drop function if exists public.create_fixture(text, text, text, text, text, text, timestamptz);
create or replace function public.create_fixture(
  p_kind text, p_password text, p_home text, p_away text, p_competition text default null,
  p_scoring_password text default null, p_starts_at timestamptz default null, p_venue text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  h text := btrim(coalesce(p_home, ''));
  a text := btrim(coalesce(p_away, ''));
  v text := nullif(btrim(coalesce(p_venue, '')), '');
  comp text := case when p_kind = 'uduk' then lower(coalesce(p_competition, '')) end;
  t uuid;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if p_kind not in ('uduk', 'franny') then raise exception 'Unknown hub'; end if;
  if not hub_enabled(p_kind) then raise exception 'Starting matches here is switched off at the moment'; end if;
  if not hub_pw_ok(p_kind, p_password) then raise exception 'Wrong password'; end if;
  if h = '' or a = '' then raise exception 'Enter both teams'; end if;
  if length(h) > 40 or length(a) > 40 then raise exception 'Team names can be up to 40 characters'; end if;
  if lower(h) = lower(a) then raise exception 'The two teams need different names'; end if;
  if p_kind = 'uduk' and comp not in ('league', 'cup') then raise exception 'Pick league or cup'; end if;
  if length(v) > 60 then raise exception 'Venue names can be up to 60 characters'; end if;
  if length(btrim(coalesce(p_scoring_password, ''))) < 4 then
    raise exception 'Set a scoring password for this match (at least 4 characters)';
  end if;
  if p_starts_at is not null and p_starts_at < now() - interval '1 hour' then
    raise exception 'That start time has already passed';
  end if;
  if p_starts_at is not null and p_starts_at > now() + interval '1 year' then
    raise exception 'Matches can be scheduled up to a year ahead';
  end if;
  if (select count(*) from tournaments where created_by = auth.uid() and kind is not null
        and created_at > now() - interval '1 hour') >= 6 then
    raise exception 'That''s a lot of matches in an hour. Try again later';
  end if;

  insert into tournaments (name, format, status, starts_at, start_score, knockout_legs_to_win,
                           counts_for_oom, is_pc, is_friendly, requires_password, points_schedule,
                           kind, home_team, away_team, competition, home_ours, away_ours, created_by, venue)
  values (h || ' v ' || a, 'knockout', 'upcoming', coalesce(p_starts_at, now()), 501, 2,
          false, false, false, true,
          '{"winner":0,"final":0,"semi":0,"quarter":0,"last_16":0,"last_32":0,"last_64":0,"groups":0}'::jsonb,
          p_kind, h, a, comp, h = any (our_teams(p_kind)), a = any (our_teams(p_kind)), auth.uid(), v)
  returning id into t;

  insert into tournament_passwords (tournament_id, pw_hash, updated_at)
  values (t, crypt(btrim(p_scoring_password), gen_salt('bf')), now());

  perform fixture_add_games(t, fixture_plan(p_kind, comp));
  return t;
end $$;

-- Change a team match. A blank scoring password or start time keeps the
-- current one. If a team stops being one of ours, any of its players linked
-- to the order of merit in games not yet played become plain names, so
-- nothing they throw counts towards their stats.
create or replace function public.update_fixture(
  p_tournament uuid, p_password text, p_home text, p_away text, p_competition text,
  p_venue text, p_scoring_password text default null, p_starts_at timestamptz default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  t tournaments;
  h text := btrim(coalesce(p_home, ''));
  a text := btrim(coalesce(p_away, ''));
  v text := nullif(btrim(coalesce(p_venue, '')), '');
  comp text;
  spw text := btrim(coalesce(p_scoring_password, ''));
  started boolean;
  h_ours boolean;
  a_ours boolean;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  select * into t from tournaments where id = p_tournament for update;
  if not found or t.kind is null or t.deleted_at is not null then raise exception 'Match not found'; end if;
  if not hub_pw_ok(t.kind, p_password) and not is_admin() then raise exception 'Wrong password'; end if;
  comp := case when t.kind = 'uduk' then lower(coalesce(p_competition, t.competition, '')) end;
  if h = '' or a = '' then raise exception 'Enter both teams'; end if;
  if length(h) > 40 or length(a) > 40 then raise exception 'Team names can be up to 40 characters'; end if;
  if lower(h) = lower(a) then raise exception 'The two teams need different names'; end if;
  if t.kind = 'uduk' and comp not in ('league', 'cup') then raise exception 'Pick league or cup'; end if;
  if length(v) > 60 then raise exception 'Venue names can be up to 60 characters'; end if;
  if spw <> '' and length(spw) < 4 then raise exception 'The scoring password needs at least 4 characters'; end if;

  started := exists (select 1 from matches where tournament_id = t.id and status <> 'pending');
  h_ours := h = any (our_teams(t.kind));
  a_ours := a = any (our_teams(t.kind));

  if comp is distinct from t.competition then
    if started then raise exception 'Games have already started, so the competition can''t be changed'; end if;
    delete from matches where tournament_id = t.id;
    perform fixture_add_games(t.id, fixture_plan(t.kind, comp));
  end if;

  if t.home_ours and not h_ours then
    if exists (select 1 from matches where tournament_id = t.id and status <> 'pending' and player1_id is not null) then
      raise exception '% have linked players in games already played, so the home team has to stay one of ours', t.home_team;
    end if;
    update matches m set p1_name = (select name from players where id = m.player1_id), player1_id = null
     where m.tournament_id = t.id and m.player1_id is not null;
  end if;
  if t.away_ours and not a_ours then
    if exists (select 1 from matches where tournament_id = t.id and status <> 'pending' and player2_id is not null) then
      raise exception '% have linked players in games already played, so the away team has to stay one of ours', t.away_team;
    end if;
    update matches m set p2_name = (select name from players where id = m.player2_id), player2_id = null
     where m.tournament_id = t.id and m.player2_id is not null;
  end if;

  if p_starts_at is not null and p_starts_at is distinct from t.starts_at then
    if t.status <> 'upcoming' then raise exception 'This match has already started, so its time can''t be changed'; end if;
    if p_starts_at < now() - interval '1 hour' then raise exception 'That start time has already passed'; end if;
    if p_starts_at > now() + interval '1 year' then raise exception 'Matches can be scheduled up to a year ahead'; end if;
  end if;

  update tournaments
     set home_team = h, away_team = a, name = h || ' v ' || a, competition = comp,
         home_ours = h_ours, away_ours = a_ours, venue = v,
         starts_at = coalesce(p_starts_at, starts_at)
   where id = t.id;

  -- The cup decider is played by the two teams themselves.
  update matches set p1_name = h, p2_name = a where tournament_id = t.id and game_type = 'decider';

  if spw <> '' then
    insert into tournament_passwords (tournament_id, pw_hash, updated_at)
    values (t.id, crypt(spw, gen_salt('bf')), now())
    on conflict (tournament_id) do update set pw_hash = excluded.pw_hash, updated_at = now();
  end if;
end $$;

revoke execute on function public.fixture_add_games(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.create_fixture(text, text, text, text, text, text, timestamptz, text) from public, anon;
revoke execute on function public.update_fixture(uuid, text, text, text, text, text, text, timestamptz) from public, anon;
grant  execute on function public.create_fixture(text, text, text, text, text, text, timestamptz, text) to authenticated;
grant  execute on function public.update_fixture(uuid, text, text, text, text, text, text, timestamptz) to authenticated;
