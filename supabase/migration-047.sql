-- Migration 047: adding a player to a knockout after it has started.
--
-- Only when there's a game for them to fit into:
--   1. Someone with a first-round bye whose next match hasn't been called,
--      claimed by a scorer or started. Their bye is reopened as a real
--      match against the new player, and the winner goes through as before.
--   2. If the draw has no byes at all (a full bracket), a first-round match
--      that hasn't been called, claimed or started. A preliminary round is
--      added in front of the bracket: the chosen player plays the new player
--      in it, and everyone else gets a bye through it.
-- If the draw has byes but none can be used (their next matches have
-- started), there's no space and the player can't be added.
-- With no opponent given (p_opponent null), one is picked at random in that
-- order: a random usable bye first, otherwise a random player from a free
-- first-round match.

create or replace function public.admin_add_late_player(p_tournament uuid, p_player uuid, p_opponent uuid default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  t tournaments;
  b matches;
  g matches;
  m matches;
  s matches;
  nr int;
  legs int;
  side int;
  pid uuid;
  mine boolean;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select * into t from tournaments where id = p_tournament for update;
  if not found or t.deleted_at is not null then raise exception 'Tournament not found'; end if;
  if t.format <> 'knockout' or t.status = 'complete' then
    raise exception 'Players can only be added late to a knockout that is still running';
  end if;
  if not exists (select 1 from matches where tournament_id = p_tournament and stage = 'knockout') then
    raise exception 'Draw the fixtures first';
  end if;
  if p_player is null then raise exception 'Pick the new player'; end if;
  if exists (select 1 from tournament_players where tournament_id = p_tournament and player_id = p_player) then
    raise exception 'They are already in this tournament';
  end if;

  if p_opponent is null then
    select coalesce(x.player1_id, x.player2_id) into p_opponent
      from matches x join matches nx on nx.id = x.next_match_id
     where x.tournament_id = p_tournament and x.stage = 'knockout' and x.round = 1 and x.status = 'complete'
       and (x.player1_id is null) <> (x.player2_id is null)
       and nx.status = 'pending' and nx.board is null and nx.called_at is null and nx.scorer_id is null
     order by random() limit 1;
    if p_opponent is null and not exists (
         select 1 from matches where tournament_id = p_tournament and stage = 'knockout' and round = 1
            and (player1_id is null) <> (player2_id is null)) then
      select pl into p_opponent
        from matches x, unnest(array[x.player1_id, x.player2_id]) pl
       where x.tournament_id = p_tournament and x.stage = 'knockout' and x.round = 1
         and x.player1_id is not null and x.player2_id is not null
         and x.status = 'pending' and x.board is null and x.called_at is null and x.scorer_id is null
       order by random() limit 1;
    end if;
    if p_opponent is null then
      raise exception 'No space: every first-round match and every bye''s next match has already been called or started';
    end if;
  end if;
  if p_player = p_opponent then raise exception 'Pick a different player to play them'; end if;

  -- 1. Reopen a bye.
  select * into b from matches
   where tournament_id = p_tournament and stage = 'knockout' and round = 1 and status = 'complete'
     and (player1_id is null) <> (player2_id is null) and coalesce(player1_id, player2_id) = p_opponent
   for update;
  if found then
    select * into g from matches where id = b.next_match_id for update;
    if g.id is null or g.status <> 'pending' or g.board is not null or g.called_at is not null or g.scorer_id is not null then
      raise exception 'Their next match has already been called or started';
    end if;
    -- Clearing the winner takes them back out of the next match (advance_winner).
    update matches
       set player1_id = coalesce(player1_id, p_player),
           player2_id = case when player1_id is null then player2_id else p_player end,
           status = 'pending', winner_id = null, finished_at = null, started_at = null,
           p1_legs = 0, p2_legs = 0, p1_sets = 0, p2_sets = 0,
           version = version + 1, updated_at = now()
     where id = b.id;
    insert into tournament_players (tournament_id, player_id) values (p_tournament, p_player);
    return 'bye';
  end if;

  -- 2. A new preliminary round, only when the draw has no byes.
  if exists (select 1 from matches where tournament_id = p_tournament and stage = 'knockout' and round = 1
               and (player1_id is null) <> (player2_id is null)) then
    raise exception 'No space: every bye''s next match has already been called or started';
  end if;
  select * into m from matches
   where tournament_id = p_tournament and stage = 'knockout' and round = 1
     and p_opponent in (player1_id, player2_id)
   for update;
  if not found then raise exception 'They are not in a first-round match'; end if;
  if m.status <> 'pending' or m.board is not null or m.called_at is not null or m.scorer_id is not null then
    raise exception 'That match has already been called or started';
  end if;

  select max(round) into nr from matches where tournament_id = p_tournament and stage = 'knockout';
  update matches set round = round + 1 where tournament_id = p_tournament and stage = 'knockout';
  -- Legs for the new first round: per-round settings count back from the final.
  legs := coalesce((t.round_legs->'ko'->>nr::text)::int, t.knockout_legs_to_win, 2);

  for s in select * from matches where tournament_id = p_tournament and stage = 'knockout' and round = 2 order by slot loop
    for side in 1..2 loop
      pid := case when side = 1 then s.player1_id else s.player2_id end;
      if pid is null then continue; end if;
      mine := s.id = m.id and pid = p_opponent;
      insert into matches (tournament_id, stage, round, slot, player1_id, player2_id, legs_to_win, start_score,
                           status, winner_id, finished_at, next_match_id, next_slot)
      values (p_tournament, 'knockout', 1, 2 * s.slot - 2 + side, pid, case when mine then p_player end, legs, t.start_score,
              case when mine then 'pending' else 'complete' end, case when mine then null else pid end,
              case when mine then null else now() end, s.id, side);
    end loop;
  end loop;

  update matches
     set player1_id = case when player1_id = p_opponent then null else player1_id end,
         player2_id = case when player2_id = p_opponent then null else player2_id end,
         version = version + 1, updated_at = now()
   where id = m.id;
  insert into tournament_players (tournament_id, player_id) values (p_tournament, p_player);
  return 'prelim';
end $$;

revoke execute on function public.admin_add_late_player(uuid, uuid, uuid) from public, anon;
grant execute on function public.admin_add_late_player(uuid, uuid, uuid) to authenticated;
