-- 039: let the super admin count a friendly towards players' figures
--
-- After a friendly finishes, a super admin can mark it as played properly
-- and say which profile each player is. Its visits then count towards
-- career and recent-form averages, first 9 and doubles % (and so the odds
-- model), through counted_p1_id / counted_p2_id. Nothing else changes:
-- player1_id / player2_id stay empty, so 180s, 100+ checkouts, sheet legs,
-- win rates, head to heads and the order of merit never see friendlies.
-- Players notice nothing. Once counted, only an admin can delete it.
--
-- Run after migration-038.sql. Safe to run more than once.

alter table public.tournaments add column if not exists friendly_counted boolean;  -- null: not reviewed
alter table public.matches add column if not exists counted_p1_id uuid references public.players(id) on delete set null;
alter table public.matches add column if not exists counted_p2_id uuid references public.players(id) on delete set null;
create index if not exists matches_counted_p1_idx on public.matches (counted_p1_id);
create index if not exists matches_counted_p2_idx on public.matches (counted_p2_id);

-- The four figure functions read a counted friendly's players as well.
do $$
declare
  fn regprocedure;
  def text;
begin
  foreach fn in array array['public.player_averages()'::regprocedure, 'public.player_form(integer)'::regprocedure,
                            'public.player_averages_for(uuid[])'::regprocedure, 'public.player_form_for(uuid[], integer)'::regprocedure]
  loop
    def := replace(pg_get_functiondef(fn), E'\r', '');
    if position('counted_p1_id' in def) > 0 then continue; end if;
    def := replace(def, 'case when vi.player = 1 then m.player1_id else m.player2_id end',
                        'case when vi.player = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end');
    def := replace(def, 'case when l.winner = 1 then m.player1_id else m.player2_id end',
                        'case when l.winner = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end');
    def := replace(def, 'm.player1_id = any (p_ids) or m.player2_id = any (p_ids)',
                        'm.player1_id = any (p_ids) or m.player2_id = any (p_ids) or m.counted_p1_id = any (p_ids) or m.counted_p2_id = any (p_ids)');
    def := replace(def, 'and not t.is_friendly', 'and (not t.is_friendly or t.friendly_counted)');
    if position('counted_p1_id' in def) = 0 or position('and not t.is_friendly' in def) > 0 then
      raise exception '% has changed shape', fn;
    end if;
    execute def;
  end loop;
end $$;

-- Finished friendlies for the super admin to review, newest first, with
-- each player's average in the match and the profile their name matches.
create or replace function public.super_list_friendlies() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((
    select jsonb_agg(x order by x.finished desc nulls last)
      from (
        select t.id as tournament_id, m.id as match_id, t.friendly_counted as counted, t.is_remote as remote,
               coalesce(m.finished_at, m.updated_at) as finished,
               m.p1_name, m.p2_name, m.p1_legs, m.p2_legs, m.p1_sets, m.p2_sets, m.sets_to_win,
               m.counted_p1_id, m.counted_p2_id,
               (select id from players where lower(name) = lower(btrim(m.p1_name)) limit 1) as match_p1_id,
               (select id from players where lower(name) = lower(btrim(m.p2_name)) limit 1) as match_p2_id,
               (select to_char(sum(score)::numeric / nullif(sum(darts), 0) * 3, 'FM990.00') from visits where match_id = m.id and player = 1) as p1_avg,
               (select to_char(sum(score)::numeric / nullif(sum(darts), 0) * 3, 'FM990.00') from visits where match_id = m.id and player = 2) as p2_avg,
               (select count(*) from visits where match_id = m.id) as visits
          from tournaments t
          join matches m on m.tournament_id = t.id
         where t.is_friendly and t.deleted_at is null and m.status = 'complete'
         order by coalesce(m.finished_at, m.updated_at) desc nulls last
         limit 60
      ) x), '[]'::jsonb);
end $$;

-- Count a finished friendly (p_counted true, with the profile for each
-- player; a side left empty doesn't count), mark it as not counting
-- (false), or put it back to unreviewed (null).
create or replace function public.super_count_friendly(p_tournament uuid, p_counted boolean, p_p1 uuid default null, p_p2 uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  t tournaments;
  m matches;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  select * into t from tournaments where id = p_tournament for update;
  if not found or not t.is_friendly then raise exception 'Friendly not found'; end if;
  select * into m from matches where tournament_id = t.id limit 1;
  if m.status <> 'complete' then raise exception 'Only finished friendlies can be counted'; end if;

  if p_counted then
    if p_p1 is null and p_p2 is null then raise exception 'Pick a profile for at least one player'; end if;
    if p_p1 = p_p2 then raise exception 'The two players need different profiles'; end if;
    update matches set counted_p1_id = p_p1, counted_p2_id = p_p2 where id = m.id;
  else
    update matches set counted_p1_id = null, counted_p2_id = null where id = m.id;
  end if;
  update tournaments set friendly_counted = p_counted where id = t.id;
end $$;

-- A counted friendly is part of people's figures, so only an admin can delete it.
create or replace function public.delete_friendly(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches; counted boolean;
begin
  select x.* into m from matches x join tournaments t on t.id = x.tournament_id
   where x.id = p_match and t.is_friendly;
  if not found then raise exception 'Friendly not found'; end if;
  select friendly_counted into counted from tournaments where id = m.tournament_id;
  if m.scorer_id is distinct from auth.uid() and not is_admin() then
    raise exception 'Only the person scoring it can delete this friendly';
  end if;
  if counted and not is_admin() then
    raise exception 'This friendly counts towards players'' figures, so ask an admin to delete it';
  end if;
  delete from tournaments where id = m.tournament_id;
end $$;

revoke execute on function public.super_list_friendlies() from public, anon;
revoke execute on function public.super_count_friendly(uuid, boolean, uuid, uuid) from public, anon;
grant  execute on function public.super_list_friendlies() to authenticated;
grant  execute on function public.super_count_friendly(uuid, boolean, uuid, uuid) to authenticated;
