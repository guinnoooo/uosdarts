-- Challonge results (PC 2-7, Europa 2-7) as external results.
-- Challonge has scores but no averages, so:
--  * external_events.avg may now be null (ext_stats/ext_form already skip
--    events without an average, so no averages are made up);
--  * the results rating (glicko_at) and the win/loss counts (ext_played,
--    ext_won) count Challonge matches even though they have no average;
--  * player pages don't list Challonge events, since those PCs are already
--    shown from the order of merit.
alter table external_events alter column avg drop not null;

do $$
declare def text; f text;
begin
  foreach f in array array['public.glicko_at(timestamptz)', 'public.ext_played(uuid)', 'public.ext_won(uuid)'] loop
    def := pg_get_functiondef(f::regprocedure);
    if position('r.avg is not null' in def) = 0 then raise exception '% has changed shape', f; end if;
    execute replace(def, 'r.avg is not null', '(r.avg is not null or e.source = ''Challonge'')');
  end loop;
  def := pg_get_functiondef('public.player_profile(text, text)'::regprocedure);
  if position('where e.player_id = p.id and e.played_on >= season_start' in def) = 0 then raise exception 'player_profile has changed shape'; end if;
  execute replace(def, 'where e.player_id = p.id and e.played_on >= season_start',
                       'where e.player_id = p.id and e.played_on >= season_start and e.source is distinct from ''Challonge''');
end $$;
