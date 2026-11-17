-- 019: friendly matches
--
-- Anyone with the friendly password (set by a super admin) can start a 1v1
-- match from /friendly/. Each friendly is its own small tournament marked
-- is_friendly, holding one match. Players are typed names rather than player
-- profiles (matches.p1_name / p2_name), so a friendly never touches the
-- order of merit, player stats or averages.
--
-- Safe to run more than once.

alter table public.tournaments add column if not exists is_friendly boolean not null default false;
alter table public.matches add column if not exists p1_name text;
alter table public.matches add column if not exists p2_name text;

-- Site-wide settings that only security-definer functions can read.
create table if not exists public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
-- No policies: nobody reads or writes this table directly.

-- ------------------------------------------------------------------ password

create or replace function public.super_set_friendly_password(p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_password is null or btrim(p_password) = '' then
    delete from settings where key = 'friendly_pw';
    return;
  end if;
  if length(btrim(p_password)) < 4 then raise exception 'Use at least 4 characters'; end if;
  insert into settings (key, value, updated_at)
  values ('friendly_pw', crypt(btrim(p_password), gen_salt('bf')), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- Whether friendlies are switched on (a password has been set).
create or replace function public.friendlies_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from settings where key = 'friendly_pw');
$$;

create or replace function public.friendly_pw_ok(p_password text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from settings
     where key = 'friendly_pw' and p_password is not null
       and crypt(btrim(p_password), value) = value
  );
$$;

-- ------------------------------------------------------------------ create

create or replace function public.create_friendly(
  p_password text,
  p_p1 text,
  p_p2 text,
  p_legs int default 3,
  p_start int default 501
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a text := btrim(coalesce(p_p1, ''));
  b text := btrim(coalesce(p_p2, ''));
  t uuid;
  m uuid;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if not friendlies_enabled() then raise exception 'Friendlies are switched off at the moment'; end if;
  if not friendly_pw_ok(p_password) then raise exception 'Wrong friendly password'; end if;
  if a = '' or b = '' then raise exception 'Enter both players'; end if;
  if length(a) > 40 or length(b) > 40 then raise exception 'Names can be up to 40 characters'; end if;
  if lower(a) = lower(b) then raise exception 'The two players need different names'; end if;
  if p_legs is null or p_legs < 1 or p_legs > 11 then raise exception 'First to between 1 and 11 legs'; end if;
  if p_start not in (101, 170, 301, 501, 701) then raise exception 'Start score must be 101, 170, 301, 501 or 701'; end if;

  -- Keeps one person (or a script) from filling the site with friendlies.
  if (select count(*) from matches x join tournaments tt on tt.id = x.tournament_id
       where tt.is_friendly and x.scorer_id = auth.uid() and tt.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'That''s a lot of friendlies in an hour. Try again later';
  end if;

  insert into tournaments (name, format, status, starts_at, start_score, knockout_legs_to_win,
                           counts_for_oom, is_pc, is_friendly, requires_password, points_schedule)
  values ('Friendly: ' || a || ' v ' || b, 'knockout', 'upcoming', now(), p_start, p_legs,
          false, false, true, true,
          '{"winner":0,"final":0,"semi":0,"quarter":0,"last_16":0,"last_32":0,"last_64":0,"groups":0}'::jsonb)
  returning id into t;

  insert into matches (tournament_id, stage, round, slot, legs_to_win, start_score, p1_name, p2_name, scorer_id)
  values (t, 'knockout', 1, 1, p_legs, p_start, a, b, auth.uid())
  returning id into m;

  perform refresh_match_state(m);
  return m;
end $$;

-- The person scoring a friendly can scrap it before it's finished.
create or replace function public.delete_friendly(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  select x.* into m from matches x join tournaments t on t.id = x.tournament_id
   where x.id = p_match and t.is_friendly;
  if not found then raise exception 'Friendly not found'; end if;
  if m.scorer_id is distinct from auth.uid() and not is_admin() then
    raise exception 'Only the person scoring it can delete this friendly';
  end if;
  delete from tournaments where id = m.tournament_id;
end $$;

revoke execute on function public.super_set_friendly_password(text) from public, anon;
revoke execute on function public.friendly_pw_ok(text)              from public, anon, authenticated;
revoke execute on function public.create_friendly(text, text, text, int, int) from public, anon;
revoke execute on function public.delete_friendly(uuid)            from public, anon;
grant  execute on function public.super_set_friendly_password(text) to authenticated;
grant  execute on function public.create_friendly(text, text, text, int, int) to authenticated;
grant  execute on function public.delete_friendly(uuid)            to authenticated;
grant  execute on function public.friendlies_enabled()             to anon, authenticated;

-- ------------------------------------------------------------------ scoring

-- Same as before, with two changes: a friendly's players can be typed names,
-- and taking over a friendly needs the friendly password.
create or replace function public.claim_match(p_match uuid, p_password text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
  h text;
  friendly boolean;
begin
  if auth.uid() is null then raise exception 'You need to be signed in to score'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.status = 'complete' then raise exception 'This match has already finished'; end if;
  if (m.player1_id is null and m.p1_name is null) or (m.player2_id is null and m.p2_name is null) then
    raise exception 'Both players are not decided yet';
  end if;
  if m.scorer_id is not null and m.scorer_id <> auth.uid() then
    raise exception 'Someone is already scoring this match';
  end if;

  select is_friendly into friendly from tournaments where id = m.tournament_id;
  if friendly then
    if m.scorer_id is distinct from auth.uid() and not friendly_pw_ok(p_password) then
      raise exception 'Wrong scoring password';
    end if;
  else
    select pw_hash into h from tournament_passwords where tournament_id = m.tournament_id;
    if h is not null then
      if p_password is null or btrim(p_password) = '' then
        raise exception 'This tournament needs a scoring password';
      end if;
      if crypt(btrim(p_password), h) <> h then
        raise exception 'Wrong scoring password';
      end if;
    end if;
  end if;

  update matches set scorer_id = auth.uid() where id = p_match;
  perform refresh_match_state(m.id);
end $$;

-- A friendly's tournament follows its one match: finished when the match is,
-- back to live if the last leg is undone.
create or replace function public.friendly_follow_match() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and exists (select 1 from tournaments where id = new.tournament_id and is_friendly) then
    update tournaments
       set status = case new.status when 'complete' then 'complete' when 'live' then 'live' else status end
     where id = new.tournament_id;
  end if;
  return null;
end $$;

drop trigger if exists matches_friendly on public.matches;
create trigger matches_friendly
after update of status on public.matches
for each row execute function public.friendly_follow_match();

revoke execute on function public.friendly_follow_match() from public, anon, authenticated;
