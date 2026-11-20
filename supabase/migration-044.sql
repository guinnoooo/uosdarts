-- 044: peak viewers for each match
--
-- The match page counts who's watching. Whenever that passes the match's
-- record it calls note_viewers, which keeps only a higher number and only
-- while the match isn't finished. Finished matches show the peak.
--
-- Run after migration-043.sql. Safe to run more than once.

alter table public.matches add column if not exists peak_viewers int not null default 0;

create or replace function public.note_viewers(p_match uuid, p_count int) returns void
language sql security definer set search_path = public as $$
  update matches set peak_viewers = least(p_count, 1000)
   where id = p_match and status <> 'complete' and p_count > peak_viewers;
$$;

revoke execute on function public.note_viewers(uuid, int) from public;
grant  execute on function public.note_viewers(uuid, int) to anon, authenticated;
