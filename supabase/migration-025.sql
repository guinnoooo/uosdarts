-- 025: only call a match when it has a referee
--
-- Automatic board calls now only put a match on a board if someone is free
-- to referee it. In a small field (say 5 players with two boards, so 4
-- playing and 1 refereeing) the second match waits. It's called as soon as
-- someone frees up, or an admin can call it by hand. Matches called by hand
-- still get a referee as soon as one is free.
--
-- Run after migration-024.sql. Safe to run more than once.

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
      ref := pick_referee(p_tournament, c.id);
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
    ref := pick_referee(p_tournament, c.id);
    exit when ref is null;
    update matches
       set referee_id = ref, referee_name = (select name from players where id = ref)
     where id = c.id;
  end loop;
end $$;

revoke execute on function public.auto_board_calls(uuid) from public, anon, authenticated;
