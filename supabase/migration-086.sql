-- Model figures cache, for busy nights.
--
-- Every preview and odds call used to work out each player's career and form
-- averages, results rating (replaying every match ever played), spread and
-- record from scratch. That's 20 to 80 ms on a quiet database, but in a load
-- test with 50 requests a second (a big tournament with a full room watching)
-- the tournament odds call averaged 770 ms and match previews 200 ms, all of
-- it competing with the scorers for the database.
--
-- Now one job works them out for every player every 30 seconds (only if a
-- dart has been thrown or a result changed since) and the previews read the
-- stored figures. If the job ever stops, the previews quietly go back to
-- working the figures out themselves after 3 minutes. Nothing here runs when
-- a visit is entered.

create table if not exists model_cache (
  player_id uuid primary key,
  career jsonb, form jsonb, rating numeric, rd numeric, sd numeric, played bigint, won bigint);
create table if not exists model_cache_meta (
  id int primary key default 1 check (id = 1), refreshed_at timestamptz, visit_mark bigint, match_mark timestamptz);
alter table model_cache enable row level security;
alter table model_cache_meta enable row level security;

-- The figures worked out from scratch (what the previews used to do).
create or replace function model_live(ids uuid[])
returns table(player_id uuid, career jsonb, form jsonb, rating numeric, rd numeric, sd numeric, played bigint, won bigint)
language sql stable security definer set search_path = public as $$
  with av as (select a.player_id, to_jsonb(a) j from player_averages_for(ids) a),
       fm as (select f.player_id, to_jsonb(f) j from player_form_for(ids) f),
       g as (select * from glicko_at(now()) x where x.player_id = any (ids)),
       s as (select * from player_sd_at(ids, now())),
       cnt as (
         select z.p, count(*) as played, count(*) filter (where z.winner_id = z.p) as won
           from (select unnest(array[x.player1_id, x.player2_id]) as p, x.winner_id
                   from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                  where x.status = 'complete' and x.player1_id is not null and x.player2_id is not null) z
          where z.p = any (ids) group by z.p)
  select i, av.j, fm.j, g.rating, g.rd, s.sd,
         coalesce(cnt.played, 0) + ext_played(i), coalesce(cnt.won, 0) + ext_won(i)
    from unnest(ids) i
    left join av on av.player_id = i left join fm on fm.player_id = i
    left join g on g.player_id = i left join s on s.player_id = i
    left join cnt on cnt.p = i
   where coalesce(cardinality(ids), 0) > 0;
$$;

create or replace function refresh_model_cache(p_force boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare vm bigint; mm timestamptz; meta model_cache_meta;
begin
  select max(id) into vm from visits;
  select max(updated_at) into mm from matches;
  select * into meta from model_cache_meta where id = 1;
  if not p_force and meta.refreshed_at > now() - interval '10 minutes'
     and meta.visit_mark is not distinct from vm and meta.match_mark is not distinct from mm then return; end if;
  if not pg_try_advisory_xact_lock(hashtext('model_cache')) then return; end if;
  delete from model_cache;
  insert into model_cache select * from model_live((select array_agg(id) from players));
  insert into model_cache_meta (id, refreshed_at, visit_mark, match_mark) values (1, now(), vm, mm)
  on conflict (id) do update set refreshed_at = excluded.refreshed_at, visit_mark = excluded.visit_mark, match_mark = excluded.match_mark;
end $$;
revoke all on function refresh_model_cache(boolean) from public, anon, authenticated;

-- What the previews read: the stored figures while they're fresh, worked out
-- live for anyone missing from them, or for everyone if the job has stopped.
create or replace function model_now(ids uuid[])
returns table(player_id uuid, career jsonb, form jsonb, rating numeric, rd numeric, sd numeric, played bigint, won bigint)
language plpgsql stable security definer set search_path = public as $$
declare missing uuid[];
begin
  if coalesce(cardinality(ids), 0) = 0 then return; end if;
  if exists (select 1 from model_cache_meta where id = 1 and refreshed_at > now() - interval '3 minutes') then
    return query select c.* from model_cache c where c.player_id = any (ids);
    missing := array(select i from unnest(ids) i where i is not null and not exists (select 1 from model_cache c where c.player_id = i));
    if cardinality(missing) > 0 then return query select * from model_live(missing); end if;
  else
    return query select * from model_live(ids);
  end if;
end $$;

create or replace function public.match_preview(p_match uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare
  m matches;
  mc jsonb; a jsonb; b jsonb;
begin
  select * into m from matches where id = p_match;
  if not found or m.player1_id is null or m.player2_id is null then return null; end if;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into mc from model_now(array[m.player1_id, m.player2_id]) x;
  a := coalesce(mc->(m.player1_id::text), '{}'); b := coalesce(mc->(m.player2_id::text), '{}');
  return jsonb_build_object(
    'p1', a->'career', 'p2', b->'career',
    'p1_prov', (select provisional_avg from players where id = m.player1_id),
    'p2_prov', (select provisional_avg from players where id = m.player2_id),
    'p1_form', a->'form', 'p2_form', b->'form',
    'p1_played', coalesce((a->>'played')::bigint, 0), 'p2_played', coalesce((b->>'played')::bigint, 0),
    'p1_won', coalesce((a->>'won')::bigint, 0), 'p2_won', coalesce((b->>'won')::bigint, 0),
    'h2h', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tournament', t.name,
               'date', coalesce(x.finished_at, t.starts_at),
               'p1_legs', case when x.player1_id = m.player1_id then x.p1_legs else x.p2_legs end,
               'p2_legs', case when x.player1_id = m.player1_id then x.p2_legs else x.p1_legs end,
               'p1_won', x.winner_id = m.player1_id)
             order by coalesce(x.finished_at, t.starts_at) desc)
        from matches x
        join tournaments t on t.id = x.tournament_id and t.deleted_at is null
       where x.status = 'complete' and x.id <> m.id
         and ((x.player1_id = m.player1_id and x.player2_id = m.player2_id)
           or (x.player1_id = m.player2_id and x.player2_id = m.player1_id))
    ), '[]'::jsonb) || ext_h2h(m.player1_id, m.player2_id),
    'p1_rating', a->'rating', 'p1_rd', a->'rd', 'p2_rating', b->'rating', 'p2_rd', b->'rd', 'p1_sd', a->'sd', 'p2_sd', b->'sd');
end $function$;

create or replace function public.tournament_odds_data(p_tournament uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare ids uuid[];
begin
  select array_agg(player_id) into ids from tournament_players where tournament_id = p_tournament;
  if ids is null then return '[]'::jsonb; end if;
  return (
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'prov', p.provisional_avg,
             'career', c.career, 'form', c.form, 'played', coalesce(c.played, 0), 'won', coalesce(c.won, 0),
             'rating', c.rating, 'rd', c.rd, 'sd', c.sd))
      from players p left join model_now(ids) c on c.player_id = p.id
     where p.id = any (ids));
end $function$;

create or replace function public.names_preview(p_match uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare
  m matches;
  out jsonb := '{}'::jsonb;
  k int;
  pid uuid;
  nm text;
  members jsonb;
  part text;
  ids uuid[];
  mc jsonb;
  a uuid;
  b uuid;
begin
  select * into m from matches where id = p_match;
  if not found then return null; end if;
  for k in 1 .. 2 loop
    pid := case k when 1 then m.player1_id else m.player2_id end;
    nm := case k when 1 then m.p1_name else m.p2_name end;
    members := '[]'::jsonb;
    if pid is not null then
      members := jsonb_build_array(jsonb_build_object('name', (select name from players where id = pid), 'id', pid));
    elsif nm is not null then
      for part in select btrim(x) from unnest(string_to_array(nm, ' & ')) x where btrim(x) <> '' loop
        pid := (select id from players where lower(name) = lower(part) limit 1);
        members := members || jsonb_build_object('id', pid,
          'name', coalesce((select name from players where id = pid), part));
      end loop;
    end if;
    if jsonb_array_length(members) = 0 then return null; end if;
    out := out || jsonb_build_object('side' || k, members);
  end loop;

  select array_agg((e->>'id')::uuid) into ids
    from jsonb_array_elements((out->'side1') || (out->'side2')) e where e->>'id' is not null;
  ids := coalesce(ids, array[]::uuid[]);
  select coalesce(jsonb_object_agg(c.player_id, to_jsonb(c)), '{}') into mc from model_now(ids) c;

  for k in 1 .. 2 loop
    out := out || jsonb_build_object('side' || k, (
      select jsonb_agg(e || jsonb_build_object(
               'career', mc->(e->>'id')->'career',
               'form',   mc->(e->>'id')->'form',
               'rating', mc->(e->>'id')->'rating',
               'rd',     mc->(e->>'id')->'rd',
               'sd',     mc->(e->>'id')->'sd',
               'prov',   (select provisional_avg from players where id = (e->>'id')::uuid),
               'played', coalesce((mc->(e->>'id')->>'played')::bigint, 0),
               'won',    coalesce((mc->(e->>'id')->>'won')::bigint, 0))
             order by ord)
        from jsonb_array_elements(out->('side' || k)) with ordinality as x(e, ord)));
  end loop;

  if jsonb_array_length(out->'side1') = 1 and jsonb_array_length(out->'side2') = 1 then
    a := (out->'side1'->0->>'id')::uuid;
    b := (out->'side2'->0->>'id')::uuid;
    if a is not null and b is not null then
      out := out || jsonb_build_object('h2h', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tournament', t.name,
                 'date', coalesce(x.finished_at, t.starts_at),
                 'p1_legs', case when x.player1_id = a then x.p1_legs else x.p2_legs end,
                 'p2_legs', case when x.player1_id = a then x.p2_legs else x.p1_legs end,
                 'p1_won', x.winner_id = a)
               order by coalesce(x.finished_at, t.starts_at) desc)
          from matches x
          join tournaments t on t.id = x.tournament_id and t.deleted_at is null
         where x.status = 'complete' and x.id <> m.id
           and ((x.player1_id = a and x.player2_id = b) or (x.player1_id = b and x.player2_id = a))
      ), '[]'::jsonb) || ext_h2h(a, b));
    end if;
  end if;
  return out;
end $function$;

create or replace function odds_board()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ids uuid[];
begin
  select array_agg(distinct p) into ids from (select player1_id p from bettable_matches() union select player2_id from bettable_matches()) u;
  if ids is null then return jsonb_build_object('matches', '[]'::jsonb); end if;
  return jsonb_build_object(
    'matches', (
      with c as (select * from model_now(ids)),
           vis as (
             select case when vi.player = 1 then coalesce(x.player1_id, x.counted_p1_id) else coalesce(x.player2_id, x.counted_p2_id) end pid, vi.score
               from matches x
               join tournaments t on t.id = x.tournament_id and t.deleted_at is null
               join visits vi on vi.match_id = x.id
              where coalesce(x.start_score, 501) = 501
                and (x.player1_id = any (ids) or x.player2_id = any (ids) or x.counted_p1_id = any (ids) or x.counted_p2_id = any (ids))),
           fig as (select pid, jsonb_build_object('v', count(*), 'tons', count(*) filter (where score >= 100), 'm180', count(*) filter (where score = 180)) j
                     from vis where pid = any (ids) group by pid)
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', m.id, 'tournament_id', m.tournament_id, 'tournament', m.tournament, 'starts_at', m.starts_at,
               'stage', m.stage, 'round', m.round, 'slot', m.slot, 'group_label', m.group_label, 'game_label', m.game_label, 'ko_rounds', m.ko_rounds,
               'legs_to_win', m.legs_to_win, 'sets_to_win', m.sets_to_win, 'start_score', m.start_score,
               'player1_id', m.player1_id, 'player2_id', m.player2_id, 'name1', m.p1_name, 'name2', m.p2_name,
               'figs', jsonb_build_object('p1', (select j from fig where pid = m.player1_id), 'p2', (select j from fig where pid = m.player2_id)),
               'preview', jsonb_build_object(
                 'p1', c1.career, 'p2', c2.career,
                 'p1_prov', (select provisional_avg from players where id = m.player1_id),
                 'p2_prov', (select provisional_avg from players where id = m.player2_id),
                 'p1_form', c1.form, 'p2_form', c2.form,
                 'p1_played', c1.played, 'p1_won', c1.won, 'p2_played', c2.played, 'p2_won', c2.won,
                 'p1_rating', c1.rating, 'p1_rd', c1.rd, 'p2_rating', c2.rating, 'p2_rd', c2.rd, 'p1_sd', c1.sd, 'p2_sd', c2.sd,
                 'h2h', coalesce((
                    select jsonb_agg(jsonb_build_object('date', coalesce(x.finished_at, t.starts_at),
                             'p1_legs', case when x.player1_id = m.player1_id then x.p1_legs else x.p2_legs end,
                             'p2_legs', case when x.player1_id = m.player1_id then x.p2_legs else x.p1_legs end))
                      from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                     where x.status = 'complete'
                       and ((x.player1_id = m.player1_id and x.player2_id = m.player2_id)
                         or (x.player1_id = m.player2_id and x.player2_id = m.player1_id))), '[]'::jsonb)
                   || ext_h2h(m.player1_id, m.player2_id)))
             order by m.starts_at, m.tournament, m.stage desc, m.round, m.slot), '[]'::jsonb)
        from bettable_matches() m
        left join c c1 on c1.player_id = m.player1_id
        left join c c2 on c2.player_id = m.player2_id),
    'oom', (select jsonb_agg(to_jsonb(o)) from oom_table() o));
end $$;

-- The job (pg_cron). It only does any work if something has changed.
create extension if not exists pg_cron;
select cron.schedule('refresh-model-cache', '30 seconds', 'select public.refresh_model_cache()');
select public.refresh_model_cache(true);
