-- Pairs friendlies: each side can be two players, stored as "A & B" (the
-- same way team fixtures store doubles, so the match page, odds and chat
-- already understand it). A pairs friendly can't be counted towards anyone's
-- stats, since the visits aren't split between the two players.
create or replace function public.create_friendly(p_password text, p_p1 text, p_p2 text, p_legs integer default 3, p_start integer default 501,
                                                  p_sets integer default null, p_remote boolean default false, p_remote_password text default null)
returns uuid language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  a text := btrim(coalesce(p_p1, ''));
  b text := btrim(coalesce(p_p2, ''));
  rpw text := btrim(coalesce(p_remote_password, ''));
  ma text[]; mb text[]; everyone text[];
  t uuid;
  m uuid;
begin
  if auth.uid() is null then raise exception 'You need to be signed in'; end if;
  if not friendlies_enabled() then raise exception 'Friendlies are switched off at the moment'; end if;
  if not friendly_pw_ok(p_password) then raise exception 'Wrong friendly password'; end if;
  if a = '' or b = '' then raise exception 'Enter both players'; end if;
  -- A side is one name, or two joined by " & ".
  ma := array(select btrim(x) from unnest(string_to_array(a, '&')) x);
  mb := array(select btrim(x) from unnest(string_to_array(b, '&')) x);
  if cardinality(ma) > 2 or cardinality(mb) > 2 then raise exception 'Pairs are two players a side'; end if;
  if cardinality(ma) <> cardinality(mb) then raise exception 'Both sides need the same number of players'; end if;
  everyone := ma || mb;
  if exists (select 1 from unnest(everyone) x where x = '') then raise exception 'Enter every player'; end if;
  if exists (select 1 from unnest(everyone) x where length(x) > 40) then raise exception 'Names can be up to 40 characters'; end if;
  if (select count(distinct lower(x)) from unnest(everyone) x) <> cardinality(everyone) then
    raise exception 'Every player needs a different name';
  end if;
  a := array_to_string(ma, ' & ');
  b := array_to_string(mb, ' & ');
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
end $function$;

create or replace function public.super_count_friendly(p_tournament uuid, p_counted boolean, p_p1 uuid default null, p_p2 uuid default null)
returns void language plpgsql security definer set search_path to 'public' as $function$
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
    if m.p1_name like '%&%' or m.p2_name like '%&%' then raise exception 'Pairs friendlies can''t be counted'; end if;
    if p_p1 is null and p_p2 is null then raise exception 'Pick a profile for at least one player'; end if;
    if p_p1 = p_p2 then raise exception 'The two players need different profiles'; end if;
    update matches set counted_p1_id = p_p1, counted_p2_id = p_p2 where id = m.id;
  else
    update matches set counted_p1_id = null, counted_p2_id = null where id = m.id;
  end if;
  update tournaments set friendly_counted = p_counted where id = t.id;
end $function$;
