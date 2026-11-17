-- 016: Europa events
-- Every PC gets a companion "Europa N" tournament. Anyone knocked out of the
-- PC before the last 16 is added to it automatically. It stays upcoming (and
-- off the public list) until the admin draws and starts it like any other
-- tournament. It doesn't count for the Order of Merit unless the admin ticks
-- that in its points settings.
--
-- Safe to run more than once, and in either order with migration-015.

alter table public.tournaments
  add column if not exists parent_id uuid references public.tournaments on delete set null;

-- One Europa per PC.
create unique index if not exists tournaments_one_child
  on public.tournaments (parent_id) where parent_id is not null;

-- ------------------------------------------------------------------ syncing

-- Creates any missing Europas and keeps the name and date of the unstarted
-- ones in step with their PC. Called from renumber_pcs, which already runs
-- whenever a PC is scheduled, moved, cancelled, deleted or restored.
create or replace function public.sync_europas() returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into tournaments (name, format, status, starts_at, start_score,
                           knockout_legs_to_win, group_legs_to_win, round_legs,
                           counts_for_oom, is_pc, season, points_schedule, parent_id)
  select 'Europa ' || coalesce(p.pc_number::text, '?'), 'knockout', 'upcoming', p.starts_at, p.start_score,
         p.knockout_legs_to_win, p.group_legs_to_win, p.round_legs,
         false, false, p.season,
         '{"winner":0,"final":0,"semi":0,"quarter":0,"last_16":0,"last_32":0,"last_64":0,"groups":0}'::jsonb,
         p.id
    from tournaments p
   where p.is_pc and p.status in ('upcoming', 'live') and p.deleted_at is null
     and not exists (select 1 from tournaments e where e.parent_id = p.id);

  -- A renamed Europa (anything other than "Europa N") keeps its name.
  update tournaments e
     set name = 'Europa ' || p.pc_number,
         starts_at = p.starts_at
    from tournaments p
   where e.parent_id = p.id
     and e.status = 'upcoming'
     and p.pc_number is not null
     and e.name ~ '^Europa [0-9?]+$'
     and (e.name <> 'Europa ' || p.pc_number or e.starts_at is distinct from p.starts_at);
end $$;

-- Same as migration-009, plus the Europa sync at the end.
create or replace function public.renumber_pcs() returns void
language plpgsql security definer set search_path = public as $$
declare base int := pc_number_base();
begin
  with ordered as (
    select id, row_number() over (order by starts_at nulls last, created_at) as n
      from tournaments
     where is_pc and status in ('upcoming', 'live') and deleted_at is null
  )
  update tournaments t
     set pc_number = base + o.n,
         name = case when t.name ~ '^PC [0-9]+$' then 'PC ' || (base + o.n) else t.name end
    from ordered o
   where t.id = o.id
     and (t.pc_number is distinct from base + o.n
          or (t.name ~ '^PC [0-9]+$' and t.name <> 'PC ' || (base + o.n)));

  update tournaments
     set pc_number = null
   where is_pc and pc_number is not null
     and (status = 'cancelled' or deleted_at is not null);

  perform sync_europas();
end $$;

-- Deleting a PC takes its Europa with it. Both get the same timestamp, which
-- is how restoring the PC knows which Europa to bring back. Deleting just the
-- Europa leaves the PC alone, and it won't be recreated.
create or replace function public.admin_delete_tournament(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare stamp timestamptz := now();
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update tournaments set deleted_at = stamp
   where (id = p_tournament or parent_id = p_tournament) and deleted_at is null;
  perform renumber_pcs();
end $$;

create or replace function public.admin_restore_tournament(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare stamp timestamptz;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select deleted_at into stamp from tournaments where id = p_tournament;
  update tournaments set deleted_at = null
   where id = p_tournament
      or (parent_id = p_tournament and stamp is not null and deleted_at = stamp);
  perform renumber_pcs();
end $$;

-- Cancelling or un-cancelling a PC does the same to its Europa, unless the
-- Europa has already been played.
create or replace function public.admin_set_cancelled(p_tournament uuid, p_cancelled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update tournaments
     set status = case when p_cancelled then 'cancelled' else 'upcoming' end
   where id = p_tournament
     and status <> 'complete';
  update tournaments
     set status = case when p_cancelled then 'cancelled' else 'upcoming' end
   where parent_id = p_tournament
     and status = case when p_cancelled then 'upcoming' else 'cancelled' end;
  perform renumber_pcs();
end $$;

-- ------------------------------------------------------------------ entrants

-- When a PC knockout match before the last 16 gets a result, the loser goes
-- into the Europa. Only while the Europa is upcoming and not yet drawn; after
-- that the admin manages entrants by hand. If a result is changed or a match
-- reopened, the previous loser is taken back out.
create or replace function public.europa_on_result() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  eu uuid;
  last_round int;
  old_loser uuid;
  new_loser uuid;
begin
  if new.stage <> 'knockout' then return null; end if;
  if not exists (select 1 from tournaments where id = new.tournament_id and is_pc) then return null; end if;

  select id into eu from tournaments
   where parent_id = new.tournament_id and status = 'upcoming' and deleted_at is null;
  if eu is null then return null; end if;
  if exists (select 1 from matches where tournament_id = eu) then return null; end if;

  -- Last 16 is three rounds before the final, so only rounds before that count.
  select max(round) into last_round from matches
   where tournament_id = new.tournament_id and stage = 'knockout';
  if new.round > last_round - 4 then return null; end if;

  if old.winner_id is not null then
    old_loser := case when old.winner_id = old.player1_id then old.player2_id else old.player1_id end;
    if old_loser is not null and old_loser is distinct from new.winner_id then
      delete from tournament_players where tournament_id = eu and player_id = old_loser;
    end if;
  end if;

  if new.winner_id is not null then
    new_loser := case when new.winner_id = new.player1_id then new.player2_id else new.player1_id end;
    -- A bye has no loser.
    if new_loser is not null then
      insert into tournament_players (tournament_id, player_id)
      values (eu, new_loser)
      on conflict do nothing;
    end if;
    -- The winner can't be in the Europa (an edited result might have put them there).
    delete from tournament_players where tournament_id = eu and player_id = new.winner_id;
  end if;
  return null;
end $$;

drop trigger if exists matches_europa on public.matches;
create trigger matches_europa
after update of winner_id on public.matches
for each row
when (new.winner_id is distinct from old.winner_id)
execute function public.europa_on_result();

-- Internal helpers, not for calling from the site.
revoke execute on function public.sync_europas()     from public, anon, authenticated;
revoke execute on function public.europa_on_result() from public, anon, authenticated;

-- Create Europas for every PC already scheduled.
select public.renumber_pcs();
