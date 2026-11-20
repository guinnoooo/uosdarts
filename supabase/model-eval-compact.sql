-- Compact export for checking the odds model, one line per finished match
-- with a snapshot. Small enough to copy out of a query result by hand.
-- Turn it into model-data.json with:
--   node tools/model-data-from-compact.mjs compact.txt model-data.json
-- Fields (| separated): taken_at | winner side | legs as starter+winner pairs |
-- p1 career | p2 career | p1 form | p2 form | p1 prov | p2 prov |
-- played/won | oom | format | rating, rd, sd | head-to-head
with d as (
  select s.taken_at t, s.features f, case when m.winner_id = m.player1_id then 1 else 2 end w,
         (select string_agg(coalesce(l.starter::text, '0') || l.winner::text, '' order by l.leg_no)
            from legs l where l.match_id = s.match_id and l.winner is not null and not l.bull_off) lg
    from model_snapshots s join matches m on m.id = s.match_id where m.status = 'complete')
select string_agg(concat_ws('|', to_char(t, 'YYYY-MM-DD"T"HH24:MI'), w, lg,
  concat_ws(',', f->'p1'->>'darts', f->'p1'->>'avg', f->'p1'->>'first9', replace(f->'p1'->>'dbl_pct', '%', '')),
  concat_ws(',', f->'p2'->>'darts', f->'p2'->>'avg', f->'p2'->>'first9', replace(f->'p2'->>'dbl_pct', '%', '')),
  concat_ws(',', f->'p1_form'->>'wdarts', f->'p1_form'->>'avg', f->'p1_form'->>'first9', replace(f->'p1_form'->>'dbl_pct', '%', '')),
  concat_ws(',', f->'p2_form'->>'wdarts', f->'p2_form'->>'avg', f->'p2_form'->>'first9', replace(f->'p2_form'->>'dbl_pct', '%', '')),
  coalesce(f->>'p1_prov', ''), coalesce(f->>'p2_prov', ''),
  concat_ws(',', f->>'p1_played', f->>'p1_won', f->>'p2_played', f->>'p2_won'),
  concat_ws(',', round((f->'oom'->>'p1')::numeric, 3), round((f->'oom'->>'p2')::numeric, 3)),
  concat_ws(',', f->>'legs_to_win', coalesce(f->>'sets_to_win', '0'), f->>'start_score'),
  concat_ws(',', coalesce(f->>'p1_rating', ''), coalesce(f->>'p1_rd', ''), coalesce(f->>'p2_rating', ''),
                 coalesce(f->>'p2_rd', ''), coalesce(f->>'p1_sd', ''), coalesce(f->>'p2_sd', '')),
  (select coalesce(string_agg(concat_ws(',', to_char((h->>'date')::timestamptz, 'YYYY-MM-DD'), h->>'p1_legs', h->>'p2_legs'), ';'), '')
     from jsonb_array_elements(f->'h2h') h)
), E'\n' order by t) as compact
from d;
