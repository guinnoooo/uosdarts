-- 035: match preview figures for games between typed-in names
--
-- names_preview also returns each player's matches played and won, and for
-- a one-on-one game between two profiles, their previous meetings, so the
-- match preview can show the same table as a tournament match.
--
-- Run after migration-034.sql. Safe to run more than once.

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
    members := (
      select jsonb_agg(e || jsonb_build_object(
               'career', (select to_jsonb(av) from player_averages() av where av.player_id = (e->>'id')::uuid),
               'form',   (select to_jsonb(f) from player_form() f where f.player_id = (e->>'id')::uuid),
               'prov',   (select provisional_avg from players where id = (e->>'id')::uuid),
               'played', (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                           where x.status = 'complete' and (e->>'id')::uuid in (x.player1_id, x.player2_id)
                             and x.player1_id is not null and x.player2_id is not null),
               'won',    (select count(*) from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
                           where x.status = 'complete' and x.winner_id = (e->>'id')::uuid
                             and x.player1_id is not null and x.player2_id is not null))
             order by ord)
        from jsonb_array_elements(members) with ordinality as x(e, ord));
    out := out || jsonb_build_object('side' || k, members);
  end loop;

  -- Previous meetings, for a one-on-one between two profiles.
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

revoke execute on function public.names_preview(uuid) from public;
grant  execute on function public.names_preview(uuid) to anon, authenticated;
