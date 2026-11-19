-- 028: deleted tournaments drop out of every stat straight away
--
-- Deleting a tournament (or a friendly / team match from the admin page)
-- only marks it deleted for 24 hours, so it can be restored. Averages,
-- first 9 and doubles already ignored it straight away, but 180s, 100+
-- checkouts, high checkout, sheet legs and PC/major bests kept counting it
-- until it was cleared for good. Now they ignore it too, and restoring it
-- brings everything back.
--
-- Safe to run more than once.

-- Same columns as before, now leaving out deleted tournaments.
create or replace view public.player_visits as
select case when v.player = 1 then m.player1_id else m.player2_id end as player_id,
       m.tournament_id,
       v.leg_id,
       v.score,
       v.darts,
       v.remaining,
       v.is_bust,
       v.darts_at_double
  from visits v
  join matches m on m.id = v.match_id
  join tournaments t on t.id = m.tournament_id and t.deleted_at is null;

create or replace function public.player_stats(p_season text default '2026/27')
returns table (player_slug text, player_name text, hit_180s integer, checkouts_100_plus integer,
               sheet_legs integer, high_checkout integer, pc_best text, pc_wins integer,
               major_best text, major_wins integer)
language sql stable security definer set search_path = public as $$
  with scoring as (
    select
      pv.player_id,
      count(*) filter (where pv.score = 180)::int                        as hit_180s,
      count(*) filter (where pv.remaining = 0 and pv.score >= 100)::int  as checkouts_100_plus,
      coalesce(max(pv.score) filter (where pv.remaining = 0), 0)::int    as high_checkout
    from player_visits pv
    group by pv.player_id
  ),
  -- A sheet leg is one won in 21 darts or fewer.
  leg_darts as (
    select
      case when l.winner = 1 then m.player1_id else m.player2_id end as player_id,
      sum(v.darts) filter (where v.player = l.winner) as darts
    from legs l
    join matches m on m.id = l.match_id
    join tournaments t on t.id = m.tournament_id and t.deleted_at is null
    join visits v on v.leg_id = l.id
    where l.winner is not null and not l.bull_off
    group by l.id, m.player1_id, m.player2_id, l.winner
  ),
  sheets as (
    select player_id, count(*)::int as sheet_legs
      from leg_darts where darts is not null and darts <= 21
     group by player_id
  ),
  runs as (
    select
      o.player_id,
      min(reached_order(o.reached)) filter (where o.is_pc)    as pc_best_ord,
      count(*) filter (where o.is_pc and o.reached = 'winner')::int    as pc_wins,
      min(reached_order(o.reached)) filter (where o.is_major) as major_best_ord,
      count(*) filter (where o.is_major and o.reached = 'winner')::int as major_wins
    from oom_points o
    where o.season = p_season
      and not exists (select 1 from tournaments t where t.id = o.tournament_id and t.deleted_at is not null)
    group by o.player_id
  )
  select
    p.slug, p.name,
    coalesce(s.hit_180s, 0)           + p.base_180s,
    coalesce(s.checkouts_100_plus, 0) + p.base_100_plus,
    coalesce(sh.sheet_legs, 0)        + p.base_sheet_legs,
    coalesce(s.high_checkout, 0),
    case when r.pc_best_ord is null then null else reached_label(
      (select k from (values ('winner',0),('final',1),('semi',2),('quarter',3),
                             ('last_16',4),('last_32',5),('last_64',6)) v(k, o)
        where o = r.pc_best_ord)) end,
    coalesce(r.pc_wins, 0),
    case when r.major_best_ord is null then null else reached_label(
      (select k from (values ('winner',0),('final',1),('semi',2),('quarter',3),
                             ('last_16',4),('last_32',5),('last_64',6)) v(k, o)
        where o = r.major_best_ord)) end,
    coalesce(r.major_wins, 0)
  from players p
  left join scoring s on s.player_id = p.id
  left join sheets  sh on sh.player_id = p.id
  left join runs    r on r.player_id = p.id;
$$;
