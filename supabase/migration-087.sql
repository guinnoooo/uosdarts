-- Tidy-up after a security check.
--
-- 1. Helper functions only ever called from inside other database functions
--    (or by the place-bet function, which uses the service key) were callable
--    by anyone through the API. Most were harmless, but fantasy_squad let
--    anyone read another player's fantasy team before the 7pm deadline, the
--    model_live/model_now helpers could be used to load the database, and the
--    fantasy cache busters and renumber_pcs could be triggered by anyone.
-- 2. The 30-second cache job logs every run; keep a week of that log.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fantasy_squad', 'fantasy_chip_on', 'fantasy_changes', 'fantasy_bank_before', 'fantasy_bust',
                                'fantasy_pp', 'fantasy_team_points', 'fantasy_lock', 'fantasy_events', 'fantasy_pts',
                                'fantasy_player_points', 'fantasy_europa_events', 'renumber_pcs', 'prematch_missing',
                                'bet_legs_json', 'model_live', 'model_now', 'future_cash_out_value', 'ext_played', 'ext_won',
                                'bettable_matches', 'selection_outcome', 'nice_fraction', 'nice_price', 'nice_decimal')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

select cron.schedule('trim-cron-log', '17 4 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

-- 3. Small indexes for the external results the previews read, and the
--    admins policy checking the login once per query rather than per row.
create index if not exists external_results_event on external_results (event_id);
create index if not exists external_results_pair on external_results (player_id, opponent_player_id);
alter policy "own row" on admins using (user_id = (select auth.uid()));
