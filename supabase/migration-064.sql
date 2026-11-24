-- Dark Horse: in a match they won as the underdog, their legs won score
-- triple as well as the match win. Only the 'dark' part of
-- fantasy_player_points changes.

create or replace function public.fantasy_player_points(p_gw date, p_europa boolean default false)
returns table(player_id uuid, played boolean, points integer, power integer, finish integer, dark integer, detail jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (
    select id, champion_id, status from fantasy_events(p_gw) where not p_europa
    union all
    select id, champion_id, status from fantasy_europa_events(p_gw) where p_europa),
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
           case when x.won and x.chance < 0.5 then coalesce(x.legs, 0) else 0 end as upset_legs
      from side x
      left join vis v on v.match_id = x.match_id and v.s = x.s
      left join quick q on q.match_id = x.match_id and q.s = x.s),
  agg as (
    select pid,
           count(*) filter (where won) as wins, sum(legs) as legs, sum(t180) as t180, sum(t140) as t140, sum(bigout) as bigout,
           count(*) filter (where avg >= 80) as avg80,
           count(*) filter (where avg >= 70 and avg < 80) as avg70,
           count(*) filter (where avg >= 60 and avg < 70) as avg60,
           count(*) filter (where avg >= 50 and avg < 60) as avg50,
           sum(d21) as d21, sum(d18) as d18, sum(d15) as d15,
           count(*) filter (where upset) as upsets, sum(upset_legs) as upset_legs,
           (select count(*) from ev where ev.champion_id = per.pid and ev.status = 'complete') as titles
      from per group by pid),
  val as (select fantasy_pts('win') win, fantasy_pts('leg') leg, fantasy_pts('t140') t140, fantasy_pts('t180') t180,
               fantasy_pts('out100') out100, fantasy_pts('title') title, fantasy_pts('avg50') avg50, fantasy_pts('avg60') avg60,
               fantasy_pts('avg70') avg70, fantasy_pts('avg80') avg80, fantasy_pts('d21') d21, fantasy_pts('d18') d18, fantasy_pts('d15') d15)
  select a.pid, true,
         (val.win * a.wins + val.leg * a.legs + val.t140 * a.t140 + val.t180 * a.t180 + val.out100 * a.bigout + val.title * a.titles
          + val.avg50 * a.avg50 + val.avg60 * a.avg60 + val.avg70 * a.avg70 + val.avg80 * a.avg80
          + val.d21 * a.d21 + val.d18 * a.d18 + val.d15 * a.d15)::int,
         (val.t140 * a.t140 + val.t180 * a.t180)::int, (val.out100 * a.bigout)::int, (val.win * a.upsets + val.leg * a.upset_legs)::int,
         jsonb_build_object('wins', a.wins, 'legs', a.legs, '140+', a.t140, '180s', a.t180, '100+ outs', a.bigout,
                            '50+ avg', a.avg50, '60+ avg', a.avg60, '70+ avg', a.avg70, '80+ avg', a.avg80,
                            '19-21 darters', a.d21, '16-18 darters', a.d18, '15 or under', a.d15,
                            'upset wins', a.upsets, 'titles', a.titles)
    from agg a cross join val;
$$;

