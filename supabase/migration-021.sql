-- 021: set play, and friendlies up to first to 10 legs
--
-- * matches.sets_to_win: when set, the match is first to that many sets and
--   legs_to_win is legs per set. Left empty, a match works exactly as before.
-- * recount_match() works out legs, sets, status and winner from the legs
--   played, and is used whenever a leg is won or undone. That's what lets
--   undo step back across the end of a set.
-- * record_visit, bull_off and undo_visit use it; nothing else about them
--   changes.
-- * create_friendly takes an optional number of sets, and allows first to 10 legs.
--
-- Safe to run more than once.

alter table public.matches add column if not exists sets_to_win int;
alter table public.matches add column if not exists p1_sets int not null default 0;
alter table public.matches add column if not exists p2_sets int not null default 0;
alter table public.matches drop constraint if exists matches_sets_to_win_check;
alter table public.matches add constraint matches_sets_to_win_check
  check (sets_to_win is null or sets_to_win between 1 and 10);

-- Returns true when the match is finished.
create or replace function public.recount_match(p_match uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  l record;
  a int := 0;  b int := 0;      -- legs (in the current set, for set play)
  sa int := 0; sb int := 0;     -- sets
  done boolean := false;
  w int;
begin
  select * into m from matches where id = p_match;
  for l in select winner from legs where match_id = p_match and winner is not null order by leg_no loop
    exit when done;
    if l.winner = 1 then a := a + 1; else b := b + 1; end if;
    if m.sets_to_win is null then
      if greatest(a, b) >= m.legs_to_win then done := true; w := case when a > b then 1 else 2 end; end if;
    elsif greatest(a, b) >= m.legs_to_win then
      if a > b then sa := sa + 1; else sb := sb + 1; end if;
      if greatest(sa, sb) >= m.sets_to_win then
        done := true; w := case when sa > sb then 1 else 2 end;   -- keep the last set's legs on show
      else
        a := 0; b := 0;
      end if;
    end if;
  end loop;

  update matches
     set p1_legs = a, p2_legs = b, p1_sets = sa, p2_sets = sb,
         status = case when done then 'complete' else 'live' end,
         winner_id = case when done then (case when w = 1 then player1_id else player2_id end) end,
         finished_at = case when done then coalesce(finished_at, now()) end
   where id = p_match;
  return done;
end $$;

-- After a leg is won: update the score, and start the next leg unless that was the match.
create or replace function public.after_leg_won(p_match uuid, p_leg_no int, p_starter int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not recount_match(p_match) then
    insert into legs (match_id, leg_no, starter) values (p_match, p_leg_no + 1, 3 - p_starter);
  end if;
end $$;

revoke execute on function public.recount_match(uuid)            from public, anon, authenticated;
revoke execute on function public.after_leg_won(uuid, int, int)  from public, anon, authenticated;

create or replace function public.record_visit(p_match uuid, p_score integer, p_darts integer DEFAULT 3, p_doubles integer DEFAULT 0) returns void
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
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;
  if m.status <> 'live' then raise exception 'Match is not in progress'; end if;
  if p_score < 0 or p_score > 180 or p_score in (163, 166, 169, 172, 173, 175, 176, 178, 179) then
    raise exception '% is not a possible score', p_score;
  end if;

  select * into l from legs where match_id = p_match order by leg_no desc limit 1;
  select count(*) into n from visits where leg_id = l.id;
  who := case when n % 2 = 0 then l.starter else 3 - l.starter end;
  rem := coalesce((select remaining from visits where leg_id = l.id and player = who order by id desc limit 1), m.start_score);
  new_rem := rem - p_score;

  if new_rem = 0 then
    if rem > 170 or rem in (169, 168, 166, 165, 163, 162, 159) then
      raise exception '% is not a checkout', rem;
    end if;
    d := greatest(1, least(3, coalesce(p_darts, 3)));
    -- A checkout always ends on a double, so at least one dart was thrown at one.
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

create or replace function public.bull_off(p_match uuid, p_winner int) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  l legs;
  lim int;
  d1 int;
  d2 int;
begin
  if p_winner is null or p_winner not in (1, 2) then raise exception 'Pick who won the bull'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;
  if m.status <> 'live' then raise exception 'Match is not in progress'; end if;

  select dart_limit into lim from tournaments where id = m.tournament_id;
  if lim is null then raise exception 'This tournament has no dart limit'; end if;

  select * into l from legs where match_id = p_match order by leg_no desc limit 1;
  if l.winner is not null then raise exception 'This leg is already won'; end if;
  select coalesce(sum(darts) filter (where player = 1), 0), coalesce(sum(darts) filter (where player = 2), 0)
    into d1, d2 from visits where leg_id = l.id;
  if least(d1, d2) < lim then
    raise exception 'Both players need to have thrown % darts before a bull off', lim;
  end if;

  update legs set winner = p_winner, bull_off = true where id = l.id;
  perform after_leg_won(p_match, l.leg_no, l.starter);

  perform refresh_match_state(p_match);
end $$;

create or replace function public.undo_visit(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  v visits;
  l legs;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;

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

  select * into v from visits where match_id = p_match order by id desc limit 1;
  if not found then raise exception 'Nothing to undo'; end if;
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

drop function if exists public.create_friendly(text, text, text, int, int);
create or replace function public.create_friendly(
  p_password text,
  p_p1 text,
  p_p2 text,
  p_legs int default 3,
  p_start int default 501,
  p_sets int default null
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
  if p_legs is null or p_legs < 1 or p_legs > 10 then raise exception 'First to between 1 and 10 legs'; end if;
  if p_sets is not null and (p_sets < 1 or p_sets > 10) then raise exception 'First to between 1 and 10 sets'; end if;
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

  insert into matches (tournament_id, stage, round, slot, legs_to_win, sets_to_win, start_score, p1_name, p2_name, scorer_id)
  values (t, 'knockout', 1, 1, p_legs, p_sets, p_start, a, b, auth.uid())
  returning id into m;

  perform refresh_match_state(m);
  return m;
end $$;

revoke execute on function public.create_friendly(text, text, text, int, int, int) from public, anon;
grant  execute on function public.create_friendly(text, text, text, int, int, int) to authenticated;
