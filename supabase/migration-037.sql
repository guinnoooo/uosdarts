-- 037: remote friendlies
--
-- A friendly can be set up as remote: each player scores their own throws on
-- their own phone. Whoever starts it is player 1 and sets a password; player 2
-- opens the match and joins with that password. Each can only enter visits
-- (and undo them) on their own turn. Remote friendlies count for nothing,
-- like every friendly.
--
-- Run after migration-036.sql. Safe to run more than once.

alter table public.tournaments add column if not exists is_remote boolean not null default false;
alter table public.matches add column if not exists scorer2_id uuid;

-- Can the signed-in user enter a visit for side p_who? In a remote friendly
-- each side has its own scorer; everywhere else the one scorer does both.
create or replace function public.can_score_side(p_match matches, p_who int) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when (select is_remote from tournaments where id = p_match.tournament_id)
      then (p_who = 1 and p_match.scorer_id = auth.uid()) or (p_who = 2 and p_match.scorer2_id = auth.uid())
    else p_match.scorer_id = auth.uid()
  end;
$$;

drop function if exists public.create_friendly(text, text, text, integer, integer, integer);
create or replace function public.create_friendly(
  p_password text, p_p1 text, p_p2 text, p_legs integer default 3, p_start integer default 501,
  p_sets integer default null, p_remote boolean default false, p_remote_password text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  a text := btrim(coalesce(p_p1, ''));
  b text := btrim(coalesce(p_p2, ''));
  rpw text := btrim(coalesce(p_remote_password, ''));
  t uuid;
  m uuid;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if not friendlies_enabled() then raise exception 'Friendlies are switched off at the moment'; end if;
  if not friendly_pw_ok(p_password) then raise exception 'Wrong friendly password'; end if;
  if a = '' or b = '' then raise exception 'Enter both players'; end if;
  if length(a) > 40 or length(b) > 40 then raise exception 'Names can be up to 40 characters'; end if;
  if lower(a) = lower(b) then raise exception 'The two players need different names'; end if;
  if p_legs is null or p_legs < 1 or p_legs > 10 then raise exception 'First to between 1 and 10 legs'; end if;
  if p_sets is not null and (p_sets < 1 or p_sets > 10) then raise exception 'First to between 1 and 10 sets'; end if;
  if p_start not in (101, 170, 301, 501, 701) then raise exception 'Start score must be 101, 170, 301, 501 or 701'; end if;
  if coalesce(p_remote, false) and length(rpw) < 4 then
    raise exception 'Set a password for the remote match (at least 4 characters)';
  end if;

  if (select count(*) from matches x join tournaments tt on tt.id = x.tournament_id
       where tt.is_friendly and x.scorer_id = auth.uid() and tt.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'That''s a lot of friendlies in an hour. Try again later';
  end if;

  insert into tournaments (name, format, status, starts_at, start_score, knockout_legs_to_win,
                           counts_for_oom, is_pc, is_friendly, requires_password, points_schedule, is_remote)
  values ('Friendly: ' || a || ' v ' || b, 'knockout', 'upcoming', now(), p_start, p_legs,
          false, false, true, true,
          '{"winner":0,"final":0,"semi":0,"quarter":0,"last_16":0,"last_32":0,"last_64":0,"groups":0}'::jsonb,
          coalesce(p_remote, false))
  returning id into t;

  if coalesce(p_remote, false) then
    insert into tournament_passwords (tournament_id, pw_hash, updated_at)
    values (t, crypt(rpw, gen_salt('bf')), now());
  end if;

  insert into matches (tournament_id, stage, round, slot, legs_to_win, sets_to_win, start_score, p1_name, p2_name, scorer_id)
  values (t, 'knockout', 1, 1, p_legs, p_sets, p_start, a, b, auth.uid())
  returning id into m;

  perform refresh_match_state(m);
  return m;
end $$;

-- Remote friendlies: the match password puts you in whichever seat is free
-- (player 1's if they've left, otherwise player 2's).
create or replace function public.claim_match(p_match uuid, p_password text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
  h text;
  t tournaments;
begin
  if auth.uid() is null then raise exception 'You need to be signed in to score'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.status = 'complete' then raise exception 'This match has already finished'; end if;
  if (m.player1_id is null and m.p1_name is null) or (m.player2_id is null and m.p2_name is null) then
    raise exception 'Both players are not decided yet';
  end if;
  select * into t from tournaments where id = m.tournament_id;

  if t.is_remote then
    if auth.uid() in (m.scorer_id, m.scorer2_id) then return; end if;
    select pw_hash into h from tournament_passwords where tournament_id = t.id;
    if p_password is null or h is null or crypt(btrim(p_password), h) <> h then
      raise exception 'Wrong password for this match';
    end if;
    if m.scorer_id is null then
      update matches set scorer_id = auth.uid() where id = p_match;
    elsif m.scorer2_id is null then
      update matches set scorer2_id = auth.uid() where id = p_match;
    else
      raise exception 'Both players are already scoring this match';
    end if;
    perform refresh_match_state(m.id);
    return;
  end if;

  if m.scorer_id is not null and m.scorer_id <> auth.uid() then
    raise exception 'Someone is already scoring this match';
  end if;
  if m.scorer_id is distinct from auth.uid() then
    if t.is_friendly then
      if not friendly_pw_ok(p_password) then raise exception 'Wrong scoring password'; end if;
    elsif t.kind is not null then
      if not fixture_pw_ok(t.id, p_password) then raise exception 'Wrong scoring password'; end if;
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
  end if;

  update matches set scorer_id = auth.uid() where id = p_match;
  perform refresh_match_state(m.id);
end $$;

-- Remote friendlies only start once both players are in.
create or replace function public.start_match(p_match uuid, p_first integer) returns void
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;
  if m.status <> 'pending' then raise exception 'Match has already started'; end if;
  if (select is_remote from tournaments where id = m.tournament_id) and m.scorer2_id is null then
    raise exception 'Wait for % to join first', m.p2_name;
  end if;
  p_first := coalesce(hub_first_thrower(p_match), p_first);
  if p_first is null or p_first not in (1, 2) then raise exception 'First thrower must be 1 or 2'; end if;

  update matches set status = 'live', started_at = now() where id = p_match;
  insert into legs (match_id, leg_no, starter) values (p_match, 1, p_first);
  update tournaments set status = 'live' where id = m.tournament_id and status = 'upcoming';
  perform refresh_match_state(p_match);
end $$;

create or replace function public.record_visit(p_match uuid, p_score integer, p_darts integer default 3, p_doubles integer default 0)
returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  l legs;
  n int;
  who int;
  rem int;
  new_rem int;
  bust boolean := false;
  d int := 3;
  dd int;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if auth.uid() is null or auth.uid() not in (coalesce(m.scorer_id, '00000000-0000-0000-0000-000000000000'),
                                              coalesce(m.scorer2_id, '00000000-0000-0000-0000-000000000000')) then
    raise exception 'You are not the scorer for this match';
  end if;
  if m.status <> 'live' then raise exception 'Match is not in progress'; end if;
  if p_score < 0 or p_score > 180 or p_score in (163, 166, 169, 172, 173, 175, 176, 178, 179) then
    raise exception '% is not a possible score', p_score;
  end if;

  select * into l from legs where match_id = p_match order by leg_no desc limit 1;
  select count(*) into n from visits where leg_id = l.id;
  who := case when n % 2 = 0 then l.starter else 3 - l.starter end;
  if not can_score_side(m, who) then
    raise exception 'It''s %''s throw', case who when 1 then m.p1_name else m.p2_name end;
  end if;
  rem := coalesce((select remaining from visits where leg_id = l.id and player = who order by id desc limit 1), m.start_score);
  new_rem := rem - p_score;

  if new_rem = 0 then
    if rem > 170 or rem in (169, 168, 166, 165, 163, 162, 159) then
      raise exception '% is not a checkout', rem;
    end if;
    d := greatest(1, least(3, coalesce(p_darts, 3)));
    dd := greatest(1, least(d, coalesce(p_doubles, 1)));
  elsif new_rem < 2 then
    bust := true;
    new_rem := rem;
    dd := greatest(0, least(3, coalesce(p_doubles, 0)));
  else
    dd := greatest(0, least(3, coalesce(p_doubles, 0)));
  end if;

  insert into visits (match_id, leg_id, player, score, darts, remaining, is_bust, darts_at_double)
  values (p_match, l.id, who, case when bust then 0 else p_score end, d, new_rem, bust, dd);

  if new_rem = 0 then
    update legs set winner = who where id = l.id;
    perform after_leg_won(p_match, l.leg_no, l.starter);
  end if;

  perform refresh_match_state(p_match);
end $$;

-- In a remote friendly you can only take back your own last visit.
create or replace function public.undo_visit(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  v visits;
  l legs;
  remote boolean;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  select is_remote into remote from tournaments where id = m.tournament_id;
  if m.scorer_id is distinct from auth.uid() and not (remote and m.scorer2_id = auth.uid()) then
    raise exception 'You are not the scorer for this match';
  end if;

  if not remote then
    select * into l from legs where match_id = p_match and bull_off order by leg_no desc limit 1;
    if found and not exists (
      select 1 from visits vv join legs ll on ll.id = vv.leg_id
       where vv.match_id = p_match and ll.leg_no > l.leg_no
    ) then
      if m.status = 'complete' and m.next_match_id is not null
         and exists (select 1 from matches where id = m.next_match_id and status <> 'pending') then
        raise exception 'The next round match has already started, ask an admin to fix this';
      end if;
      delete from legs where match_id = p_match and leg_no > l.leg_no;
      update legs set winner = null, bull_off = false where id = l.id;
      perform recount_match(p_match);
      perform refresh_match_state(p_match);
      return;
    end if;
  end if;

  select * into v from visits where match_id = p_match order by id desc limit 1;
  if not found then raise exception 'Nothing to undo'; end if;
  if remote and not can_score_side(m, v.player) then
    raise exception 'The last throw was %''s, so only they can undo it', case v.player when 1 then m.p1_name else m.p2_name end;
  end if;
  select * into l from legs where id = v.leg_id;

  if l.winner is not null then
    if m.status = 'complete' and m.next_match_id is not null
       and exists (select 1 from matches where id = m.next_match_id and status <> 'pending') then
      raise exception 'The next round match has already started, ask an admin to fix this';
    end if;
    delete from legs where match_id = p_match and leg_no > l.leg_no;
    update legs set winner = null where id = l.id;
    perform recount_match(p_match);
  end if;

  delete from visits where id = v.id;
  perform refresh_match_state(p_match);
end $$;

-- Leaving frees your own seat.
create or replace function public.release_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer2_id is not null and m.scorer2_id = auth.uid() then
    update matches set scorer2_id = null where id = p_match;
  elsif m.scorer_id is distinct from auth.uid() and not is_admin() then
    raise exception 'You are not the scorer for this match';
  else
    update matches set scorer_id = null where id = p_match;
  end if;
  perform refresh_match_state(p_match);
end $$;

revoke execute on function public.can_score_side(matches, int) from public, anon, authenticated;
revoke execute on function public.create_friendly(text, text, text, integer, integer, integer, boolean, text) from public, anon;
grant  execute on function public.create_friendly(text, text, text, integer, integer, integer, boolean, text) to authenticated;
