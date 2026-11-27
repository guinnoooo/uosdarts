-- Player profiles: right W/L on friendlies, and dated OoM points.
--
-- 1. Recent matches showed friendlies as losses. Counted friendlies have no
--    winner_id (the sides can be typed names), so `winner_id = player` was
--    null. match_winner_side() already falls back to the score, so the
--    profile uses that.
-- 2. OoM points carried in from before the site (PCs 1 to 7) had no date.
--    oom_points.played_on holds the event date, filled from the Challonge
--    imports of the same PCs (PC 1 had no import; PCs are weekly on Mondays,
--    so it is the Monday before PC 2). The profile uses it, and returns the
--    season's first and latest OoM dates so the chart can run week by week.

alter table oom_points add column if not exists played_on date;

update oom_points op set played_on = x.d
  from (select e.event, min(e.played_on) as d from external_events e where e.event ~ '^PC [0-9]+$' group by e.event) x
 where op.tournament_id is null and op.played_on is null
   and x.event = 'PC ' || substring(op.event_name from '([0-9]+)$')
   and op.event_name ~ '^(Players Championship|PC) [0-9]+$';

update oom_points set played_on = date '2026-09-28'
 where tournament_id is null and played_on is null and event_name = 'Players Championship 1' and season = '2026/27';

update oom_points op set played_on = t.starts_at::date
  from tournaments t where t.id = op.tournament_id and op.played_on is null;

alter table oom_points alter column played_on set default current_date;

create or replace function public.player_profile(p_slug text, p_season text default '2026/27')
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare p players; season_start date := make_date(left(p_season, 4)::int, 8, 1);
begin
  select * into p from players where slug = p_slug;
  if not found then return null; end if;
  return jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug, 'nickname', p.nickname, 'year', p.year),
    'career', (select to_jsonb(a) - 'player_id' - 'player_slug' from player_averages_for(array[p.id]) a),
    'stats', (select to_jsonb(s) - 'player_slug' - 'player_name' from player_stats(p_season) s where s.player_slug = p.slug),
    'oom', (select jsonb_build_object('rank', o.rank, 'points', o.total_points, 'events', o.events_scored)
              from oom_table(p_season, false) o where o.player_slug = p.slug),
    'pc_oom', (select jsonb_build_object('rank', o.rank, 'points', o.total_points)
                 from oom_table(p_season, true) o where o.player_slug = p.slug),
    -- The first and latest dates anyone scored OoM points this season: the
    -- chart runs week by week between them.
    'oom_from', (select min(op.played_on) from oom_points op where op.season = p_season),
    'oom_to', (select max(op.played_on) from oom_points op where op.season = p_season),
    'events', coalesce((select jsonb_agg(e order by e.day nulls first, e.name) from (
        select t.id::text as id, t.name, t.starts_at::date as day,
               case when t.is_major then 'major' when t.is_pc then 'pc' else 'event' end as kind,
               round(sum(v.score)::numeric / nullif(sum(v.darts), 0) * 3, 2) as avg,
               (select count(*) from matches m2 where m2.tournament_id = t.id and m2.status = 'complete'
                   and p.id in (coalesce(m2.player1_id, m2.counted_p1_id), coalesce(m2.player2_id, m2.counted_p2_id))) as played,
               (select count(*) from matches m2 where m2.tournament_id = t.id and m2.status = 'complete'
                   and match_winner_side(m2) = case when coalesce(m2.player1_id, m2.counted_p1_id) = p.id then 1
                                                    when coalesce(m2.player2_id, m2.counted_p2_id) = p.id then 2 end) as won,
               (select op.reached from oom_points op where op.player_id = p.id and op.tournament_id = t.id limit 1) as reached,
               (select op.points from oom_points op where op.player_id = p.id and op.tournament_id = t.id limit 1) as points
          from tournaments t
          join matches m on m.tournament_id = t.id
          join visits v on v.match_id = m.id
               and ((v.player = 1 and coalesce(m.player1_id, m.counted_p1_id) = p.id)
                 or (v.player = 2 and coalesce(m.player2_id, m.counted_p2_id) = p.id))
         where t.deleted_at is null and t.season = p_season and not coalesce(t.is_friendly, false)
         group by t.id
        union all
        select 'x' || e.id, e.event, e.played_on, 'external', e.avg, null, null, null, null
          from external_events e where e.player_id = p.id and e.played_on >= season_start and e.source is distinct from 'Challonge'
        union all
        select 'o' || op.id, op.event_name, op.played_on, case when op.is_major then 'major' when op.is_pc then 'pc' else 'event' end,
               null, null, null, op.reached, op.points
          from oom_points op where op.player_id = p.id and op.season = p_season and op.tournament_id is null
      ) e), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(x order by x.at desc) from (
        select m.id, case when coalesce(t.is_friendly, false) then 'Friendly' else t.name end as event, coalesce(m.finished_at, m.updated_at) as at,
               case when coalesce(m.player1_id, m.counted_p1_id) = p.id
                    then coalesce(p2.name, m.p2_name) else coalesce(p1.name, m.p1_name) end as opponent,
               case when coalesce(m.player1_id, m.counted_p1_id) = p.id then m.p1_legs else m.p2_legs end as legs_for,
               case when coalesce(m.player1_id, m.counted_p1_id) = p.id then m.p2_legs else m.p1_legs end as legs_against,
               -- Friendlies can have no winner_id; match_winner_side falls back to the score.
               match_winner_side(m) = case when coalesce(m.player1_id, m.counted_p1_id) = p.id then 1 else 2 end as won,
               (select round(sum(v.score)::numeric / nullif(sum(v.darts), 0) * 3, 2) from visits v where v.match_id = m.id
                   and v.player = case when coalesce(m.player1_id, m.counted_p1_id) = p.id then 1 else 2 end) as avg
          from matches m
          join tournaments t on t.id = m.tournament_id and t.deleted_at is null
          left join players p1 on p1.id = coalesce(m.player1_id, m.counted_p1_id)
          left join players p2 on p2.id = coalesce(m.player2_id, m.counted_p2_id)
         where m.status = 'complete'
           and p.id in (coalesce(m.player1_id, m.counted_p1_id), coalesce(m.player2_id, m.counted_p2_id))
         order by coalesce(m.finished_at, m.updated_at) desc limit 15) x), '[]'::jsonb),
    'linked', case when is_super() then (select jsonb_build_object('name', a.display_name, 'email', a.email)
                                           from accounts a where a.player_id = p.id) end);
end $function$;
