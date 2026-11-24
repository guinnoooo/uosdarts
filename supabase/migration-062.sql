-- Fantasy scoring, as agreed:
--   match won 2, leg won 1, 140+ visit 1, 180 3, 100+ checkout 5,
--   winning the event 10,
--   match average 50+ 1, 60+ 2, 70+ 4, 80+ 6 (the highest band reached),
--   a leg won in 19 to 21 darts 2, 16 to 18 darts 4, 15 or fewer 8.
-- Runner-up no longer scores. Leg darts only count in 501 games, from
-- the darts that player threw in the leg. Role bonuses are unchanged.

drop function if exists public.fantasy_player_points(date);
create or replace function public.fantasy_player_points(p_gw date)
returns table(player_id uuid, played boolean, points integer, power integer, finish integer, dark integer, tricky integer, detail jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (select id, champion_id, status from fantasy_events(p_gw)),
  ms as (
    select m.*, coalesce(m.player1_id, m.counted_p1_id) as a, coalesce(m.player2_id, m.counted_p2_id) as b
      from matches m join ev on ev.id = m.tournament_id
     where m.status = 'complete' and m.winner_id is not null
       and (m.player1_id is not null or m.counted_p1_id is not null or m.p1_name is not null)
       and (m.player2_id is not null or m.counted_p2_id is not null or m.p2_name is not null)),
  vis as (
    select v.match_id, v.player as s,
           count(*) filter (where v.score = 180 and not v.is_bust) as t180,
           count(*) filter (where v.score between 140 and 179 and not v.is_bust) as t140,
           count(*) filter (where v.remaining = 0 and v.score >= 100 and not v.is_bust) as bigout,
           case when sum(v.darts) > 0 then sum(v.score)::numeric / sum(v.darts) * 3 end as avg
      from visits v where v.match_id in (select id from ms)
     group by v.match_id, v.player),
  -- Darts each player took to win each leg they won (501 games only).
  legdarts as (
    select l.match_id, l.winner as s, sum(v.darts) as darts
      from legs l join ms on ms.id = l.match_id and ms.start_score = 501
      join visits v on v.leg_id = l.id and v.player = l.winner
     where l.winner is not null and not l.bull_off
     group by l.id, l.match_id, l.winner),
  quick as (
    select match_id, s,
           count(*) filter (where darts between 19 and 21) as d21,
           count(*) filter (where darts between 16 and 18) as d18,
           count(*) filter (where darts <= 15) as d15
      from legdarts group by match_id, s),
  side as (
    select ms.id as match_id, 1 as s, ms.a as pid, ms.p1_legs as legs, ms.winner_id = ms.a as won, o.p1_win as chance
      from ms left join match_odds o on o.match_id = ms.id where ms.a is not null
    union all
    select ms.id, 2, ms.b, ms.p2_legs, ms.winner_id = ms.b, 1 - o.p1_win
      from ms left join match_odds o on o.match_id = ms.id where ms.b is not null),
  per as (
    select x.pid, x.won, coalesce(x.legs, 0) as legs,
           coalesce(v.t180, 0) as t180, coalesce(v.t140, 0) as t140, coalesce(v.bigout, 0) as bigout, v.avg,
           coalesce(q.d21, 0) as d21, coalesce(q.d18, 0) as d18, coalesce(q.d15, 0) as d15,
           x.won and x.chance < 0.5 as upset,
           x.won and v.avg is not null and ov.avg is not null and v.avg < ov.avg as tricky
      from side x
      left join vis v on v.match_id = x.match_id and v.s = x.s
      left join vis ov on ov.match_id = x.match_id and ov.s = 3 - x.s
      left join quick q on q.match_id = x.match_id and q.s = x.s),
  agg as (
    select pid,
           count(*) filter (where won) as wins, sum(legs) as legs, sum(t180) as t180, sum(t140) as t140, sum(bigout) as bigout,
           count(*) filter (where avg >= 80) as avg80,
           count(*) filter (where avg >= 70 and avg < 80) as avg70,
           count(*) filter (where avg >= 60 and avg < 70) as avg60,
           count(*) filter (where avg >= 50 and avg < 60) as avg50,
           sum(d21) as d21, sum(d18) as d18, sum(d15) as d15,
           count(*) filter (where upset) as upsets, count(*) filter (where tricky) as trickies,
           (select count(*) from ev where ev.champion_id = per.pid and ev.status = 'complete') as titles
      from per group by pid)
  select pid, true,
         (2 * wins + legs + t140 + 3 * t180 + 5 * bigout + 10 * titles
          + avg50 + 2 * avg60 + 4 * avg70 + 6 * avg80 + 2 * d21 + 4 * d18 + 8 * d15)::int,
         (t140 + 3 * t180)::int, (5 * bigout)::int, (2 * upsets)::int, (2 * trickies)::int,
         jsonb_build_object('wins', wins, 'legs', legs, '140+', t140, '180s', t180, '100+ outs', bigout,
                            '50+ avg', avg50, '60+ avg', avg60, '70+ avg', avg70, '80+ avg', avg80,
                            '19-21 darters', d21, '16-18 darters', d18, '15 or under', d15,
                            'upset wins', upsets, 'lower-average wins', trickies, 'titles', titles)
    from agg;
$$;
