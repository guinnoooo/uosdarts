-- 029: a scoring password for each UDUK / Franny match
--
-- Whoever starts a team match now sets a scoring password for it. That one
-- password scores every game in the match and picks its players, so it can
-- be shared with the other team or a stand-in scorer. The team match
-- password (set on the super admin page) is still needed to start a match,
-- and also still works on every match as a master key. Matches started
-- before this have no password of their own and keep using the team one.
--
-- Run after migration-027.sql. Safe to run more than once.

-- True for the match's own password, or the team match password.
create or replace function public.fixture_pw_ok(p_tournament uuid, p_password text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select p_password is not null and (
    exists (select 1 from tournament_passwords tp
             where tp.tournament_id = p_tournament
               and crypt(btrim(p_password), tp.pw_hash) = tp.pw_hash)
    or hub_pw_ok((select kind from tournaments where id = p_tournament), p_password)
  );
$$;

drop function if exists public.create_fixture(text, text, text, text, text);
create or replace function public.create_fixture(
  p_kind text, p_password text, p_home text, p_away text, p_competition text default null,
  p_scoring_password text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
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
  if length(btrim(coalesce(p_scoring_password, ''))) < 4 then
    raise exception 'Set a scoring password for this match (at least 4 characters)';
  end if;
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

  -- The match's own scoring password, for every game in it.
  insert into tournament_passwords (tournament_id, pw_hash, updated_at)
  values (t, crypt(btrim(p_scoring_password), gen_salt('bf')), now());

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
  if not fixture_pw_ok(t.id, p_password) and not is_admin() then raise exception 'Wrong password'; end if;
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

drop function if exists public.add_hub_player(text, text, text);
create or replace function public.add_hub_player(p_kind text, p_password text, p_name text, p_tournament uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  nm text := btrim(coalesce(p_name, ''));
  pid uuid;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if not (hub_pw_ok(p_kind, p_password) or (p_tournament is not null and fixture_pw_ok(p_tournament, p_password)))
     and not is_admin() then
    raise exception 'Wrong password';
  end if;
  if nm = '' then raise exception 'Give the player a name'; end if;
  if length(nm) > 40 then raise exception 'Names can be up to 40 characters'; end if;
  select id into pid from players where lower(name) = lower(nm);
  if pid is not null then return pid; end if;
  insert into players (name) values (nm) returning id into pid;
  return pid;
end $$;

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
      if not fixture_pw_ok(t.id, p_password) then raise exception 'Wrong scoring password'; end if;
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

revoke execute on function public.fixture_pw_ok(uuid, text) from public, anon, authenticated;
revoke execute on function public.create_fixture(text, text, text, text, text, text) from public, anon;
revoke execute on function public.add_hub_player(text, text, text, uuid) from public, anon;
grant  execute on function public.create_fixture(text, text, text, text, text, text) to authenticated;
grant  execute on function public.add_hub_player(text, text, text, uuid) to authenticated;
