-- 033: figures for games between typed-in names (doubles, trebles, guests)
--
-- Doubles and trebles in UDUK and Franny, singles with a guest, and
-- friendlies store names rather than linked players, so match_preview has
-- nothing to go on. names_preview splits each side into its players
-- ("A & B & C"), finds anyone whose name matches an order of merit profile,
-- and returns their career figures, recent form and provisional average.
-- The site combines them into GuinnessBet prices for the pair or trio.
--
-- Run after migration-032.sql. Safe to run more than once.

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
               'career', (select to_jsonb(a) from player_averages() a where a.player_id = (e->>'id')::uuid),
               'form',   (select to_jsonb(f) from player_form() f where f.player_id = (e->>'id')::uuid),
               'prov',   (select provisional_avg from players where id = (e->>'id')::uuid))
             order by ord)
        from jsonb_array_elements(members) with ordinality as x(e, ord));
    out := out || jsonb_build_object('side' || k, members);
  end loop;
  return out;
end $$;

revoke execute on function public.names_preview(uuid) from public;
grant  execute on function public.names_preview(uuid) to anon, authenticated;
