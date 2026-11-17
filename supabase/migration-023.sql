-- 023: best legs on the tournament summary, one row per leg
--
-- tournament_best_legs(): every leg won in a tournament with the darts the
-- winner took, fewest first. Bull-off legs are left out. The summary shows
-- the top five, so one player can appear more than once.
--
-- Read-only and safe to run more than once.

create or replace function public.tournament_best_legs(p_tournament uuid, p_limit int default 5)
returns table (
  player_id   uuid,
  player_name text,
  darts       int
)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, x.d::int
    from legs l
    join matches m on m.id = l.match_id
    join players p on p.id = case when l.winner = 1 then m.player1_id else m.player2_id end
    join lateral (select sum(v.darts) as d from visits v where v.leg_id = l.id and v.player = l.winner) x on true
   where m.tournament_id = p_tournament
     and l.winner is not null and not l.bull_off and x.d is not null
   order by x.d, m.finished_at nulls last, l.leg_no
   limit least(greatest(coalesce(p_limit, 5), 1), 50);
$$;

grant execute on function public.tournament_best_legs(uuid, int) to anon, authenticated;
