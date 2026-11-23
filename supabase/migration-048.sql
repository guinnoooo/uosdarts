-- Migration 048: super admins can see and delete unfinished friendlies.
-- delete_friendly already lets admins (and so super admins) delete any
-- friendly; this adds the list of friendlies that haven't finished, which
-- super_list_friendlies (finished ones, for counting) leaves out.

create or replace function public.super_list_open_friendlies()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((
    select jsonb_agg(x order by x.updated desc)
      from (
        select t.id as tournament_id, m.id as match_id, m.status, t.is_remote as remote,
               m.updated_at as updated, t.created_at as created,
               m.p1_name, m.p2_name, m.p1_legs, m.p2_legs, m.p1_sets, m.p2_sets, m.sets_to_win,
               (select count(*) from visits where match_id = m.id) as visits
          from tournaments t
          join matches m on m.tournament_id = t.id
         where t.is_friendly and t.deleted_at is null and m.status <> 'complete'
         order by m.updated_at desc
         limit 100
      ) x), '[]'::jsonb);
end $$;
revoke execute on function public.super_list_open_friendlies() from public, anon;
grant execute on function public.super_list_open_friendlies() to authenticated;
