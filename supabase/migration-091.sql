-- A player's results rating (Glicko) through the season, for the chart on
-- their profile: the rating at the end of each day they played, with the
-- events that day and whether they won one. Replays the same calculation
-- as glicko_at, keeping the points for one player as it goes.

create or replace function public.rating_history(p_player uuid, p_from date default '2026-08-01')
returns jsonb
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
  hat float8[] := '{}';   -- when, and the player's rating just after
  hr float8[] := '{}';
  start float8; me int;
begin
  select coalesce(array_agg(s.player_id), '{}'), coalesce(array_agg(s.rating::float8), '{}'),
         coalesce(array_agg(s.rd::float8), '{}'), coalesce(array_agg(extract(epoch from s.seeded_at)::float8), '{}')
    into ids, rs, rds, ts
    from player_seeds s;

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
    union all
    select r.player_id, r.opponent_player_id, r.legs_for > r.legs_against,
           extract(epoch from (e.played_on + time '12:00')::timestamptz + make_interval(mins => coalesce(r.seq, 0)))::float8,
           ceil(coalesce(r.best_of, 3) / 2.0)::float8,
           greatest(r.legs_for, r.legs_against)::float8, least(r.legs_for, r.legs_against)::float8
      from external_results r join external_events e on e.id = r.event_id and e.serious
     where r.opponent_player_id is not null and (r.avg is not null or e.source = 'Challonge') and r.legs_for <> r.legs_against
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
    -- The rating they started the season with: their last one before it.
    if start is null and (x.a = p_player or x.b = p_player) and tnow >= extract(epoch from p_from::timestamptz) then
      start := case when x.a = p_player then ra else rb end;
    end if;
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
    if x.a = p_player or x.b = p_player then
      hat := hat || tnow;
      hr := hr || case when x.a = p_player then rs[ix] else rs[ib] end;
    end if;
  end loop;

  return jsonb_build_object(
    'start', round(start::numeric, 1),
    'points', coalesce((
      with h as (
        select (to_timestamp(hat[i]) at time zone 'Europe/London')::date as d, hr[i] as r, i
          from generate_subscripts(hat, 1) i
         where to_timestamp(hat[i]) >= p_from::timestamptz),
      last as (select distinct on (d) d, r from h order by d, i desc),
      ev as (
        select (coalesce(t.starts_at, t.created_at) at time zone 'Europe/London')::date as d,
               string_agg(distinct t.name, ', ') as names,
               bool_or(t.champion_id = p_player) as won
          from tournaments t
         where t.deleted_at is null and not coalesce(t.is_friendly, false)
           and exists (select 1 from matches m where m.tournament_id = t.id and m.status = 'complete'
                         and p_player in (m.player1_id, m.player2_id))
         group by 1
        union all
        select e.played_on, string_agg(distinct e.event, ', '), false
          from external_events e where e.player_id = p_player and e.serious group by 1)
      select jsonb_agg(jsonb_build_object('d', l.d, 'r', round(l.r::numeric, 1),
                                          'event', (select string_agg(names, ', ') from ev where ev.d = l.d),
                                          'won', coalesce((select bool_or(won) from ev where ev.d = l.d), false))
                       order by l.d)
        from last l), '[]'::jsonb));
end $$;
revoke all on function public.rating_history(uuid, date) from public;
grant execute on function public.rating_history(uuid, date) to anon, authenticated;
