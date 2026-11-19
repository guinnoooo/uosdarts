-- 040: figures for the tournament outright odds
--
-- One call with every entrant's career figures, recent form and provisional
-- average, so the tournament page can simulate the rest of the event and
-- price each player to win it.
--
-- Run after migration-039.sql. Safe to run more than once.

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
             'career', av->(p.id::text), 'form', fm->(p.id::text)))
      from players p where p.id = any (ids));
end $$;

revoke execute on function public.tournament_odds_data(uuid) from public;
grant  execute on function public.tournament_odds_data(uuid) to anon, authenticated;
