-- 032: schedule a UDUK or Franny match for later
--
-- create_fixture takes an optional start time (the default is now), and
-- set_fixture_time moves a match that hasn't started yet. Anyone with the
-- match's scoring password, whoever set it up, or an admin can move it.
--
-- Run after migration-031.sql. Safe to run more than once.

drop function if exists public.create_fixture(text, text, text, text, text, text);
create or replace function public.create_fixture(
  p_kind text, p_password text, p_home text, p_away text, p_competition text default null,
  p_scoring_password text default null, p_starts_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  h text := btrim(coalesce(p_home, ''));
  a text := btrim(coalesce(p_away, ''));
  comp text := case when p_kind = 'uduk' then lower(coalesce(p_competition, '')) end;
  t uuid;
  plan jsonb;
  blk jsonb;
  i int;
  slot int := 0;
  counts jsonb := '{}'::jsonb;
  n int;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if p_kind not in ('uduk', 'franny') then raise exception 'Unknown hub'; end if;
  if not hub_enabled(p_kind) then raise exception 'Starting matches here is switched off at the moment'; end if;
  if not hub_pw_ok(p_kind, p_password) then raise exception 'Wrong password'; end if;
  if h = '' or a = '' then raise exception 'Enter both teams'; end if;
  if length(h) > 40 or length(a) > 40 then raise exception 'Team names can be up to 40 characters'; end if;
  if lower(h) = lower(a) then raise exception 'The two teams need different names'; end if;
  if p_kind = 'uduk' and comp not in ('league', 'cup') then raise exception 'Pick league or cup'; end if;
  if length(btrim(coalesce(p_scoring_password, ''))) < 4 then
    raise exception 'Set a scoring password for this match (at least 4 characters)';
  end if;
  if p_starts_at is not null and p_starts_at < now() - interval '1 hour' then
    raise exception 'That start time has already passed';
  end if;
  if p_starts_at is not null and p_starts_at > now() + interval '1 year' then
    raise exception 'Matches can be scheduled up to a year ahead';
  end if;
  if (select count(*) from tournaments where created_by = auth.uid() and kind is not null
        and created_at > now() - interval '1 hour') >= 6 then
    raise exception 'That''s a lot of matches in an hour. Try again later';
  end if;

  plan := case
    when p_kind = 'franny' then
      '[["singles",5,501,3],["doubles",2,701,2]]'
    when comp = 'league' then
      '[["trebles",2,701,2],["doubles",3,701,2],["singles",6,501,2]]'
    else
      '[["singles",9,501,3],["doubles",4,701,2],["singles",9,501,3]]'
  end::jsonb;

  insert into tournaments (name, format, status, starts_at, start_score, knockout_legs_to_win,
                           counts_for_oom, is_pc, is_friendly, requires_password, points_schedule,
                           kind, home_team, away_team, competition, home_ours, away_ours, created_by)
  values (h || ' v ' || a, 'knockout', 'upcoming', coalesce(p_starts_at, now()), 501, 2,
          false, false, false, true,
          '{"winner":0,"final":0,"semi":0,"quarter":0,"last_16":0,"last_32":0,"last_64":0,"groups":0}'::jsonb,
          p_kind, h, a, comp, h = any (our_teams(p_kind)), a = any (our_teams(p_kind)), auth.uid())
  returning id into t;

  insert into tournament_passwords (tournament_id, pw_hash, updated_at)
  values (t, crypt(btrim(p_scoring_password), gen_salt('bf')), now());

  for blk in select * from jsonb_array_elements(plan) loop
    for i in 1 .. (blk->>1)::int loop
      slot := slot + 1;
      n := coalesce((counts->>(blk->>0))::int, 0) + 1;
      counts := counts || jsonb_build_object(blk->>0, n);
      insert into matches (tournament_id, stage, round, slot, legs_to_win, start_score, game_type, game_label)
      values (t, 'knockout', 1, slot, (blk->>3)::int, (blk->>2)::int, blk->>0,
              initcap(blk->>0) || ' ' || n);
    end loop;
  end loop;
  return t;
end $$;

create or replace function public.set_fixture_time(p_tournament uuid, p_password text, p_starts_at timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
declare t tournaments;
begin
  select * into t from tournaments where id = p_tournament for update;
  if not found or t.kind is null then raise exception 'Match not found'; end if;
  if t.created_by is distinct from auth.uid() and not is_admin() and not fixture_pw_ok(t.id, p_password) then
    raise exception 'Wrong password';
  end if;
  if t.status <> 'upcoming' then raise exception 'This match has already started'; end if;
  if p_starts_at is null then raise exception 'Pick a start time'; end if;
  if p_starts_at < now() - interval '1 hour' then raise exception 'That start time has already passed'; end if;
  if p_starts_at > now() + interval '1 year' then raise exception 'Matches can be scheduled up to a year ahead'; end if;
  update tournaments set starts_at = p_starts_at where id = t.id;
end $$;

revoke execute on function public.create_fixture(text, text, text, text, text, text, timestamptz) from public, anon;
revoke execute on function public.set_fixture_time(uuid, text, timestamptz) from public, anon;
grant  execute on function public.create_fixture(text, text, text, text, text, text, timestamptz) to authenticated;
grant  execute on function public.set_fixture_time(uuid, text, timestamptz) to authenticated;
