-- Export for checking the GuinnessBet / win probability model.
-- Run in the SQL editor, copy the single value it returns into a file called
-- model-data.json (or paste it to Claude), then run:
--   node tools/model-eval.mjs model-data.json
--
-- One row per finished tournament match that has a snapshot: what the model
-- knew when it started (features) and how every leg went.
select coalesce(jsonb_agg(jsonb_build_object(
         'match_id', s.match_id,
         'taken_at', s.taken_at,
         'features', s.features,
         'winner', case when m.winner_id = m.player1_id then 1 when m.winner_id = m.player2_id then 2 end,
         'legs', (select jsonb_agg(jsonb_build_object('no', l.leg_no, 'starter', l.starter,
                                                      'winner', l.winner, 'bull_off', l.bull_off)
                                   order by l.leg_no)
                    from legs l where l.match_id = s.match_id and l.winner is not null)
       ) order by s.taken_at), '[]'::jsonb) as model_data
  from model_snapshots s
  join matches m on m.id = s.match_id
 where m.status = 'complete';
