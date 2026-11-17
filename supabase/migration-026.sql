-- 026: recent form for GuinnessBet and win probability, and a log to tune the model
--
-- * player_form(): each player's average, first 9 and doubles % with recent
--   darts counting for more. A visit's weight halves every p_half_life days
--   (42 by default, so six weeks ago counts half, twelve weeks a quarter).
--   wdarts is the weighted number of darts, i.e. how much recent play there is.
-- * match_preview() now also returns p1_form and p2_form.
-- * model_snapshots: when a match starts, the database records everything the
--   model will use for it (career figures, recent form, order of merit and
--   head-to-head as they stood at that moment). After a few weeks these, set
--   against the legs that were actually won, show how well the model is
--   doing and what each factor should be worth.
--
-- Read-only for the site, apart from the snapshot written when a match starts.
-- Safe to run more than once.

create or replace function public.player_form(p_half_life int default 42)
returns table (
  player_id   uuid,
  player_slug text,
  wdarts      numeric,
  avg         text,
  first9      text,
  dbl_pct     text
)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select case when vi.player = 1 then m.player1_id else m.player2_id end as pid,
           vi.score, vi.darts, vi.darts_at_double,
           power(0.5, extract(epoch from (now() - vi.created_at)) / 86400.0 / greatest(p_half_life, 1)) as w,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from visits vi
      join matches m on m.id = vi.match_id
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
  ),
  agg as (
    select pid,
           sum(w * darts) as wd,
           sum(w * score) as ws,
           sum(w * darts) filter (where n <= 3) as wd9,
           sum(w * score) filter (where n <= 3) as ws9,
           sum(w * darts_at_double) as wdbl
      from ordered where pid is not null group by pid
  ),
  hits as (
    select case when l.winner = 1 then m.player1_id else m.player2_id end as pid,
           sum(power(0.5, extract(epoch from (now() - coalesce(m.finished_at, m.updated_at, now()))) / 86400.0
                          / greatest(p_half_life, 1))) as whit
      from legs l
      join matches m on m.id = l.match_id
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
     where l.winner is not null and not l.bull_off
     group by 1
  )
  select p.id, p.slug, round(a.wd, 1),
         case when a.wd > 0 then to_char(a.ws / a.wd * 3, 'FM990.00') end,
         case when a.wd9 > 0 then to_char(a.ws9 / a.wd9 * 3, 'FM990.00') end,
         case when a.wdbl > 0 then to_char(least(100, coalesce(h.whit, 0) / a.wdbl * 100), 'FM990.0') || '%' end
    from agg a
    join players p on p.id = a.pid
    left join hits h on h.pid = a.pid;
$$;

grant execute on function public.player_form(int) to anon, authenticated;

-- Same as migration-018, plus each player's recent form.
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
    'p1_form', (select to_jsonb(f) from player_form() f where f.player_id = m.player1_id),
    'p2_form', (select to_jsonb(f) from player_form() f where f.player_id = m.player2_id),
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

-- ------------------------------------------------------------------ model log

create table if not exists public.model_snapshots (
  match_id   uuid primary key references public.matches on delete cascade,
  taken_at   timestamptz not null default now(),
  features   jsonb not null
);
alter table public.model_snapshots enable row level security;
drop policy if exists "snapshots readable" on public.model_snapshots;
create policy "snapshots readable" on public.model_snapshots for select using (true);
grant select on public.model_snapshots to anon, authenticated;

-- When a tournament match first goes live, record what the model knows.
-- The order of merit is stored as the same 0.3-1 score the site uses.
create or replace function public.snapshot_model() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  f jsonb;
  oom jsonb;
begin
  if new.status <> 'live' or old.status = 'live' then return null; end if;
  if new.player1_id is null or new.player2_id is null then return null; end if;
  if exists (select 1 from model_snapshots where match_id = new.id) then return null; end if;

  with pointed as (
    select o.player_name, o.rank, count(*) over () as n
      from oom_table() o where o.total_points > 0
  )
  select jsonb_build_object(
    'p1', coalesce((select 0.4 + 0.6 * case when n > 1 then 1 - (rank - 1)::numeric / (n - 1) else 1 end
                      from pointed where player_name = (select name from players where id = new.player1_id)), 0.3),
    'p2', coalesce((select 0.4 + 0.6 * case when n > 1 then 1 - (rank - 1)::numeric / (n - 1) else 1 end
                      from pointed where player_name = (select name from players where id = new.player2_id)), 0.3))
    into oom;

  f := match_preview(new.id) || jsonb_build_object(
    'oom', oom,
    'legs_to_win', new.legs_to_win,
    'sets_to_win', new.sets_to_win,
    'start_score', new.start_score);

  insert into model_snapshots (match_id, features) values (new.id, f) on conflict do nothing;
  return null;
exception when others then
  return null;   -- a failed snapshot must never stop a match starting
end $$;

drop trigger if exists matches_model_snapshot on public.matches;
create trigger matches_model_snapshot
after update of status on public.matches
for each row execute function public.snapshot_model();

revoke execute on function public.snapshot_model() from public, anon, authenticated;
