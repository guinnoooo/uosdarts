-- Export for checking the match markets (tools/markets-eval.mjs), one line per
-- finished match with a snapshot, in the same order as model-eval-compact.sql.
-- Run both at the same time so the lines match up.
-- Fields (| separated): taken_at | p1 legs | p2 legs | legs to win | sets to win | start score |
-- each player's visits, 100+ and 180s on the site before the match |
-- each player's visits, 100+, 180s, average and darts in the match.
with s as (select s.match_id, s.taken_at t, coalesce(m.player1_id, m.counted_p1_id) a, coalesce(m.player2_id, m.counted_p2_id) b,
                  m.p1_legs, m.p2_legs, m.legs_to_win, m.sets_to_win, m.start_score
             from model_snapshots s join matches m on m.id = s.match_id where m.status = 'complete'),
pv as (select vi.created_at, vi.score, case when vi.player = 1 then coalesce(m.player1_id, m.counted_p1_id) else coalesce(m.player2_id, m.counted_p2_id) end pid
         from visits vi join matches m on m.id = vi.match_id join tournaments t on t.id = m.tournament_id and t.deleted_at is null
        where coalesce(m.start_score, 501) = 501),
prior as (select s.match_id, x.n,
                 (select count(*) from pv where pv.pid = x.pid and pv.created_at < s.t) v,
                 (select count(*) from pv where pv.pid = x.pid and pv.created_at < s.t and pv.score >= 100) tons,
                 (select count(*) from pv where pv.pid = x.pid and pv.created_at < s.t and pv.score = 180) m180
            from s cross join lateral (values (1, s.a), (2, s.b)) x(n, pid)),
act as (select vi.match_id, vi.player n, count(*) v, count(*) filter (where vi.score >= 100) tons, count(*) filter (where vi.score = 180) m180,
               round(sum(vi.score)::numeric / nullif(sum(vi.darts), 0) * 3, 2) avg, sum(vi.darts) darts
          from visits vi where vi.match_id in (select match_id from s) group by 1, 2)
select string_agg(concat_ws('|', to_char(s.t, 'YYYY-MM-DD"T"HH24:MI'), s.p1_legs, s.p2_legs, s.legs_to_win, coalesce(s.sets_to_win, 0), coalesce(s.start_score, 501),
         concat_ws(',', p1.v, p1.tons, p1.m180), concat_ws(',', p2.v, p2.tons, p2.m180),
         concat_ws(',', a1.v, a1.tons, a1.m180, a1.avg, a1.darts), concat_ws(',', a2.v, a2.tons, a2.m180, a2.avg, a2.darts)), E'\n' order by s.t) as market_stats
  from s
  left join prior p1 on p1.match_id = s.match_id and p1.n = 1 left join prior p2 on p2.match_id = s.match_id and p2.n = 2
  left join act a1 on a1.match_id = s.match_id and a1.n = 1 left join act a2 on a2.match_id = s.match_id and a2.n = 2;
