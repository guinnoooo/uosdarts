-- Migration 049: losers mark the next game on their own board.
--
-- Automatic board calls already queue every loser to mark a game, oldest
-- loss first. Two things made it look like the loser of a game wasn't the
-- one marking the next game on that board:
--
--   1. A player who was already down to mark a game when they lost (for
--      example, they played a game that wasn't called to a board while
--      their marking game was waiting) was queued again. When their marking
--      game finished they were picked again ahead of the player who had just
--      lost there, so they marked the same board twice. Everyone after them
--      then marked one call later, on a different board.
--      Now a loser who is already down to mark an unfinished game isn't
--      queued again: that game counts as their turn.
--
--   2. Among the queued losers, the one who lost on the board being called
--      is now picked first, so the loser stays at their board and marks
--      the next game there. Otherwise it's the oldest loss, as before.
--
-- If there are more games than losers, the rest is unchanged: first-round
-- byes who haven't marked yet, then anyone free at random.
--
-- Run after migration-025.sql. Safe to run more than once.
-- This changes live behaviour straight away, including for a tournament
-- that's in progress, so apply it between tournaments.

drop function if exists public.pick_referee(uuid, uuid);

create or replace function public.pick_referee(p_tournament uuid, p_match uuid, p_board text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  pick uuid;
begin
  select * into m from matches where id = p_match;

  -- 1. A free loser: whoever lost on this board first, then whoever lost
  --    longest ago.
  select q.player_id into pick
    from ref_queue q
   where q.tournament_id = p_tournament
     and q.player_id not in (coalesce(m.player1_id, '00000000-0000-0000-0000-000000000000'),
                             coalesce(m.player2_id, '00000000-0000-0000-0000-000000000000'))
     and not player_busy(p_tournament, q.player_id)
   order by exists (
              select 1 from matches f
               where f.tournament_id = p_tournament and p_board is not null and f.board = p_board
                 and f.status = 'complete' and f.winner_id is not null
                 and q.player_id in (f.player1_id, f.player2_id) and f.winner_id <> q.player_id) desc,
            q.queued_at
   limit 1;
  if pick is not null then
    delete from ref_queue where tournament_id = p_tournament and player_id = pick;
    return pick;
  end if;

  -- 2. A first-round bye who hasn't refereed in this tournament yet.
  select coalesce(b.player1_id, b.player2_id) into pick
    from matches b
   where b.tournament_id = p_tournament and b.stage = 'knockout' and b.round = 1
     and (b.player1_id is null) <> (b.player2_id is null)
     and coalesce(b.player1_id, b.player2_id) not in (coalesce(m.player1_id, '00000000-0000-0000-0000-000000000000'),
                                                     coalesce(m.player2_id, '00000000-0000-0000-0000-000000000000'))
     and not player_busy(p_tournament, coalesce(b.player1_id, b.player2_id))
     and not exists (select 1 from matches r where r.tournament_id = p_tournament
                        and r.referee_id = coalesce(b.player1_id, b.player2_id))
   order by random()
   limit 1;
  if pick is not null then return pick; end if;

  -- 3. Anyone entered who's free, at random. People with a match of their
  --    own ready to go are picked last, so a referee doesn't hold up a board.
  select tp.player_id into pick
    from tournament_players tp
   where tp.tournament_id = p_tournament
     and tp.player_id not in (coalesce(m.player1_id, '00000000-0000-0000-0000-000000000000'),
                              coalesce(m.player2_id, '00000000-0000-0000-0000-000000000000'))
     and not player_busy(p_tournament, tp.player_id)
   order by exists (
              select 1 from matches y
               where y.tournament_id = p_tournament and y.status = 'pending' and y.id <> p_match
                 and y.player1_id is not null and y.player2_id is not null
                 and tp.player_id in (y.player1_id, y.player2_id)),
            random()
   limit 1;
  return pick;   -- may be null if everyone is busy
end $$;

-- Same as migration 025, but tells pick_referee which board it's for.
create or replace function public.auto_board_calls(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t tournaments;
  b text;
  c matches;
  ref uuid;
  placed boolean;
begin
  select * into t from tournaments where id = p_tournament;
  if not found or not t.auto_boards or t.status <> 'live' or t.is_friendly then return; end if;
  -- One run at a time per tournament, so two results at once can't double-book a board.
  perform pg_advisory_xact_lock(hashtext('boards:' || p_tournament::text));

  foreach b in array t.boards loop
    continue when exists (
      select 1 from matches
       where tournament_id = p_tournament and board = b
         and (status = 'live' or (status = 'pending' and called_at is not null))
    );
    -- The earliest ready match whose players are both free and that has a
    -- referee available. If none has, the board stays free until someone
    -- frees up (any match finishing runs this again) or an admin calls one.
    placed := false;
    for c in
      select * from matches x
       where x.tournament_id = p_tournament and x.status = 'pending' and x.called_at is null
         and x.player1_id is not null and x.player2_id is not null
       order by case x.stage when 'group' then 0 else 1 end, x.round, x.slot
    loop
      continue when player_busy(p_tournament, c.player1_id) or player_busy(p_tournament, c.player2_id);
      ref := pick_referee(p_tournament, c.id, b);
      continue when ref is null;
      update matches
         set board = b, called_at = now(),
             referee_id = ref, referee_name = (select name from players where id = ref)
       where id = c.id;
      placed := true;
      exit;
    end loop;
    exit when not placed;   -- nothing callable now, so the worse boards won't do better
  end loop;

  -- Referees for anything called without one, best board first.
  for c in
    select x.* from matches x
     where x.tournament_id = p_tournament and x.status in ('pending', 'live')
       and x.called_at is not null and x.referee_id is null
     order by coalesce(array_position(t.boards, x.board), 999), x.called_at
  loop
    ref := pick_referee(p_tournament, c.id, c.board);
    exit when ref is null;
    update matches
       set referee_id = ref, referee_name = (select name from players where id = ref)
     where id = c.id;
  end loop;
end $$;

-- Queue the loser to mark, unless they're already down to mark a game that
-- hasn't finished; then refill the boards.
create or replace function public.matches_boards_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  loser uuid;
begin
  -- The calls made here update matches too; don't react to those.
  if pg_trigger_depth() > 1 then return null; end if;

  if new.status = 'complete' and old.status is distinct from 'complete'
     and new.player1_id is not null and new.player2_id is not null and new.winner_id is not null then
    loser := case when new.winner_id = new.player1_id then new.player2_id else new.player1_id end;
    if not exists (
      select 1 from matches r
       where r.tournament_id = new.tournament_id and r.id <> new.id and r.referee_id = loser
         and (r.status = 'live' or (r.status = 'pending' and r.called_at is not null))
    ) then
      insert into ref_queue (tournament_id, player_id)
      values (new.tournament_id, loser)
      on conflict do nothing;
    end if;
  end if;

  perform auto_board_calls(new.tournament_id);
  return null;
end $$;

revoke execute on function public.pick_referee(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.auto_board_calls(uuid)         from public, anon, authenticated;
revoke execute on function public.matches_boards_changed()       from public, anon, authenticated;
