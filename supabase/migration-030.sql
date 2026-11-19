-- 030: who throws first in UDUK and Franny games, and the UDUK cup decider
--
-- UDUK: the team that wins the bull off throws first in the odd numbered
-- games of the night (game 1, 3, 5 and so on, counting every game in order).
-- League: trebles 1, doubles 1 and 3, singles 2, 4 and 6.
-- Cup: singles 1, 3, 5, 7, 9, doubles 2 and 4, second set singles 2, 4, 6, 8.
-- Franny: no bull off. The away team throws first in the odd games
-- (singles 1, 3, 5 and doubles 2).
-- A UDUK cup match that finishes level gets a decider: one leg of 1001 with
-- each side's whole squad throwing, and the bull off winners throw first.
--
-- Run after migration-029.sql. Safe to run more than once.

alter table public.tournaments add column if not exists bull_winner smallint;
alter table public.tournaments drop constraint if exists tournaments_bull_winner_check;
alter table public.tournaments add constraint tournaments_bull_winner_check
  check (bull_winner is null or bull_winner in (1, 2));   -- 1 home, 2 away

alter table public.matches drop constraint if exists matches_game_type_check;
alter table public.matches add constraint matches_game_type_check
  check (game_type is null or game_type in ('singles', 'doubles', 'trebles', 'decider'));

-- Which side (1 home, 2 away) throws first in a team match game, or null
-- when it's down to whoever wins the bull (normal tournaments, or a UDUK
-- match whose bull off hasn't been entered yet).
create or replace function public.hub_first_thrower(p_match uuid) returns int
language sql stable security definer set search_path = public as $$
  select case
    when t.kind is null then null
    when m.game_type = 'decider' then t.bull_winner
    when t.kind = 'franny' then case when m.slot % 2 = 1 then 2 else 1 end
    when t.bull_winner is null then null
    when m.slot % 2 = 1 then t.bull_winner
    else 3 - t.bull_winner
  end::int
  from matches m join tournaments t on t.id = m.tournament_id
  where m.id = p_match;
$$;

-- Enter (or correct) who won the bull off in a UDUK match. It can be
-- changed until the first game starts, and filled in late if it was missed.
create or replace function public.set_fixture_bull(p_tournament uuid, p_password text, p_side int) returns void
language plpgsql security definer set search_path = public as $$
declare t tournaments;
begin
  select * into t from tournaments where id = p_tournament for update;
  if not found or t.kind is null then raise exception 'Match not found'; end if;
  if t.kind <> 'uduk' then raise exception 'Only UDUK matches have a bull off'; end if;
  if not fixture_pw_ok(t.id, p_password) and not is_admin() then raise exception 'Wrong password'; end if;
  if p_side not in (1, 2) then raise exception 'Pick the home or away team'; end if;
  if t.bull_winner is not null and t.bull_winner <> p_side
     and exists (select 1 from matches where tournament_id = t.id and status <> 'pending') then
    raise exception 'Games have already started, so the bull off can''t be changed now';
  end if;
  update tournaments set bull_winner = p_side where id = t.id;
end $$;

-- As before, but the throw in a team match game is set by the rules above.
create or replace function public.start_match(p_match uuid, p_first integer) returns void
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;
  if m.status <> 'pending' then raise exception 'Match has already started'; end if;
  p_first := coalesce(hub_first_thrower(p_match), p_first);
  if p_first is null or p_first not in (1, 2) then raise exception 'First thrower must be 1 or 2'; end if;

  update matches set status = 'live', started_at = now() where id = p_match;
  insert into legs (match_id, leg_no, starter) values (p_match, 1, p_first);
  update tournaments set status = 'live' where id = m.tournament_id and status = 'upcoming';
  perform refresh_match_state(p_match);
end $$;

-- A fixture is live once any game starts and finished when every game is.
-- A UDUK cup match that ends level gets a decider added, and loses it again
-- if a result is undone before the decider starts.
create or replace function public.fixture_follow_games() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t tournaments;
  total int;
  done int;
  started int;
  reg int;
  reg_done int;
  hw int;
  aw int;
begin
  if new.status is not distinct from old.status then return null; end if;
  select * into t from tournaments where id = new.tournament_id;
  if t.kind is null then return null; end if;

  if t.kind = 'uduk' and t.competition = 'cup' and new.game_type is distinct from 'decider' then
    select count(*), count(*) filter (where status = 'complete'),
           count(*) filter (where status = 'complete' and
             case when sets_to_win is not null then p1_sets > p2_sets else p1_legs > p2_legs end),
           count(*) filter (where status = 'complete' and
             case when sets_to_win is not null then p2_sets > p1_sets else p2_legs > p1_legs end)
      into reg, reg_done, hw, aw
      from matches where tournament_id = t.id and game_type is distinct from 'decider';
    if reg_done = reg and hw = aw then
      if not exists (select 1 from matches where tournament_id = t.id and game_type = 'decider') then
        insert into matches (tournament_id, stage, round, slot, legs_to_win, start_score,
                             game_type, game_label, p1_name, p2_name)
        values (t.id, 'knockout', 1, (select max(slot) + 1 from matches where tournament_id = t.id),
                1, 1001, 'decider', 'Decider', t.home_team, t.away_team);
      end if;
    else
      delete from matches d
       where d.tournament_id = t.id and d.game_type = 'decider' and d.status = 'pending'
         and not exists (select 1 from legs where match_id = d.id);
    end if;
  end if;

  select count(*), count(*) filter (where status = 'complete'), count(*) filter (where status <> 'pending')
    into total, done, started from matches where tournament_id = new.tournament_id;
  update tournaments
     set status = case when done = total then 'complete' when started > 0 then 'live' else 'upcoming' end
   where id = new.tournament_id;
  return null;
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
  if m.game_type = 'decider' then raise exception 'Both full squads play the decider, so there are no players to pick'; end if;
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

revoke execute on function public.hub_first_thrower(uuid) from public, anon;
revoke execute on function public.set_fixture_bull(uuid, text, int) from public, anon;
grant  execute on function public.hub_first_thrower(uuid) to anon, authenticated;
grant  execute on function public.set_fixture_bull(uuid, text, int) to authenticated;
revoke execute on function public.fixture_follow_games() from public, anon, authenticated;
