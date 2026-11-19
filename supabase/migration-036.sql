-- 036: speed and a security fix
--
-- * player_visits follows the reader's own access rules (security_invoker),
--   like the other views. It only shows public data either way, but Supabase
--   flags the old setting as critical.
-- * Indexes on the foreign keys the performance advisor listed, mainly the
--   player and winner columns that win rates and head to heads search.
-- * player_averages_for / player_form_for: the same figures as
--   player_averages() / player_form(), worked out only for the players asked
--   about. match_preview and names_preview use them, instead of working out
--   every player's figures on every preview.
--
-- Run after migration-035.sql. Safe to run more than once.

alter view public.player_visits set (security_invoker = true);

create index if not exists matches_player1_idx on public.matches (player1_id);
create index if not exists matches_player2_idx on public.matches (player2_id);
create index if not exists matches_winner_idx on public.matches (winner_id);
create index if not exists matches_next_match_idx on public.matches (next_match_id);
create index if not exists matches_referee_idx on public.matches (referee_id);
create index if not exists tournaments_champion_idx on public.tournaments (champion_id);
create index if not exists oom_points_tournament_idx on public.oom_points (tournament_id);
create index if not exists tournament_players_player_idx on public.tournament_players (player_id);
create index if not exists ref_queue_player_idx on public.ref_queue (player_id);

create or replace function public.player_averages_for(p_ids uuid[])
returns table(player_id uuid, player_slug text, darts integer, avg text, first9 text, dbl_pct text)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select case when vi.player = 1 then m.player1_id else m.player2_id end as pid,
           vi.score, vi.darts, vi.darts_at_double,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null
      join visits vi on vi.match_id = m.id
     where m.player1_id = any (p_ids) or m.player2_id = any (p_ids)
  ),
  agg as (
    select pid,
           sum(darts)::int as darts,
           sum(score)::numeric as scored,
           sum(darts) filter (where n <= 3)::numeric as d9,
           sum(score) filter (where n <= 3)::numeric as s9,
           sum(darts_at_double)::int as dbl_at
      from ordered
     where pid = any (p_ids)
     group by pid
  ),
  hits as (
    select case when l.winner = 1 then m.player1_id else m.player2_id end as pid, count(*)::int as dbl_hit
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null
      join legs l on l.match_id = m.id
     where (m.player1_id = any (p_ids) or m.player2_id = any (p_ids))
       and l.winner is not null and not l.bull_off
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

create or replace function public.player_form_for(p_ids uuid[], p_half_life integer default 42)
returns table(player_id uuid, player_slug text, wdarts numeric, avg text, first9 text, dbl_pct text)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select case when vi.player = 1 then m.player1_id else m.player2_id end as pid,
           vi.score, vi.darts, vi.darts_at_double,
           power(0.5, extract(epoch from (now() - vi.created_at)) / 86400.0 / greatest(p_half_life, 1)) as w,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
      join visits vi on vi.match_id = m.id
     where m.player1_id = any (p_ids) or m.player2_id = any (p_ids)
  ),
  agg as (
    select pid,
           sum(w * darts) as wd,
           sum(w * score) as ws,
           sum(w * darts) filter (where n <= 3) as wd9,
           sum(w * score) filter (where n <= 3) as ws9,
           sum(w * darts_at_double) as wdbl
      from ordered where pid = any (p_ids) group by pid
  ),
  hits as (
    select case when l.winner = 1 then m.player1_id else m.player2_id end as pid,
           sum(power(0.5, extract(epoch from (now() - coalesce(m.finished_at, m.updated_at, now()))) / 86400.0
                          / greatest(p_half_life, 1))) as whit
      from matches m
      join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
      join legs l on l.match_id = m.id
     where (m.player1_id = any (p_ids) or m.player2_id = any (p_ids))
       and l.winner is not null and not l.bull_off
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

-- match_preview: only the two players' figures.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.match_preview(uuid)'::regprocedure), E'\r', '');
  def := replace(def, 'from player_averages() a', 'from player_averages_for(array[m.player1_id, m.player2_id]) a');
  def := replace(def, 'from player_form() f', 'from player_form_for(array[m.player1_id, m.player2_id]) f');
  if position('player_averages()' in def) > 0 or position('player_form()' in def) > 0 then
    raise exception 'match_preview has changed shape';
  end if;
  execute def;
end $$;

-- names_preview: find everyone first, then work out all their figures in one go.
create or replace function public.names_preview(p_match uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  m matches;
  out jsonb := '{}'::jsonb;
  k int;
  pid uuid;
  nm text;
  members jsonb;
  part text;
  ids uuid[];
  av jsonb;
  fm jsonb;
  a uuid;
  b uuid;
begin
  select * into m from matches where id = p_match;
  if not found then return null; end if;
  for k in 1 .. 2 loop
    pid := case k when 1 then m.player1_id else m.player2_id end;
    nm := case k when 1 then m.p1_name else m.p2_name end;
    members := '[]'::jsonb;
    if pid is not null then
      members := jsonb_build_array(jsonb_build_object('name', (select name from players where id = pid), 'id', pid));
    elsif nm is not null then
      for part in select btrim(x) from unnest(string_to_array(nm, ' & ')) x where btrim(x) <> '' loop
        pid := (select id from players where lower(name) = lower(part) limit 1);
        members := members || jsonb_build_object('id', pid,
          'name', coalesce((select name from players where id = pid), part));
      end loop;
    end if;
    if jsonb_array_length(members) = 0 then return null; end if;
    out := out || jsonb_build_object('side' || k, members);
  end loop;

  select array_agg((e->>'id')::uuid) into ids
    from jsonb_array_elements((out->'side1') || (out->'side2')) e where e->>'id' is not null;
  ids := coalesce(ids, array[]::uuid[]);
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into av from player_averages_for(ids) x;
  select coalesce(jsonb_object_agg(x.player_id, to_jsonb(x)), '{}') into fm from player_form_for(ids) x;

  for k in 1 .. 2 loop
    out := out || jsonb_build_object('side' || k, (
      select jsonb_agg(e || jsonb_build_object(
               'career', av->(e->>'id'),
               'form',   fm->(e->>'id'),
               'prov',   (select provisional_avg from players where id = (e->>'id')::uuid),
               'played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                           where x.status = 'complete' and (e->>'id')::uuid in (x.player1_id, x.player2_id)
                             and x.player1_id is not null and x.player2_id is not null),
               'won',    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                           where x.status = 'complete' and x.winner_id = (e->>'id')::uuid
                             and x.player1_id is not null and x.player2_id is not null))
             order by ord)
        from jsonb_array_elements(out->('side' || k)) with ordinality as x(e, ord)));
  end loop;

  if jsonb_array_length(out->'side1') = 1 and jsonb_array_length(out->'side2') = 1 then
    a := (out->'side1'->0->>'id')::uuid;
    b := (out->'side2'->0->>'id')::uuid;
    if a is not null and b is not null then
      out := out || jsonb_build_object('h2h', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'tournament', t.name,
                 'date', coalesce(x.finished_at, t.starts_at),
                 'p1_legs', case when x.player1_id = a then x.p1_legs else x.p2_legs end,
                 'p2_legs', case when x.player1_id = a then x.p2_legs else x.p1_legs end,
                 'p1_won', x.winner_id = a)
               order by coalesce(x.finished_at, t.starts_at) desc)
          from matches x
          join tournaments t on t.id = x.tournament_id and t.deleted_at is null
         where x.status = 'complete' and x.id <> m.id
           and ((x.player1_id = a and x.player2_id = b) or (x.player1_id = b and x.player2_id = a))
      ), '[]'::jsonb));
    end if;
  end if;
  return out;
end $$;

revoke execute on function public.player_averages_for(uuid[]) from public, anon, authenticated;
revoke execute on function public.player_form_for(uuid[], integer) from public, anon, authenticated;
revoke execute on function public.names_preview(uuid) from public;
grant  execute on function public.names_preview(uuid) to anon, authenticated;
