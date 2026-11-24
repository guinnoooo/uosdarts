-- Migration 055: results from outside events (Darts Atlas pages).
--
-- external_events holds a player's summary for one event (average, first 9,
-- 100+/140+/180s, legs, breaks); external_results each match they played in
-- it. Only "serious" events count, and they count towards:
--   - career and recent-form averages and first 9 (so the OoM averages and
--     the betting model), with darts estimated from legs played and the
--     event average, so the event counts in proportion to how much was thrown;
--   - win rate (played / won), for every match with a recorded result;
--   - the head-to-head and the results rating, for matches between two
--     players who both have profiles.
-- They never count towards 180s, 100+ checkouts, sheet legs or the order of
-- merit, and doubles % is unchanged (the pages don't give darts at double).

create table if not exists public.external_events (
  id bigserial primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  event text not null,
  source text,
  played_on date not null,
  avg numeric not null,
  first9 numeric,
  tons integer, tons140 integer, max180 integer,
  legs_won integer not null,
  legs_lost integer not null,
  breaks integer,
  serious boolean not null default true,
  created_at timestamptz not null default now(),
  unique (player_id, event, played_on)
);
create table if not exists public.external_results (
  id bigserial primary key,
  event_id bigint not null references public.external_events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  round text,
  seq integer,                 -- order within the event
  best_of integer,
  opponent text not null,
  opponent_player_id uuid references public.players(id) on delete set null,
  legs_for integer not null,
  legs_against integer not null,
  avg numeric,                 -- null for a walkover
  opp_avg numeric
);
create index if not exists external_results_player_idx on public.external_results (player_id);
alter table public.external_events enable row level security;
alter table public.external_results enable row level security;

-- Scoring totals from outside events, in the same units the site's averages use.
create or replace function public.ext_stats(p_ids uuid[])
returns table(pid uuid, darts numeric, scored numeric, d9 numeric, s9 numeric)
language sql stable security definer set search_path = public as $$
  select e.player_id,
         (e.legs_won + e.legs_lost) * 1503.0 / e.avg,
         (e.legs_won + e.legs_lost) * 501.0,
         case when e.first9 is not null then (e.legs_won + e.legs_lost) * 9.0 end,
         case when e.first9 is not null then (e.legs_won + e.legs_lost) * 3.0 * e.first9 end
    from external_events e
   where e.serious and e.avg > 0 and (p_ids is null or e.player_id = any (p_ids));
$$;

-- The same, weighted by how recent it was (for recent form).
create or replace function public.ext_form(p_ids uuid[], p_half_life integer default 42)
returns table(pid uuid, wd float8, ws float8, wd9 float8, ws9 float8)
language sql stable security definer set search_path = public as $$
  select e.player_id,
         k.w * (e.legs_won + e.legs_lost) * 1503.0 / e.avg,
         k.w * (e.legs_won + e.legs_lost) * 501.0,
         case when e.first9 is not null then k.w * (e.legs_won + e.legs_lost) * 9.0 else 0 end,
         case when e.first9 is not null then k.w * (e.legs_won + e.legs_lost) * 3.0 * e.first9 else 0 end
    from external_events e
    cross join lateral (select power(0.5::float8, greatest(0, extract(epoch from (now() - (e.played_on + time '12:00')::timestamptz)))::float8
                                                  / 86400.0 / greatest(p_half_life, 1)) as w) k
   where e.serious and e.avg > 0 and (p_ids is null or e.player_id = any (p_ids));
$$;

-- Matches with a result, from outside events.
create or replace function public.ext_played(p_player uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from external_results r join external_events e on e.id = r.event_id and e.serious
   where r.player_id = p_player and r.avg is not null and r.legs_for <> r.legs_against;
$$;
create or replace function public.ext_won(p_player uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from external_results r join external_events e on e.id = r.event_id and e.serious
   where r.player_id = p_player and r.avg is not null and r.legs_for > r.legs_against;
$$;

-- Meetings between two players with profiles at outside events, as head-to-head entries.
create or replace function public.ext_h2h(p_a uuid, p_b uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'tournament', e.event, 'date', (e.played_on + time '12:00')::timestamptz,
           'p1_legs', r.legs_for, 'p2_legs', r.legs_against, 'p1_won', r.legs_for > r.legs_against)), '[]'::jsonb)
    from external_results r join external_events e on e.id = r.event_id and e.serious
   where r.player_id = p_a and r.opponent_player_id = p_b and r.legs_for <> r.legs_against;
$$;

revoke execute on function public.ext_stats(uuid[]) from public, anon, authenticated;
revoke execute on function public.ext_form(uuid[], integer) from public, anon, authenticated;

-- Averages: player_averages (OoM), player_averages_for (model) add the outside totals.
do $$
declare f text; def text;
begin
  foreach f in array array['public.player_averages()', 'public.player_averages_for(uuid[])'] loop
    def := replace(pg_get_functiondef(f::regprocedure), E'\r', '');
    if position('ext_stats' in def) > 0 then continue; end if;
    def := replace(def, $r$  hits as ($r$, format($r$  comb as (
    select pid, sum(darts)::int as darts, sum(scored) as scored, sum(d9) as d9, sum(s9) as s9, sum(dbl_at)::int as dbl_at
      from (select pid, darts::numeric, scored, d9, s9, dbl_at from agg
            union all
            select pid, darts, scored, d9, s9, 0 from ext_stats(%s)) u
     group by pid
  ),
  hits as ($r$, case when f like '%_for%' then 'p_ids' else 'null' end));
    def := replace(def, 'from agg a', 'from comb a');
    if position('from comb a' in def) = 0 or position('ext_stats(' in def) = 0 then raise exception '% has changed shape', f; end if;
    execute def;
  end loop;
end $$;

-- Recent form.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.player_form_for(uuid[], integer)'::regprocedure), E'\r', '');
  if position('ext_form' in def) = 0 then
    def := replace(def, $r$  hits as ($r$, $r$  comb as (
    select pid, sum(wd) as wd, sum(ws) as ws, sum(wd9) as wd9, sum(ws9) as ws9, sum(wdbl) as wdbl
      from (select pid, wd::float8, ws::float8, wd9::float8, ws9::float8, wdbl::float8 from agg
            union all
            select pid, wd, ws, wd9, ws9, 0 from ext_form(p_ids, p_half_life)) u
     group by pid
  ),
  hits as ($r$);
    def := replace(def, 'from agg a', 'from comb a');
    if position('from comb a' in def) = 0 then raise exception 'player_form_for has changed shape'; end if;
    execute def;
  end if;
end $$;

-- Win rate and head-to-head in the previews and tournament odds.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.match_preview(uuid)'::regprocedure), E'\r', '');
  if position('ext_played' in def) = 0 then
    def := replace(def, $r$is not null),
    'p2_played'$r$, $r$is not null) + ext_played(m.player1_id),
    'p2_played'$r$);
    def := replace(def, $r$is not null),
    'p1_won'$r$, $r$is not null) + ext_played(m.player2_id),
    'p1_won'$r$);
    def := replace(def, $r$is not null),
    'p2_won'$r$, $r$is not null) + ext_won(m.player1_id),
    'p2_won'$r$);
    def := replace(def, $r$is not null),
    'h2h'$r$, $r$is not null) + ext_won(m.player2_id),
    'h2h'$r$);
    def := replace(def, $r$    ), '[]'::jsonb)
  ) || coalesce(player_extra_json$r$, $r$    ), '[]'::jsonb) || ext_h2h(m.player1_id, m.player2_id)
  ) || coalesce(player_extra_json$r$);
    if (length(def) - length(replace(def, 'ext_', ''))) / 4 <> 5 then raise exception 'match_preview has changed shape'; end if;
    execute def;
  end if;

  def := replace(pg_get_functiondef('public.names_preview(uuid)'::regprocedure), E'\r', '');
  if position('ext_played' in def) = 0 then
    def := replace(def, $r$is not null),
               'won'$r$, $r$is not null) + ext_played((e->>'id')::uuid),
               'won'$r$);
    def := replace(def, $r$is not null))
             order by ord)$r$, $r$is not null) + ext_won((e->>'id')::uuid))
             order by ord)$r$);
    def := replace(def, $r$      ), '[]'::jsonb));$r$, $r$      ), '[]'::jsonb) || ext_h2h(a, b));$r$);
    if (length(def) - length(replace(def, 'ext_', ''))) / 4 <> 3 then raise exception 'names_preview has changed shape'; end if;
    execute def;
  end if;

  def := replace(pg_get_functiondef('public.tournament_odds_data(uuid)'::regprocedure), E'\r', '');
  if position('ext_played' in def) = 0 then
    def := replace(def, $r$'played', coalesce(r.played, 0), 'won', coalesce(r.won, 0),$r$,
                        $r$'played', coalesce(r.played, 0) + ext_played(p.id), 'won', coalesce(r.won, 0) + ext_won(p.id),$r$);
    if position('ext_played' in def) = 0 then raise exception 'tournament_odds_data has changed shape'; end if;
    execute def;
  end if;
end $$;

-- The results rating also counts meetings between two profiled players at outside events.
create or replace function public.glicko_at(p_at timestamptz)
returns table(player_id uuid, rating numeric, rd numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  q constant float8 := ln(10::float8) / 400;
  q2pi constant float8 := 3 * (ln(10::float8) / 400) ^ 2 / (pi() * pi());
  c2 constant float8 := 328;
  ids uuid[] := '{}';
  rs float8[] := '{}';
  rds float8[] := '{}';
  ts float8[] := '{}';
  ix int; ib int;
  x record;
  ra float8; rda float8; rb float8; rdb float8; tnow float8;
  ga float8; gb float8; ea float8; eb float8; sa float8; sw float8; w float8; da float8; db float8;
begin
  -- Ratings are kept in parallel arrays (float8 arithmetic, no jsonb copying), which is
  -- far faster than the first version.
  select coalesce(array_agg(s.player_id), '{}'), coalesce(array_agg(s.rating::float8), '{}'),
         coalesce(array_agg(s.rd::float8), '{}'), coalesce(array_agg(extract(epoch from s.seeded_at)::float8), '{}')
    into ids, rs, rds, ts
    from player_seeds s where s.seeded_at <= p_at;

  for x in
    select * from (
    select m.player1_id a, m.player2_id b, (m.winner_id = m.player1_id) as a_won,
           extract(epoch from coalesce(m.finished_at, m.updated_at))::float8 as at,
           (case when m.sets_to_win is not null then m.sets_to_win * coalesce(m.legs_to_win, 1) else coalesce(m.legs_to_win, 1) end)::float8 as target,
           (case when m.sets_to_win is not null then greatest(coalesce(m.p1_sets, 0), coalesce(m.p2_sets, 0))
                 else greatest(coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0)) end)::float8 as won_units,
           (case when m.sets_to_win is not null then least(coalesce(m.p1_sets, 0), coalesce(m.p2_sets, 0))
                 else least(coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0)) end)::float8 as lost_units
      from matches m join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
     where m.status = 'complete' and m.player1_id is not null and m.player2_id is not null and m.winner_id is not null
       and coalesce(m.finished_at, m.updated_at) < p_at
    union all
    -- Outside events, between two players with profiles: each meeting once.
    select r.player_id, r.opponent_player_id, r.legs_for > r.legs_against,
           extract(epoch from (e.played_on + time '12:00')::timestamptz + make_interval(mins => coalesce(r.seq, 0)))::float8,
           ceil(coalesce(r.best_of, 3) / 2.0)::float8,
           greatest(r.legs_for, r.legs_against)::float8, least(r.legs_for, r.legs_against)::float8
      from external_results r join external_events e on e.id = r.event_id and e.serious
     where r.opponent_player_id is not null and r.avg is not null and r.legs_for <> r.legs_against
       and (e.played_on + time '12:00')::timestamptz < p_at
       and (r.player_id < r.opponent_player_id
            or not exists (select 1 from external_results r2 join external_events e2 on e2.id = r2.event_id
                            where r2.player_id = r.opponent_player_id and r2.opponent_player_id = r.player_id
                              and e2.event = e.event and e2.played_on = e.played_on))
    ) g
     order by g.at
  loop
    tnow := x.at;
    ix := array_position(ids, x.a);
    if ix is null then ids := ids || x.a; rs := rs || 1500::float8; rds := rds || 350::float8; ts := ts || tnow; ix := cardinality(ids); end if;
    ib := array_position(ids, x.b);
    if ib is null then ids := ids || x.b; rs := rs || 1500::float8; rds := rds || 350::float8; ts := ts || tnow; ib := cardinality(ids); end if;
    ra := rs[ix]; rb := rs[ib];
    rda := least(350, sqrt(rds[ix] ^ 2 + c2 * greatest(0, tnow - ts[ix]) / 86400));
    rdb := least(350, sqrt(rds[ib] ^ 2 + c2 * greatest(0, tnow - ts[ib]) / 86400));

    w := least(1.5, sqrt(x.target / 3.0));
    sw := 1 - 0.25 * x.lost_units / greatest(x.won_units, 1);
    sa := case when x.a_won then sw else 1 - sw end;

    ga := 1 / sqrt(1 + q2pi * rdb * rdb);
    gb := 1 / sqrt(1 + q2pi * rda * rda);
    ea := 1 / (1 + 10 ^ (-ga * (ra - rb) / 400));
    eb := 1 / (1 + 10 ^ (-gb * (rb - ra) / 400));
    da := 1 / (rda * rda) + w * q * q * ga * ga * ea * (1 - ea);
    db := 1 / (rdb * rdb) + w * q * q * gb * gb * eb * (1 - eb);
    rs[ix] := ra + q / da * w * ga * (sa - ea);
    rs[ib] := rb + q / db * w * gb * ((1 - sa) - eb);
    rds[ix] := greatest(30, sqrt(1 / da));
    rds[ib] := greatest(30, sqrt(1 / db));
    ts[ix] := tnow; ts[ib] := tnow;
  end loop;
  tnow := extract(epoch from p_at);
  return query
    select ids[i], round(rs[i]::numeric, 1),
           round(least(350, sqrt(rds[i] ^ 2 + c2 * greatest(0, tnow - ts[i]) / 86400))::numeric, 1)
      from generate_subscripts(ids, 1) i;
end $$;

-- ---------------------------------------------------------------- data

-- Adam Khalil gets a profile, and the Franny game he played under his typed
-- name (Accy D's v Boobs, singles 4) is linked to it, so it counts for him.
insert into public.players (name) select 'Adam Khalil' where not exists (select 1 from public.players where lower(name) = 'adam khalil');
update public.matches
   set player1_id = (select id from public.players where name = 'Adam Khalil'), p1_name = null
 where id = 'bb80555c-4679-48fb-ab3d-b91b1562c34c' and p1_name = 'Adam Khalil' and player1_id is null;

-- UDUK Northern Singles and UDUK Manchester Masters (Darts Atlas), November 2026.
insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Jack Warby'), 'UDUK Manchester Masters', 'Darts Atlas', date '2026-11-15', 51.25, 55.44, 11, 2, 0, 8, 10, 4)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Thomas Marsh', null::uuid, 0, 2, 49.94, 63.96),
          ('Round 2', 2, 3, 'Archie Riley', null, 1, 2, 45.69, 47.97),
          ('Round 3', 3, 3, 'Nathan Bull', null, 2, 1, 68.75, 71.9),
          ('Round 4', 4, 3, 'Dilan Anderegg', null, 1, 2, 51.72, 53.46),
          ('Round 5', 5, 3, 'Oliver Clark', null, 0, 2, 40.25, 41.18),
          ('Round 6', 6, 3, 'Liam Elliott', null, 2, 0, null, null),
          ('Round 7', 7, 3, 'Shaun Middleman', null, 2, 1, 54.7, 53.36)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Jack Warby') and e.event = 'UDUK Manchester Masters' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Adam Butcher'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 42.83, 44.24, 2, 2, 0, 3, 11, 0)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 2', 2, 3, 'Tom Carter', null::uuid, 2, 1, 38.89, 41.57),
          ('Round 3', 3, 3, 'Robert Crook-Smith', null, 0, 2, 40.64, 45.55),
          ('Round 4', 4, 3, 'Josh Woodley', null, 0, 2, 52.33, 52.74),
          ('Round 5', 5, 3, 'Jacob Crinigan', null, 0, 2, 50.87, 65.35),
          ('Round 6', 6, 3, 'Mikey Guinness', (select id from players where name = 'Mikey Guinness'), 0, 2, 38.94, 62.63),
          ('Round 7', 7, 3, 'Jamie Ashman', null, 1, 2, 41.63, 42.03)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Adam Butcher') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'James Beer'), 'UDUK Manchester Masters', 'Darts Atlas', date '2026-11-15', 46.4, 54.67, 7, 2, 0, 5, 11, 2)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Rory Paver', null::uuid, 0, 2, 46.38, 47.71),
          ('Round 2', 2, 3, 'Alex Sharpe', null, 0, 2, 44.16, 50.95),
          ('Round 3', 3, 3, 'Josh Marshall', null, 0, 2, 45.52, 46.25),
          ('Round 4', 4, 3, 'Jordan Gill', null, 2, 0, 61.35, 54.5),
          ('Round 5', 5, 3, 'Ethan Leek', null, 1, 2, 40.92, 42.08),
          ('Round 6', 6, 3, 'Tom De ruyter', null, 0, 2, 48.0, 56.72),
          ('Round 7', 7, 3, 'Ibteshamul Chowdhury', null, 2, 1, 45.99, 45.93)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'James Beer') and e.event = 'UDUK Manchester Masters' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Matt Duke'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 53.71, 59.46, 15, 2, 0, 10, 9, 5)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 2', 2, 3, 'Daniel Cox', null::uuid, 1, 2, 61.3, 54.09),
          ('Round 3', 3, 3, 'Daniel Curry', null, 0, 2, 40.67, 45.55),
          ('Round 4', 4, 3, 'Jacob Walker', null, 2, 0, 49.28, 43.35),
          ('Round 5', 5, 3, 'Harry Jones', null, 2, 0, 48.48, 48.3),
          ('Round 6', 6, 3, 'Daniel Dench', null, 2, 0, 51.83, 48.89),
          ('Round 7', 7, 3, 'Jack Birks', null, 0, 2, 52.33, 53.68),
          ('Last 64', 46, 3, 'Jacob Preston', null, 2, 0, 60.12, 54.06),
          ('Last 32', 78, 5, 'Toby Saunders', null, 1, 3, 63.89, 77.6)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Matt Duke') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Ben O''Callaghan'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 49.62, 54.75, 11, 2, 0, 6, 10, 3)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Louis Flynn', null::uuid, 1, 2, 47.16, 48.56),
          ('Round 2', 2, 3, 'Jem Forrest', null, 0, 2, 49.0, 73.32),
          ('Round 3', 3, 3, 'Joshua Skinner', null, 0, 2, 53.33, 53.68),
          ('Round 4', 4, 3, 'Will Agar', null, 2, 1, 50.72, 48.7),
          ('Round 6', 6, 3, 'Liam Elliott', null, 1, 2, 57.12, 54.19),
          ('Round 7', 7, 3, 'Thomas Mitchell', null, 2, 1, 43.5, 42.06)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Ben O''Callaghan') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Lewis Forrest'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 67.55, 77.11, 34, 15, 1, 26, 9, 13)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Thomas Marsh', null::uuid, 2, 0, 65.35, 59.07),
          ('Round 2', 2, 3, 'Orlando Hudson', null, 2, 0, 61.35, 52.88),
          ('Round 4', 4, 3, 'Josh Atha', null, 2, 0, 63.96, 42.73),
          ('Round 4', 4, 3, 'Jono Downing', null, 2, 0, 65.35, 52.73),
          ('Round 5', 5, 3, 'Thomas Allan', null, 2, 0, 85.89, 61.82),
          ('Round 6', 6, 3, 'Tom Fitzpatrick', null, 2, 0, 68.32, 45.47),
          ('Last 64', 46, 3, 'Joe Bannerman', null, 2, 0, 75.15, 37.38),
          ('Last 32', 78, 5, 'Ben Colbourne', null, 3, 0, 57.81, 50.92),
          ('Last 16', 94, 7, 'Jordan Gill', null, 4, 2, 71.71, 59.14),
          ('Quarter-Final', 100, 9, 'Charlie Taylor', null, 5, 1, 68.47, 58.72),
          ('Semi-Final', 101, 11, 'James Buckby', null, 0, 6, 65.85, 84.28)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Lewis Forrest') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Mike Britland'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 37.01, 45.52, 2, 0, 0, 4, 10, 0)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Danny Clifford', null::uuid, 0, 2, 45.8, 50.95),
          ('Round 2', 2, 3, 'Oak Slaney', null, 0, 2, 37.08, 40.08),
          ('Round 3', 3, 3, 'Tristan Rouviere-Hyde', null, 2, 1, 33.36, 31.33),
          ('Round 5', 5, 3, 'Ross Lea', null, 0, 2, 33.17, 33.03),
          ('Round 6', 6, 3, 'Harry Harper', null, 0, 2, 38.5, 45.55),
          ('Round 7', 7, 3, 'Evan Harfield', null, 2, 1, 38.87, 38.58)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Mike Britland') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Mikey Guinness'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 61.16, 64.52, 16, 4, 1, 12, 10, 5)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Jacob Crinigan', null::uuid, 1, 2, 68.64, 72.48),
          ('Round 2', 2, 3, 'Josh Woodley', null, 2, 1, 69.0, 58.55),
          ('Round 3', 3, 3, 'Jamie Ashman', null, 1, 2, 61.31, 61.16),
          ('Round 5', 5, 3, 'Robert Crook-Smith', null, 2, 1, 63.85, 59.48),
          ('Round 6', 6, 3, 'Adam Butcher', (select id from players where name = 'Adam Butcher'), 2, 0, 62.63, 38.94),
          ('Round 7', 7, 3, 'Tom Carter', null, 2, 0, 57.81, 45.41),
          ('Last 64', 46, 3, 'Logan Morrison', null, 2, 1, 57.76, 57.0),
          ('Last 32', 78, 5, 'Kian Potts', null, 0, 3, 50.56, 59.33)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Mikey Guinness') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Adam Khalil'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 55.0, 67.88, 17, 10, 1, 15, 12, 7)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Harry Westcott-French', null::uuid, 1, 2, 57.59, 61.39),
          ('Round 3', 3, 3, 'Jacob Preston', null, 2, 0, 50.95, 51.79),
          ('Round 4', 4, 3, 'Zachary Larter', null, 2, 0, 66.8, 46.79),
          ('Round 5', 5, 3, 'Henry Casement', null, 0, 2, 55.08, 79.11),
          ('Round 6', 6, 3, 'Luke Egan', (select id from players where name = 'Luke Egan'), 2, 0, 53.68, 54.33),
          ('Round 7', 7, 3, 'Jed Botha', null, 0, 2, 62.57, 66.8),
          ('Last 64', 46, 3, 'Daniel Cox', null, 2, 1, 43.66, 44.16),
          ('Last 32', 78, 5, 'Leo Holland', null, 3, 1, 50.05, 46.65),
          ('Last 16', 94, 7, 'Kian Potts', null, 3, 4, 61.67, 60.49)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Adam Khalil') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Oliver Pratt'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 39.47, 47.54, 4, 0, 0, 2, 11, 1)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Charlie Hall', null::uuid, 0, 2, 44.78, 54.65),
          ('Round 2', 2, 3, 'Daniel Scott', null, 0, 2, 34.5, 37.58),
          ('Round 3', 3, 3, 'Charles Brimble', null, 2, 1, 37.95, 41.75),
          ('Round 5', 5, 3, 'Logan Morrison', null, 0, 2, 45.93, 68.32),
          ('Round 6', 6, 3, 'Drew Brion', null, 0, 2, 40.59, 45.55),
          ('Round 7', 7, 3, 'Armaan Sohi', null, 0, 2, 38.1, 50.1)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Oliver Pratt') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);

insert into public.external_events (player_id, event, source, played_on, avg, first9, tons, tons140, max180, legs_won, legs_lost, breaks)
values ((select id from players where name = 'Luke Egan'), 'UDUK Northern Singles', 'Darts Atlas', date '2026-11-15', 53.78, 62.24, 8, 1, 2, 7, 7, 2)
on conflict (player_id, event, played_on) do nothing;

insert into public.external_results (event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
select e.id, e.player_id, v.* from public.external_events e,
  (values ('Round 1', 1, 3, 'Zachary Larter', null::uuid, 2, 0, 50.95, 49.47),
          ('Round 2', 2, 3, 'Jed Botha', null, 2, 0, 63.96, 53.38),
          ('Round 3', 3, 3, 'Henry Casement', null, 2, 1, 54.39, 63.09),
          ('Round 4', 4, 3, 'Harry Westcott-French', null, 0, 2, 46.08, 81.24),
          ('Round 6', 6, 3, 'Adam Khalil', (select id from players where name = 'Adam Khalil'), 0, 2, 54.33, 53.68),
          ('Round 7', 7, 3, 'Jacob Preston', null, 1, 2, 52.36, 61.52)) v(round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against, avg, opp_avg)
 where e.player_id = (select id from players where name = 'Luke Egan') and e.event = 'UDUK Northern Singles' and e.played_on = date '2026-11-15'
   and not exists (select 1 from public.external_results x where x.event_id = e.id);
