-- 042: figures for every game in a team match at once
--
-- fixture_preview returns names_preview for each game in a UDUK or Franny
-- match, keyed by game, so the finished match page can draw how the team
-- match's win chance moved game by game.
--
-- Run after migration-041.sql. Safe to run more than once.

create or replace function public.fixture_preview(p_tournament uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(m.id, names_preview(m.id)), '{}'::jsonb)
    from matches m join tournaments t on t.id = m.tournament_id
   where m.tournament_id = p_tournament and t.kind is not null and t.deleted_at is null;
$$;

revoke execute on function public.fixture_preview(uuid) from public;
grant  execute on function public.fixture_preview(uuid) to anon, authenticated;
