-- 018: career averages and the pre-match preview
--
-- * player_averages(): every player's 3-dart average, first 9 average and
--   double percentage across every tournament on the site (deleted
--   tournaments left out). Shown on player profiles.
-- * match_preview(match): both players' figures and their head-to-head
--   record, for the page spectators see before a match starts.
--
-- Read-only and safe to run more than once.

create or replace function public.player_averages()
returns table (
  player_id   uuid,
  player_slug text,
  darts       int,
  avg         text,
  first9      text,
  dbl_pct     text
)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select case when vi.player = 1 then m.player1_id else m.player2_id end as pid,
           vi.score, vi.darts, vi.darts_at_double,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from visits vi
      join matches m on m.id = vi.match_id
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null
  ),
  agg as (
    select pid,
           sum(darts)::int as darts,
           sum(score)::numeric as scored,
           sum(darts) filter (where n <= 3)::numeric as d9,
           sum(score) filter (where n <= 3)::numeric as s9,
           sum(darts_at_double)::int as dbl_at
      from ordered
     where pid is not null
     group by pid
  ),
  hits as (
    select case when l.winner = 1 then m.player1_id else m.player2_id end as pid, count(*)::int as dbl_hit
      from legs l
      join matches m on m.id = l.match_id
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null
     where l.winner is not null and not l.bull_off
     group by 1
  )
  select p.id, p.slug, a.darts,
         case when a.darts > 0 then to_char(a.scored / a.darts * 3, 'FM990.00') end,
         case when a.d9 > 0 then to_char(a.s9 / a.d9 * 3, 'FM990.00') end,
         case when a.dbl_at > 0 then to_char(least(100, coalesce(h.dbl_hit, 0)::numeric / a.dbl_at * 100), 'FM990.0') || '%' end
    from agg a
    join players p on p.id = a.pid
    left join hits h on h.pid = a.pid;
$$;

grant execute on function public.player_averages() to anon, authenticated;

-- Everything the preview needs in one call.
create or replace function public.match_preview(p_match uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m matches;
  res jsonb;
begin
  select * into m from matches where id = p_match;
  if not found or m.player1_id is null or m.player2_id is null then return null; end if;

  select jsonb_build_object(
    'p1', (select to_jsonb(a) from player_averages() a where a.player_id = m.player1_id),
    'p2', (select to_jsonb(a) from player_averages() a where a.player_id = m.player2_id),
    'p1_played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and m.player1_id in (x.player1_id, x.player2_id)
                     and x.player1_id is not null and x.player2_id is not null),
    'p2_played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and m.player2_id in (x.player1_id, x.player2_id)
                     and x.player1_id is not null and x.player2_id is not null),
    'p1_won',    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and x.winner_id = m.player1_id
                     and x.player1_id is not null and x.player2_id is not null),
    'p2_won',    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                   where x.status = 'complete' and x.winner_id = m.player2_id
                     and x.player1_id is not null and x.player2_id is not null),
    -- Meetings, newest first, from player 1 of this match's point of view.
    'h2h', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tournament', t.name,
               'date', coalesce(x.finished_at, t.starts_at),
               'p1_legs', case when x.player1_id = m.player1_id then x.p1_legs else x.p2_legs end,
               'p2_legs', case when x.player1_id = m.player1_id then x.p2_legs else x.p1_legs end,
               'p1_won', x.winner_id = m.player1_id)
             order by coalesce(x.finished_at, t.starts_at) desc)
        from matches x
        join tournaments t on t.id = x.tournament_id and t.deleted_at is null
       where x.status = 'complete' and x.id <> m.id
         and ((x.player1_id = m.player1_id and x.player2_id = m.player2_id)
           or (x.player1_id = m.player2_id and x.player2_id = m.player1_id))
    ), '[]'::jsonb)
  ) into res;
  return res;
end $$;

grant execute on function public.match_preview(uuid) to anon, authenticated;
