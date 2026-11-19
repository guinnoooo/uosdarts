-- 041: win rates in the tournament odds
--
-- tournament_odds_data also returns each entrant's matches played and won
-- (the same count as the match preview: finished matches between two
-- linked players), so the outright odds use win rate like the match odds.
--
-- Run after migration-040.sql. Safe to run more than once.

create or replace function public.tournament_odds_data(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  ids uuid[];
  av jsonb;
  fm jsonb;
begin
  select array_agg(player_id) into ids from tournament_players where tournament_id = p_tournament;
  if ids is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into av from player_averages_for(ids) x;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into fm from player_form_for(ids) x;
  return (
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'prov', p.provisional_avg,
             'career', av->(p.id::text), 'form', fm->(p.id::text),
             'played', coalesce(r.played, 0), 'won', coalesce(r.won, 0)))
      from players p
      left join lateral (
        select count(*) as played, count(*) filter (where x.winner_id = p.id) as won
          from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
         where x.status = 'complete' and p.id in (x.player1_id, x.player2_id)
           and x.player1_id is not null and x.player2_id is not null
      ) r on true
     where p.id = any (ids));
end $$;

revoke execute on function public.tournament_odds_data(uuid) from public;
grant  execute on function public.tournament_odds_data(uuid) to anon, authenticated;
