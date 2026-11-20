-- 045: odds model version 6 - figures as they were at any moment, Glicko
-- ratings, consistency, and the past rebuilt
--
-- * player_averages_at / player_form_at / player_sd_at: career figures,
--   recent form and the spread of visit scores using only darts thrown
--   before a given moment.
-- * glicko_at: a results-based rating for every player (Glicko), worked
--   through every finished match between two profiles up to a moment.
--   Each player starts at 1500 with a deviation of 350 (unknown); the
--   deviation shrinks as they play and grows back over time away.
-- * player_extra_json: rating, rating deviation and visit spread for two
--   players. match_preview now includes it, so new snapshots carry it.
-- * features_at: what the model would have known when a match started,
--   rebuilt from the darts before it. Used to rebuild snapshots for every
--   finished match that hasn't got one (marked backfilled).
-- * names_preview and tournament_odds_data also return rating, deviation
--   and spread for each player.
--
-- Run after migration-044.sql. Safe to run more than once.

alter table public.model_snapshots add column if not exists backfilled boolean not null default false;

create or replace function public.player_averages_at(p_ids uuid[], p_at timestamptz)
returns table(player_id uuid, darts integer, avg text, first9 text, dbl_pct text)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select case when vi.player = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end as pid,
           vi.score, vi.darts, vi.darts_at_double, vi.created_at,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null
      join visits vi on vi.match_id = m.id
     where m.player1_id = any (p_ids) or m.player2_id = any (p_ids) or m.counted_p1_id = any (p_ids) or m.counted_p2_id = any (p_ids)
  ),
  agg as (
    select pid, sum(darts)::int as darts, sum(score)::numeric as scored,
           sum(darts) filter (where n <= 3)::numeric as d9, sum(score) filter (where n <= 3)::numeric as s9,
           sum(darts_at_double)::int as dbl_at
      from ordered where pid = any (p_ids) and created_at < p_at group by pid
  ),
  hits as (
    select case when l.winner = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end as pid,
           count(*)::int as dbl_hit
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null
      join legs l on l.match_id = m.id
     where (m.player1_id = any (p_ids) or m.player2_id = any (p_ids) or m.counted_p1_id = any (p_ids) or m.counted_p2_id = any (p_ids))
       and l.winner is not null and not l.bull_off
       and (select max(v.created_at) from visits v where v.leg_id = l.id) < p_at
     group by 1
  )
  select a.pid, a.darts,
         case when a.darts > 0 then to_char(a.scored / a.darts * 3, 'FM990.00') end,
         case when a.d9 > 0 then to_char(a.s9 / a.d9 * 3, 'FM990.00') end,
         case when a.dbl_at > 0 then to_char(least(100, coalesce(h.dbl_hit, 0)::numeric / a.dbl_at * 100), 'FM990.0') || '%' end
    from agg a left join hits h on h.pid = a.pid;
$$;

create or replace function public.player_form_at(p_ids uuid[], p_at timestamptz, p_half_life integer default 42)
returns table(player_id uuid, wdarts numeric, avg text, first9 text, dbl_pct text)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select case when vi.player = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end as pid,
           vi.score, vi.darts, vi.darts_at_double, vi.created_at,
           power(0.5, greatest(0, extract(epoch from (p_at - vi.created_at))) / 86400.0 / greatest(p_half_life, 1)) as w,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and (not t.is_friendly or t.friendly_counted)
      join visits vi on vi.match_id = m.id
     where m.player1_id = any (p_ids) or m.player2_id = any (p_ids) or m.counted_p1_id = any (p_ids) or m.counted_p2_id = any (p_ids)
  ),
  agg as (
    select pid, sum(w * darts) as wd, sum(w * score) as ws,
           sum(w * darts) filter (where n <= 3) as wd9, sum(w * score) filter (where n <= 3) as ws9,
           sum(w * darts_at_double) as wdbl
      from ordered where pid = any (p_ids) and created_at < p_at group by pid
  ),
  hits as (
    select case when l.winner = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end as pid,
           sum(power(0.5, greatest(0, extract(epoch from (p_at - lv.last_at))) / 86400.0 / greatest(p_half_life, 1))) as whit
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and (not t.is_friendly or t.friendly_counted)
      join legs l on l.match_id = m.id
      join lateral (select max(v.created_at) as last_at from visits v where v.leg_id = l.id) lv on true
     where (m.player1_id = any (p_ids) or m.player2_id = any (p_ids) or m.counted_p1_id = any (p_ids) or m.counted_p2_id = any (p_ids))
       and l.winner is not null and not l.bull_off and lv.last_at < p_at
     group by 1
  )
  select a.pid, round(a.wd, 1),
         case when a.wd > 0 then to_char(a.ws / a.wd * 3, 'FM990.00') end,
         case when a.wd9 > 0 then to_char(a.ws9 / a.wd9 * 3, 'FM990.00') end,
         case when a.wdbl > 0 then to_char(least(100, coalesce(h.whit, 0) / a.wdbl * 100), 'FM990.0') || '%' end
    from agg a left join hits h on h.pid = a.pid;
$$;

-- Spread (standard deviation) of a player's scoring visits: busts and
-- checkouts left out. Needs 20 visits to say anything.
create or replace function public.player_sd_at(p_ids uuid[], p_at timestamptz)
returns table(player_id uuid, sd numeric)
language sql stable security definer set search_path = public as $$
  select pid, round(stddev_samp(score)::numeric, 1)
    from (
      select case when vi.player = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end as pid, vi.score
        from matches m
        join tournaments t on t.id = m.tournament_id and t.deleted_at is null
        join visits vi on vi.match_id = m.id
       where (m.player1_id = any (p_ids) or m.player2_id = any (p_ids) or m.counted_p1_id = any (p_ids) or m.counted_p2_id = any (p_ids))
         and not vi.is_bust and vi.remaining > 0 and vi.created_at < p_at
    ) x
   where pid = any (p_ids)
   group by pid
  having count(*) >= 20;
$$;

-- Glicko ratings as they stood at p_at. Every finished match between two
-- profiles is one result, in the order they finished.
create or replace function public.glicko_at(p_at timestamptz)
returns table(player_id uuid, rating numeric, rd numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  q constant numeric := ln(10) / 400;
  c2 constant numeric := 328;          -- deviation grows back to 350 over about a year away
  st jsonb := '{}'::jsonb;             -- player id -> [rating, deviation, last played (epoch)]
  x record;
  ra numeric; rda numeric; rb numeric; rdb numeric;
  ta numeric; tb numeric; tnow numeric;
  ga numeric; gb numeric; ea numeric; eb numeric; d2a numeric; d2b numeric; sa numeric;
  na numeric; nb numeric; nrda numeric; nrdb numeric;
begin
  for x in
    select m.player1_id a, m.player2_id b, (m.winner_id = m.player1_id) as a_won,
           extract(epoch from coalesce(m.finished_at, m.updated_at)) as ts
      from matches m join tournaments t on t.id = m.tournament_id and t.deleted_at is null
     where m.status = 'complete' and m.player1_id is not null and m.player2_id is not null and m.winner_id is not null
       and coalesce(m.finished_at, m.updated_at) < p_at
     order by coalesce(m.finished_at, m.updated_at)
  loop
    tnow := x.ts;
    ra := coalesce((st->x.a::text->>0)::numeric, 1500); rda := coalesce((st->x.a::text->>1)::numeric, 350);
    ta := coalesce((st->x.a::text->>2)::numeric, tnow);
    rb := coalesce((st->x.b::text->>0)::numeric, 1500); rdb := coalesce((st->x.b::text->>1)::numeric, 350);
    tb := coalesce((st->x.b::text->>2)::numeric, tnow);
    rda := least(350, sqrt(rda * rda + c2 * (tnow - ta) / 86400));
    rdb := least(350, sqrt(rdb * rdb + c2 * (tnow - tb) / 86400));
    ga := 1 / sqrt(1 + 3 * q * q * rdb * rdb / (pi() * pi()));
    gb := 1 / sqrt(1 + 3 * q * q * rda * rda / (pi() * pi()));
    ea := 1 / (1 + power(10, -ga * (ra - rb) / 400));
    eb := 1 / (1 + power(10, -gb * (rb - ra) / 400));
    d2a := 1 / (q * q * ga * ga * ea * (1 - ea));
    d2b := 1 / (q * q * gb * gb * eb * (1 - eb));
    sa := case when x.a_won then 1 else 0 end;
    na := ra + q / (1 / (rda * rda) + 1 / d2a) * ga * (sa - ea);
    nb := rb + q / (1 / (rdb * rdb) + 1 / d2b) * gb * ((1 - sa) - eb);
    nrda := greatest(30, sqrt(1 / (1 / (rda * rda) + 1 / d2a)));
    nrdb := greatest(30, sqrt(1 / (1 / (rdb * rdb) + 1 / d2b)));
    st := st || jsonb_build_object(x.a::text, jsonb_build_array(na, nrda, tnow), x.b::text, jsonb_build_array(nb, nrdb, tnow));
  end loop;
  tnow := extract(epoch from p_at);
  return query
    select k::uuid, round((v->>0)::numeric, 1),
           round(least(350, sqrt(power((v->>1)::numeric, 2) + c2 * greatest(0, tnow - (v->>2)::numeric) / 86400)), 1)
      from jsonb_each(st) as e(k, v);
end $$;

create or replace function public.player_extra_json(p_a uuid, p_b uuid, p_at timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with g as (select * from glicko_at(p_at) where player_id in (p_a, p_b)),
       s as (select * from player_sd_at(array[p_a, p_b], p_at))
  select jsonb_build_object(
    'p1_rating', (select rating from g where player_id = p_a), 'p1_rd', (select rd from g where player_id = p_a),
    'p2_rating', (select rating from g where player_id = p_b), 'p2_rd', (select rd from g where player_id = p_b),
    'p1_sd', (select sd from s where player_id = p_a), 'p2_sd', (select sd from s where player_id = p_b));
$$;

-- match_preview (and so new snapshots) carries rating, deviation and spread.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.match_preview(uuid)'::regprocedure), E'\r', '');
  if position('player_extra_json' in def) = 0 then
    def := replace(def, $r$  ) into res;$r$, $r$  ) || coalesce(player_extra_json(m.player1_id, m.player2_id, now()), '{}'::jsonb) into res;$r$);
    if position('player_extra_json' in def) = 0 then raise exception 'match_preview has changed shape'; end if;
    execute def;
  end if;
end $$;

-- What the model would have known when a match started.
create or replace function public.features_at(p_match uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m matches;
  t0 timestamptz;
  ids uuid[];
  av jsonb; fm jsonb;
  oom jsonb;
  res jsonb;
begin
  select * into m from matches where id = p_match;
  if not found or m.player1_id is null or m.player2_id is null then return null; end if;
  t0 := coalesce(m.started_at, (select min(created_at) from visits where match_id = m.id), m.updated_at);
  ids := array[m.player1_id, m.player2_id];
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into av from player_averages_at(ids, t0) x;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into fm from player_form_at(ids, t0) x;

  -- Order of merit as it stood: points from tournaments that had started
  -- (and points not tied to a tournament, which came across from the old site).
  with pts as (
    select o.player_id, sum(o.points) as total
      from oom_points o left join tournaments t on t.id = o.tournament_id
     where (o.tournament_id is null or (t.deleted_at is null and t.starts_at < t0))
     group by o.player_id having sum(o.points) > 0
  ), ranked as (
    select player_id, rank() over (order by total desc) as rk, count(*) over () as n from pts
  )
  select jsonb_build_object(
    'p1', coalesce((select 0.4 + 0.6 * case when n > 1 then 1 - (rk - 1)::numeric / (n - 1) else 1 end from ranked where player_id = m.player1_id), 0.3),
    'p2', coalesce((select 0.4 + 0.6 * case when n > 1 then 1 - (rk - 1)::numeric / (n - 1) else 1 end from ranked where player_id = m.player2_id), 0.3))
  into oom;

  res := jsonb_build_object(
    'p1', av->(m.player1_id::text), 'p2', av->(m.player2_id::text),
    'p1_form', fm->(m.player1_id::text), 'p2_form', fm->(m.player2_id::text),
    'p1_prov', (select provisional_avg from players where id = m.player1_id),
    'p2_prov', (select provisional_avg from players where id = m.player2_id),
    'p1_played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and m.player1_id in (x.player1_id, x.player2_id)
                     and x.player1_id is not null and x.player2_id is not null and coalesce(x.finished_at, x.updated_at) < t0),
    'p2_played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and m.player2_id in (x.player1_id, x.player2_id)
                     and x.player1_id is not null and x.player2_id is not null and coalesce(x.finished_at, x.updated_at) < t0),
    'p1_won', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                where x.status = 'complete' and x.winner_id = m.player1_id
                  and x.player1_id is not null and x.player2_id is not null and coalesce(x.finished_at, x.updated_at) < t0),
    'p2_won', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                where x.status = 'complete' and x.winner_id = m.player2_id
                  and x.player1_id is not null and x.player2_id is not null and coalesce(x.finished_at, x.updated_at) < t0),
    'h2h', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tournament', t.name, 'date', coalesce(x.finished_at, t.starts_at),
               'p1_legs', case when x.player1_id = m.player1_id then x.p1_legs else x.p2_legs end,
               'p2_legs', case when x.player1_id = m.player1_id then x.p2_legs else x.p1_legs end,
               'p1_won', x.winner_id = m.player1_id) order by coalesce(x.finished_at, t.starts_at) desc)
        from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
       where x.status = 'complete' and x.id <> m.id and coalesce(x.finished_at, x.updated_at) < t0
         and ((x.player1_id = m.player1_id and x.player2_id = m.player2_id)
           or (x.player1_id = m.player2_id and x.player2_id = m.player1_id))), '[]'::jsonb),
    'oom', oom,
    'legs_to_win', m.legs_to_win, 'sets_to_win', m.sets_to_win, 'start_score', m.start_score)
    || coalesce(player_extra_json(m.player1_id, m.player2_id, t0), '{}'::jsonb);
  return res;
end $$;

-- names_preview: each player also gets rating, deviation and spread.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.names_preview(uuid)'::regprocedure), E'\r', '');
  if position('glicko_at' in def) = 0 then
    def := replace(def, $r$  fm jsonb;$r$, $r$  fm jsonb;
  gl jsonb;
  sdm jsonb;$r$);
    def := replace(def, $r$  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into fm from player_form_for(ids) x;$r$,
      $r$  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into fm from player_form_for(ids) x;
  select coalesce(jsonb_object_agg(x.player_id, jsonb_build_object('rating', x.rating, 'rd', x.rd)), '{}') into gl
    from glicko_at(now()) x where x.player_id = any (ids);
  select coalesce(jsonb_object_agg(x.player_id, x.sd), '{}') into sdm from player_sd_at(ids, now()) x;$r$);
    def := replace(def, $r$               'form',   fm->(e->>'id'),$r$, $r$               'form',   fm->(e->>'id'),
               'rating', gl->(e->>'id')->'rating',
               'rd',     gl->(e->>'id')->'rd',
               'sd',     sdm->(e->>'id'),$r$);
    if position('glicko_at' in def) = 0 or position($r$'rating', gl$r$ in def) = 0 then raise exception 'names_preview has changed shape'; end if;
    execute def;
  end if;
end $$;

create or replace function public.tournament_odds_data(p_tournament uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  ids uuid[];
  av jsonb;
  fm jsonb;
  gl jsonb;
  sdm jsonb;
begin
  select array_agg(player_id) into ids from tournament_players where tournament_id = p_tournament;
  if ids is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into av from player_averages_for(ids) x;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into fm from player_form_for(ids) x;
  select coalesce(jsonb_object_agg(x.player_id, jsonb_build_object('rating', x.rating, 'rd', x.rd)), '{}') into gl
    from glicko_at(now()) x where x.player_id = any (ids);
  select coalesce(jsonb_object_agg(x.player_id, x.sd), '{}') into sdm from player_sd_at(ids, now()) x;
  return (
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'prov', p.provisional_avg,
             'career', av->(p.id::text), 'form', fm->(p.id::text),
             'played', coalesce(r.played, 0), 'won', coalesce(r.won, 0),
             'rating', gl->(p.id::text)->'rating', 'rd', gl->(p.id::text)->'rd', 'sd', sdm->(p.id::text)))
      from players p
      left join lateral (
        select count(*) as played, count(*) filter (where x.winner_id = p.id) as won
          from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
         where x.status = 'complete' and p.id in (x.player1_id, x.player2_id)
           and x.player1_id is not null and x.player2_id is not null
      ) r on true
     where p.id = any (ids));
end $$;

-- The few snapshots taken before this get rating, deviation and spread as
-- they stood when each match started.
update public.model_snapshots s
   set features = s.features || coalesce(public.player_extra_json(m.player1_id, m.player2_id, s.taken_at), '{}'::jsonb)
  from public.matches m
 where m.id = s.match_id and not s.backfilled and not (s.features ? 'p1_rating');

-- Rebuild a snapshot for every finished match between two profiles that
-- hasn't got one.
insert into public.model_snapshots (match_id, taken_at, features, backfilled)
select m.id, coalesce(m.started_at, m.updated_at), f, true
  from public.matches m
  join public.tournaments t on t.id = m.tournament_id and t.deleted_at is null
  cross join lateral (select public.features_at(m.id) as f) z
 where m.status = 'complete' and m.player1_id is not null and m.player2_id is not null
   and f is not null
   and not exists (select 1 from public.model_snapshots s where s.match_id = m.id)
on conflict do nothing;

revoke execute on function public.player_averages_at(uuid[], timestamptz) from public, anon, authenticated;
revoke execute on function public.player_form_at(uuid[], timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.player_sd_at(uuid[], timestamptz) from public, anon, authenticated;
revoke execute on function public.glicko_at(timestamptz) from public, anon, authenticated;
revoke execute on function public.player_extra_json(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.features_at(uuid) from public, anon, authenticated;
