-- 020: more for the tournament summary
--
-- * tournament_summary() also returns sheet legs (legs won in 21 darts or
--   fewer, not counting bull offs). Its columns change, so it's dropped and
--   made again.
-- * tournament_match_averages(): every player's average in each match of a
--   tournament, for the "best single-match averages" list.
--
-- Safe to run more than once.

drop function if exists public.tournament_summary(uuid);

create or replace function public.tournament_summary(p_tournament uuid)
returns table (
  player_id     uuid,
  player_name   text,
  played        int,
  won           int,
  legs_won      int,
  legs_lost     int,
  darts         int,
  scored        int,
  first9_darts  int,
  first9_scored int,
  s100          int,
  s140          int,
  s180          int,
  hi_checkout   int,
  ton_checkouts int,
  best_leg      int,
  sheet_legs    int
)
language sql stable security definer set search_path = public as $$
  with m as (
    select * from matches
     where tournament_id = p_tournament and player1_id is not null and player2_id is not null
  ),
  v as (
    select vi.*, case when vi.player = 1 then m.player1_id else m.player2_id end as pid,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from visits vi join m on m.id = vi.match_id
  ),
  pv as (
    select pid,
           sum(v.darts)::int                                       as darts,
           sum(v.score)::int                                       as scored,
           sum(v.darts) filter (where n <= 3)::int                 as d9,
           sum(v.score) filter (where n <= 3)::int                 as s9,
           count(*) filter (where v.score between 100 and 139)::int as s100,
           count(*) filter (where v.score between 140 and 179)::int as s140,
           count(*) filter (where v.score = 180)::int              as s180,
           max(v.score) filter (where v.remaining = 0)::int        as hi,
           count(*) filter (where v.remaining = 0 and v.score >= 100)::int as tons
      from v group by pid
  ),
  bl as (
    select case when l.winner = 1 then m.player1_id else m.player2_id end as pid,
           min(x.d)::int as best,
           count(*) filter (where x.d <= 21)::int as sheets
      from legs l
      join m on m.id = l.match_id
      join lateral (select sum(vi.darts) as d from visits vi where vi.leg_id = l.id and vi.player = l.winner) x on true
     where l.winner is not null and not l.bull_off and x.d is not null
     group by 1
  ),
  mr as (
    select pid, count(*)::int as played, count(*) filter (where w)::int as won,
           sum(lw)::int as lw, sum(ll)::int as ll
      from (
        select player1_id as pid, winner_id = player1_id as w, p1_legs as lw, p2_legs as ll from m where status = 'complete'
        union all
        select player2_id, winner_id = player2_id, p2_legs, p1_legs from m where status = 'complete'
      ) z
     group by pid
  ),
  ids as (select pid from pv union select pid from mr)
  select p.id, p.name,
         coalesce(mr.played, 0), coalesce(mr.won, 0), coalesce(mr.lw, 0), coalesce(mr.ll, 0),
         coalesce(pv.darts, 0), coalesce(pv.scored, 0), coalesce(pv.d9, 0), coalesce(pv.s9, 0),
         coalesce(pv.s100, 0), coalesce(pv.s140, 0), coalesce(pv.s180, 0),
         pv.hi, coalesce(pv.tons, 0), bl.best, coalesce(bl.sheets, 0)
    from ids
    join players p on p.id = ids.pid
    left join pv on pv.pid = ids.pid
    left join mr on mr.pid = ids.pid
    left join bl on bl.pid = ids.pid;
$$;

grant execute on function public.tournament_summary(uuid) to anon, authenticated;

create or replace function public.tournament_match_averages(p_tournament uuid)
returns table (
  match_id    uuid,
  player_id   uuid,
  player_name text,
  opponent    text,
  darts       int,
  scored      int
)
language sql stable security definer set search_path = public as $$
  select m.id,
         case when v.player = 1 then m.player1_id else m.player2_id end,
         case when v.player = 1 then p1.name else p2.name end,
         case when v.player = 1 then p2.name else p1.name end,
         sum(v.darts)::int, sum(v.score)::int
    from matches m
    join visits v on v.match_id = m.id
    join players p1 on p1.id = m.player1_id
    join players p2 on p2.id = m.player2_id
   where m.tournament_id = p_tournament
   group by m.id, v.player, m.player1_id, m.player2_id, p1.name, p2.name;
$$;

grant execute on function public.tournament_match_averages(uuid) to anon, authenticated;
