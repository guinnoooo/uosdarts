-- Load test for scoring: replays PC 9 visit by visit through record_visit,
-- start_match and bull_off with hundreds of bets and accas live, and reports
-- timings. Everything is rolled back (it ends by raising an exception).
-- Run it when nobody is placing bets: it holds account locks while it runs.
-- Replays PC 9 (63 matches, 3,260 visits) through the real scoring functions,
-- in the order the visits were really thrown, with ~450 bets and accas live
-- on it and more placed as rounds open up. Everything is rolled back.
do $$
declare
  tid uuid; sc uuid; bettors uuid[]; nb int;
  v record; m matches; t0 timestamptz; ms numeric; kind text; mid uuid; nxt matches;
  i int := 0; k int; u uuid; pick jsonb; picks jsonb; r jsonb; ok int := 0; fail int := 0; errs text := '';
  tokens_before bigint; tokens_after bigint; settled int; won int; open_left int;
  mismatches int;
begin
  select id into tid from tournaments where name = 'PC 9';
  select array_agg(user_id order by user_id) into bettors from accounts where can_bet and not banned;
  sc := bettors[1]; bettors := bettors[2:]; nb := cardinality(bettors);
  perform set_config('request.jwt.claims', json_build_object('sub', sc, 'role', 'authenticated')::text, true);

  create temp table t_res on commit drop as select id, winner_id, p1_legs, p2_legs from matches where tournament_id = tid;
  create temp table t_v on commit drop as
    select vi.id, vi.match_id, vi.player, vi.score, vi.darts, vi.darts_at_double, vi.is_bust, l.leg_no, l.starter, l.bull_off, l.winner as leg_winner,
           (vi.id = max(vi.id) over (partition by vi.leg_id)) as last_in_leg
      from visits vi join legs l on l.id = vi.leg_id join matches x on x.id = vi.match_id
     where x.tournament_id = tid;
  create temp table t_first on commit drop as select match_id, starter from legs l join matches x on x.id = l.match_id
     where x.tournament_id = tid and l.leg_no = 1;
  create temp table t_ms (op text, ms numeric) on commit drop;

  -- Back to the start of the night (byes stay done).
  delete from model_snapshots where match_id in (select id from matches where tournament_id = tid);
  delete from visits where match_id in (select id from matches where tournament_id = tid);
  delete from legs where match_id in (select id from matches where tournament_id = tid);
  update matches set status = 'pending', winner_id = null, p1_legs = 0, p2_legs = 0, started_at = null, finished_at = null,
         scorer_id = sc, scorer2_id = null
   where tournament_id = tid and player1_id is not null and player2_id is not null;
  update matches set scorer_id = sc where tournament_id = tid and status = 'pending';
  select sum(tokens) into tokens_before from accounts;

  -- Opening bets: every bettor backs winners, markets and a 3-4 pick acca.
  for k in 1..nb loop
    u := bettors[k];
    for mid in select id from matches where tournament_id = tid and status = 'pending' and player1_id is not null and player2_id is not null
                order by md5(id::text || k) limit 3 loop
      t0 := clock_timestamp();
      begin
        perform place_bet_internal(u, tid, mid, (1 + (k % 2))::smallint, null, 'x', 'x', 'Evens', 2, 20, 8);
        insert into t_ms values ('place winner bet', extract(epoch from clock_timestamp() - t0) * 1000); ok := ok + 1;
      exception when others then fail := fail + 1; errs := left(errs || sqlerrm || '; ', 300); end;
      t0 := clock_timestamp();
      begin
        perform place_selections_internal(u, 20, jsonb_build_array(jsonb_build_object('match_id', mid, 'market',
          (array['tons','cs','180','legs','avg1'])[1 + k % 5], 'pick', case when k % 5 = 1 then '3-1' else 'a' end,
          'line', (array[4.5, null, null, 6.5, 45.5])[1 + k % 5], 'title', 't', 'label', 'l', 'price', 'Evens', 'decimal', 2)), 801);
        insert into t_ms values ('place market bet', extract(epoch from clock_timestamp() - t0) * 1000); ok := ok + 1;
      exception when others then fail := fail + 1; errs := left(errs || sqlerrm || '; ', 300); end;
    end loop;
    select jsonb_agg(jsonb_build_object('match_id', id, 'market', 'win', 'pick', (1 + (k + n) % 2)::text, 'title', 't', 'label', 'l', 'price', 'Evens', 'decimal', 2))
      into picks
      from (select id, row_number() over () n from (select id from matches where tournament_id = tid and status = 'pending'
              and player1_id is not null and player2_id is not null order by md5(id::text || 'a' || k) limit 3 + k % 2) a) b;
    t0 := clock_timestamp();
    begin
      perform place_selections_internal(u, 10, picks, 801);
      insert into t_ms values ('place acca', extract(epoch from clock_timestamp() - t0) * 1000); ok := ok + 1;
    exception when others then fail := fail + 1; errs := left(errs || sqlerrm || '; ', 300); end;
  end loop;

  -- The night itself, visit by visit across all the boards.
  for v in select * from t_v order by id loop
    i := i + 1;
    select * into m from matches where id = v.match_id;
    if m.status = 'pending' then
      t0 := clock_timestamp();
      perform start_match(v.match_id, (select starter from t_first where match_id = v.match_id));
      insert into t_ms values ('start match', extract(epoch from clock_timestamp() - t0) * 1000);
    end if;
    t0 := clock_timestamp();
    perform record_visit(v.match_id, v.score, v.darts, v.darts_at_double);
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    select * into m from matches where id = v.match_id;
    kind := case when m.status = 'complete' then 'visit that wins the match'
                 when v.last_in_leg and not v.bull_off then 'visit that wins a leg' else 'visit' end;
    insert into t_ms values (kind, ms);
    if v.last_in_leg and v.bull_off then
      t0 := clock_timestamp();
      perform bull_off(v.match_id, v.leg_winner);
      insert into t_ms values ('bull off', extract(epoch from clock_timestamp() - t0) * 1000);
      select * into m from matches where id = v.match_id;
    end if;
    -- A finished match opens the next one up for betting: a few people pile in.
    if m.status = 'complete' and m.next_match_id is not null then
      select * into nxt from matches where id = m.next_match_id;
      if nxt.status = 'pending' and nxt.player1_id is not null and nxt.player2_id is not null then
        for k in 1..6 loop
          u := bettors[1 + (abs(hashtext(nxt.id::text || k)) % nb)];
          t0 := clock_timestamp();
          begin
            perform place_selections_internal(u, 10, jsonb_build_array(jsonb_build_object('match_id', nxt.id, 'market', 'win', 'pick', (1 + k % 2)::text,
              'title', 't', 'label', 'l', 'price', 'Evens', 'decimal', 2)), 801);
            insert into t_ms values ('place market bet', extract(epoch from clock_timestamp() - t0) * 1000); ok := ok + 1;
          exception when others then fail := fail + 1; errs := left(errs || sqlerrm || '; ', 300); end;
        end loop;
      end if;
    end if;
    -- People reading pages while it all happens.
    if i % 250 = 0 then
      t0 := clock_timestamp(); perform odds_board(); insert into t_ms values ('read: odds page', extract(epoch from clock_timestamp() - t0) * 1000);
      t0 := clock_timestamp(); perform tournament_odds_data(tid); insert into t_ms values ('read: tournament odds', extract(epoch from clock_timestamp() - t0) * 1000);
      t0 := clock_timestamp(); perform match_preview(v.match_id); insert into t_ms values ('read: match preview', extract(epoch from clock_timestamp() - t0) * 1000);
      t0 := clock_timestamp(); perform oom_table(); insert into t_ms values ('read: order of merit', extract(epoch from clock_timestamp() - t0) * 1000);
    end if;
  end loop;

  select count(*) into mismatches from matches x join t_res o on o.id = x.id
   where x.winner_id is distinct from o.winner_id or x.p1_legs <> o.p1_legs or x.p2_legs <> o.p2_legs;
  select count(*) filter (where status in ('won', 'lost', 'void')), count(*) filter (where status = 'won'), count(*) filter (where status = 'open')
    into settled, won, open_left from bets where placed_at = now();
  select sum(tokens) into tokens_after from accounts;

  raise exception E'STRESS\n%\nvisits replayed %, results differing from the real night %\nbets placed % (refused %: %)\nsettled % (won %), still open %\ntokens in all accounts % -> %',
    (select string_agg(format('%-26s n=%-5s median %6s ms  p95 %6s ms  max %6s ms', op, n, p50, p95, mx), E'\n' order by mx desc) from (
       select op, count(*) n, round(percentile_cont(0.5) within group (order by t_ms.ms)::numeric, 1) p50,
              round(percentile_cont(0.95) within group (order by t_ms.ms)::numeric, 1) p95, round(max(t_ms.ms), 1) mx
         from t_ms group by op) s),
    i, mismatches, ok, fail, errs, settled, won, open_left, tokens_before, tokens_after;
end $$;
