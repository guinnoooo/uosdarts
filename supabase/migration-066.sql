-- Each change after the free one now costs 8 points (was 4).
create or replace function public.fantasy_hit() returns integer language sql immutable as $$ select 8 $$;
delete from public.fantasy_team_cache;
