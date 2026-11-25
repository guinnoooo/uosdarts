-- The Odds page: every upcoming match that can be bet on, with what the
-- model needs to price it, in one call. The same figures match_preview
-- gives for one match, but the rating, spread and averages are worked out
-- once for everyone instead of once per match.
create or replace function bettable_matches()
returns table(id uuid, tournament_id uuid, tournament text, starts_at timestamptz, stage text, round int, slot int,
              group_label text, game_label text, legs_to_win int, sets_to_win int, start_score int,
              player1_id uuid, player2_id uuid, p1_name text, p2_name text, ko_rounds int)
language sql stable security definer set search_path = public as $$
    select m.id, m.tournament_id, t.name as tournament, t.starts_at, m.stage, m.round, m.slot, m.group_label, m.game_label,
           m.legs_to_win, m.sets_to_win, m.start_score, m.player1_id, m.player2_id, p1.name as p1_name, p2.name as p2_name,
           (select max(x.round) from matches x where x.tournament_id = m.tournament_id and x.stage = 'knockout') as ko_rounds
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not coalesce(t.is_friendly, false)
      join players p1 on p1.id = m.player1_id
      join players p2 on p2.id = m.player2_id
     where m.status = 'pending' and m.started_at is null
       and not exists (select 1 from visits v where v.match_id = m.id);
$$;

create or replace function odds_board()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ids uuid[];
begin
  select array_agg(distinct p) into ids from (select player1_id p from bettable_matches() union select player2_id from bettable_matches()) u;
  if ids is null then return jsonb_build_object('matches', '[]'::jsonb); end if;
  return jsonb_build_object(
    'matches', (
      with av as (select a.player_id, to_jsonb(a) j from player_averages_for(ids) a),
           fm as (select f.player_id, to_jsonb(f) j from player_form_for(ids) f),
           g as (select * from glicko_at(now()) where player_id = any (ids)),
           sd as (select * from player_sd_at(ids, now())),
           rec as (
             select p as player_id,
                    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                      where x.status = 'complete' and p in (x.player1_id, x.player2_id)
                        and x.player1_id is not null and x.player2_id is not null) + ext_played(p) as played,
                    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                      where x.status = 'complete' and x.winner_id = p
                        and x.player1_id is not null and x.player2_id is not null) + ext_won(p) as won
               from unnest(ids) p),
           vis as (
             select case when vi.player = 1 then coalesce(x.player1_id, x.counted_p1_id) else coalesce(x.player2_id, x.counted_p2_id) end pid, vi.score
               from matches x
               join tournaments t on t.id = x.tournament_id and t.deleted_at is null
               join visits vi on vi.match_id = x.id
              where coalesce(x.start_score, 501) = 501
                and (x.player1_id = any (ids) or x.player2_id = any (ids) or x.counted_p1_id = any (ids) or x.counted_p2_id = any (ids))),
           fig as (select pid, jsonb_build_object('v', count(*), 'tons', count(*) filter (where score >= 100), 'm180', count(*) filter (where score = 180)) j
                     from vis where pid = any (ids) group by pid)
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', m.id, 'tournament_id', m.tournament_id, 'tournament', m.tournament, 'starts_at', m.starts_at,
               'stage', m.stage, 'round', m.round, 'slot', m.slot, 'group_label', m.group_label, 'game_label', m.game_label, 'ko_rounds', m.ko_rounds,
               'legs_to_win', m.legs_to_win, 'sets_to_win', m.sets_to_win, 'start_score', m.start_score,
               'player1_id', m.player1_id, 'player2_id', m.player2_id, 'name1', m.p1_name, 'name2', m.p2_name,
               'figs', jsonb_build_object('p1', (select j from fig where pid = m.player1_id), 'p2', (select j from fig where pid = m.player2_id)),
               'preview', jsonb_build_object(
                 'p1', (select j from av where player_id = m.player1_id), 'p2', (select j from av where player_id = m.player2_id),
                 'p1_prov', (select provisional_avg from players where id = m.player1_id),
                 'p2_prov', (select provisional_avg from players where id = m.player2_id),
                 'p1_form', (select j from fm where player_id = m.player1_id), 'p2_form', (select j from fm where player_id = m.player2_id),
                 'p1_played', (select played from rec where player_id = m.player1_id), 'p1_won', (select won from rec where player_id = m.player1_id),
                 'p2_played', (select played from rec where player_id = m.player2_id), 'p2_won', (select won from rec where player_id = m.player2_id),
                 'p1_rating', (select rating from g where player_id = m.player1_id), 'p1_rd', (select rd from g where player_id = m.player1_id),
                 'p2_rating', (select rating from g where player_id = m.player2_id), 'p2_rd', (select rd from g where player_id = m.player2_id),
                 'p1_sd', (select sd from sd where player_id = m.player1_id), 'p2_sd', (select sd from sd where player_id = m.player2_id),
                 'h2h', coalesce((
                    select jsonb_agg(jsonb_build_object('date', coalesce(x.finished_at, t.starts_at),
                             'p1_legs', case when x.player1_id = m.player1_id then x.p1_legs else x.p2_legs end,
                             'p2_legs', case when x.player1_id = m.player1_id then x.p2_legs else x.p1_legs end))
                      from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                     where x.status = 'complete'
                       and ((x.player1_id = m.player1_id and x.player2_id = m.player2_id)
                         or (x.player1_id = m.player2_id and x.player2_id = m.player1_id))), '[]'::jsonb)
                   || ext_h2h(m.player1_id, m.player2_id)))
             order by m.starts_at, m.tournament, m.stage desc, m.round, m.slot), '[]'::jsonb)
        from bettable_matches() m),
    'oom', (select jsonb_agg(to_jsonb(o)) from oom_table() o));
end $$;
