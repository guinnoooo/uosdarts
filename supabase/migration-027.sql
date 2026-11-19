-- 027: UDUK and Franny team matches
--
-- A team match (a "fixture") is a tournament with kind 'uduk' or 'franny',
-- a home and an away team, and one match row per game in the format:
--
--   UDUK league: 2 trebles (Bo3, 701), 3 doubles (Bo3, 701), 6 singles (Bo3, 501)
--   UDUK cup:    9 singles (Bo5, 501), 4 doubles (Bo3, 701), 9 singles (Bo5, 501)
--   Franny:      5 singles (Bo5, 501), 2 doubles (Bo3, 701)
--
-- Anyone with the team match password (set on the super admin page) can start a
-- fixture, put players into each game and score the games. Our own teams
-- (Sheffield A/B/C for UDUK, Accy D's, Boobs and Slingers for Franny) can
-- pick players from the order of merit list in singles games, so those games
-- count towards their averages and stats. They never earn OoM points, as a
-- fixture doesn't count for the order of merit. Everyone else, and anyone in
-- doubles or trebles, is a typed name like in friendlies.
--
-- Safe to run more than once.

alter table public.tournaments add column if not exists kind text;
alter table public.tournaments drop constraint if exists tournaments_kind_check;
alter table public.tournaments add constraint tournaments_kind_check check (kind is null or kind in ('uduk', 'franny'));
alter table public.tournaments add column if not exists home_team text;
alter table public.tournaments add column if not exists away_team text;
alter table public.tournaments add column if not exists competition text;
alter table public.tournaments add column if not exists home_ours boolean not null default false;
alter table public.tournaments add column if not exists away_ours boolean not null default false;
alter table public.tournaments add column if not exists created_by uuid;

alter table public.matches add column if not exists game_type text;
alter table public.matches drop constraint if exists matches_game_type_check;
alter table public.matches add constraint matches_game_type_check
  check (game_type is null or game_type in ('singles', 'doubles', 'trebles'));
alter table public.matches add column if not exists game_label text;

-- ------------------------------------------------------------------ teams and passwords

-- Our own teams, whose singles players can be linked to the order of merit.
create or replace function public.our_teams(p_kind text) returns text[]
language sql immutable as $$
  select case p_kind
    when 'uduk'   then array['Sheffield A', 'Sheffield B', 'Sheffield C']
    when 'franny' then array['Accy D''s', 'Boobs', 'Slingers']
    else array[]::text[] end;
$$;
grant execute on function public.our_teams(text) to anon, authenticated;

-- One password, shared by UDUK and Franny, for starting and scoring team
-- matches. Clearing it switches both hubs off.
drop function if exists public.super_set_hub_password(text, text);
create or replace function public.super_set_hub_password(p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_password is null or btrim(p_password) = '' then
    delete from settings where key = 'hub_pw';
    return;
  end if;
  if length(btrim(p_password)) < 4 then raise exception 'Use at least 4 characters'; end if;
  insert into settings (key, value, updated_at)
  values ('hub_pw', crypt(btrim(p_password), gen_salt('bf')), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- p_kind is kept so the hubs could have a password each later; for now both use the same one.
create or replace function public.hub_enabled(p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_kind in ('uduk', 'franny') and exists (select 1 from settings where key = 'hub_pw');
$$;

create or replace function public.hub_pw_ok(p_kind text, p_password text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select p_kind in ('uduk', 'franny') and exists (
    select 1 from settings
     where key = 'hub_pw' and p_password is not null
       and crypt(btrim(p_password), value) = value
  );
$$;

-- ------------------------------------------------------------------ starting a fixture

create or replace function public.create_fixture(
  p_kind text, p_password text, p_home text, p_away text, p_competition text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  h text := btrim(coalesce(p_home, ''));
  a text := btrim(coalesce(p_away, ''));
  comp text := case when p_kind = 'uduk' then lower(coalesce(p_competition, '')) end;
  t uuid;
  plan jsonb;
  blk jsonb;
  i int;
  slot int := 0;
  counts jsonb := '{}'::jsonb;
  n int;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if p_kind not in ('uduk', 'franny') then raise exception 'Unknown hub'; end if;
  if not hub_enabled(p_kind) then raise exception 'Starting matches here is switched off at the moment'; end if;
  if not hub_pw_ok(p_kind, p_password) then raise exception 'Wrong password'; end if;
  if h = '' or a = '' then raise exception 'Enter both teams'; end if;
  if length(h) > 40 or length(a) > 40 then raise exception 'Team names can be up to 40 characters'; end if;
  if lower(h) = lower(a) then raise exception 'The two teams need different names'; end if;
  if p_kind = 'uduk' and comp not in ('league', 'cup') then raise exception 'Pick league or cup'; end if;
  if (select count(*) from tournaments where created_by = auth.uid() and kind is not null
        and created_at > now() - interval '1 hour') >= 6 then
    raise exception 'That''s a lot of matches in an hour. Try again later';
  end if;

  -- type, how many, start score, legs to win
  plan := case
    when p_kind = 'franny' then
      '[["singles",5,501,3],["doubles",2,701,2]]'
    when comp = 'league' then
      '[["trebles",2,701,2],["doubles",3,701,2],["singles",6,501,2]]'
    else
      '[["singles",9,501,3],["doubles",4,701,2],["singles",9,501,3]]'
  end::jsonb;

  insert into tournaments (name, format, status, starts_at, start_score, knockout_legs_to_win,
                           counts_for_oom, is_pc, is_friendly, requires_password, points_schedule,
                           kind, home_team, away_team, competition, home_ours, away_ours, created_by)
  values (h || ' v ' || a, 'knockout', 'upcoming', now(), 501, 2,
          false, false, false, true,
          '{"winner":0,"final":0,"semi":0,"quarter":0,"last_16":0,"last_32":0,"last_64":0,"groups":0}'::jsonb,
          p_kind, h, a, comp, h = any (our_teams(p_kind)), a = any (our_teams(p_kind)), auth.uid())
  returning id into t;

  for blk in select * from jsonb_array_elements(plan) loop
    for i in 1 .. (blk->>1)::int loop
      slot := slot + 1;
      n := coalesce((counts->>(blk->>0))::int, 0) + 1;
      counts := counts || jsonb_build_object(blk->>0, n);
      insert into matches (tournament_id, stage, round, slot, legs_to_win, start_score, game_type, game_label)
      values (t, 'knockout', 1, slot, (blk->>3)::int, (blk->>2)::int, blk->>0,
              initcap(blk->>0) || ' ' || n);
    end loop;
  end loop;
  return t;
end $$;

-- Put players into one game. Each side is a list of {"name": ...} or, for
-- one of our teams in a singles game, {"id": <player id>}. Only while the
-- game hasn't started.
create or replace function public.set_game_players(p_match uuid, p_password text, p_home jsonb, p_away jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  t tournaments;
  need int;
  side jsonb;
  k int;
  ids uuid[] := array[null, null]::uuid[];
  names text[] := array[null, null]::text[];
  e jsonb;
  pid uuid;
  nm text;
  parts text[];
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Game not found'; end if;
  select * into t from tournaments where id = m.tournament_id;
  if t.kind is null then raise exception 'Not a team match'; end if;
  if not hub_pw_ok(t.kind, p_password) and not is_admin() then raise exception 'Wrong password'; end if;
  if m.status <> 'pending' then raise exception 'This game has already started'; end if;
  need := case m.game_type when 'trebles' then 3 when 'doubles' then 2 else 1 end;

  for k in 1 .. 2 loop
    side := case k when 1 then p_home else p_away end;
    if side is null or jsonb_typeof(side) <> 'array' or jsonb_array_length(side) = 0 then
      continue;   -- leave that side empty for now
    end if;
    if jsonb_array_length(side) <> need then
      raise exception 'A % game needs % player%', m.game_type, need, case when need > 1 then 's' else '' end;
    end if;
    parts := array[]::text[];
    for e in select * from jsonb_array_elements(side) loop
      pid := nullif(e->>'id', '')::uuid;
      nm := btrim(coalesce(e->>'name', ''));
      if pid is not null then
        if need <> 1 or not (case k when 1 then t.home_ours else t.away_ours end) then
          raise exception 'Only our own teams'' singles players can be linked to the order of merit';
        end if;
        if not exists (select 1 from players where id = pid) then raise exception 'Player not found'; end if;
        ids[k] := pid;
      else
        if nm = '' then raise exception 'Enter every player''s name'; end if;
        if length(nm) > 40 then raise exception 'Names can be up to 40 characters'; end if;
        parts := parts || nm;
      end if;
    end loop;
    if ids[k] is null then names[k] := array_to_string(parts, ' & '); end if;
  end loop;

  update matches
     set player1_id = ids[1], p1_name = names[1],
         player2_id = ids[2], p2_name = names[2]
   where id = p_match;
  perform refresh_match_state(p_match);
end $$;

-- Give a player one of our teams picked an order of merit profile.
create or replace function public.add_hub_player(p_kind text, p_password text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  nm text := btrim(coalesce(p_name, ''));
  pid uuid;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if not hub_pw_ok(p_kind, p_password) and not is_admin() then raise exception 'Wrong password'; end if;
  if nm = '' then raise exception 'Give the player a name'; end if;
  if length(nm) > 40 then raise exception 'Names can be up to 40 characters'; end if;
  select id into pid from players where lower(name) = lower(nm);
  if pid is not null then return pid; end if;
  insert into players (name) values (nm) returning id into pid;
  return pid;
end $$;

-- Whoever started a fixture (or an admin) can scrap it.
create or replace function public.delete_fixture(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t tournaments;
begin
  select * into t from tournaments where id = p_tournament and kind is not null;
  if not found then raise exception 'Match not found'; end if;
  if t.created_by is distinct from auth.uid() and not is_admin() then
    raise exception 'Only whoever started it can delete this match';
  end if;
  delete from tournaments where id = p_tournament;
end $$;

-- ------------------------------------------------------------------ scoring

-- As in 019, plus: games in a fixture need that hub's password to take over.
create or replace function public.claim_match(p_match uuid, p_password text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
  h text;
  t tournaments;
begin
  if auth.uid() is null then raise exception 'You need to be signed in to score'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.status = 'complete' then raise exception 'This match has already finished'; end if;
  if (m.player1_id is null and m.p1_name is null) or (m.player2_id is null and m.p2_name is null) then
    raise exception 'Both players are not decided yet';
  end if;
  if m.scorer_id is not null and m.scorer_id <> auth.uid() then
    raise exception 'Someone is already scoring this match';
  end if;

  select * into t from tournaments where id = m.tournament_id;
  if m.scorer_id is distinct from auth.uid() then
    if t.is_friendly then
      if not friendly_pw_ok(p_password) then raise exception 'Wrong scoring password'; end if;
    elsif t.kind is not null then
      if not hub_pw_ok(t.kind, p_password) then raise exception 'Wrong scoring password'; end if;
    else
      select pw_hash into h from tournament_passwords where tournament_id = m.tournament_id;
      if h is not null then
        if p_password is null or btrim(p_password) = '' then
          raise exception 'This tournament needs a scoring password';
        end if;
        if crypt(btrim(p_password), h) <> h then
          raise exception 'Wrong scoring password';
        end if;
      end if;
    end if;
  end if;

  update matches set scorer_id = auth.uid() where id = p_match;
  perform refresh_match_state(m.id);
end $$;

-- A fixture is live once any game starts and finished when every game is.
create or replace function public.fixture_follow_games() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k text;
  total int;
  done int;
  started int;
begin
  if new.status is not distinct from old.status then return null; end if;
  select kind into k from tournaments where id = new.tournament_id;
  if k is null then return null; end if;
  select count(*), count(*) filter (where status = 'complete'), count(*) filter (where status <> 'pending')
    into total, done, started from matches where tournament_id = new.tournament_id;
  update tournaments
     set status = case when done = total then 'complete' when started > 0 then 'live' else 'upcoming' end
   where id = new.tournament_id;
  return null;
end $$;

drop trigger if exists matches_fixture on public.matches;
create trigger matches_fixture
after update of status on public.matches
for each row execute function public.fixture_follow_games();

-- Games won by each side, for cards and results.
create or replace view public.fixture_scores with (security_invoker = true) as
select m.tournament_id,
       count(*) as games,
       count(*) filter (where m.status = 'complete') as finished,
       count(*) filter (where m.status = 'live') as live,
       count(*) filter (where m.status = 'complete' and
         case when m.sets_to_win is not null then m.p1_sets > m.p2_sets else m.p1_legs > m.p2_legs end) as home_won,
       count(*) filter (where m.status = 'complete' and
         case when m.sets_to_win is not null then m.p2_sets > m.p1_sets else m.p2_legs > m.p1_legs end) as away_won
  from matches m
  join tournaments t on t.id = m.tournament_id and t.kind is not null
 group by m.tournament_id;
grant select on public.fixture_scores to anon, authenticated;

revoke execute on function public.super_set_hub_password(text)                         from public, anon;
revoke execute on function public.hub_pw_ok(text, text)                                from public, anon, authenticated;
revoke execute on function public.create_fixture(text, text, text, text, text)         from public, anon;
revoke execute on function public.set_game_players(uuid, text, jsonb, jsonb)           from public, anon;
revoke execute on function public.add_hub_player(text, text, text)                     from public, anon;
revoke execute on function public.delete_fixture(uuid)                                 from public, anon;
revoke execute on function public.fixture_follow_games()                               from public, anon, authenticated;
grant  execute on function public.super_set_hub_password(text)                         to authenticated;
grant  execute on function public.create_fixture(text, text, text, text, text)         to authenticated;
grant  execute on function public.set_game_players(uuid, text, jsonb, jsonb)           to authenticated;
grant  execute on function public.add_hub_player(text, text, text)                     to authenticated;
grant  execute on function public.delete_fixture(uuid)                                 to authenticated;
grant  execute on function public.hub_enabled(text)                                    to anon, authenticated;
