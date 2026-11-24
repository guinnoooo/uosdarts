-- Migration 073: super_fantasy_prices was working out every team's squad
-- once per player (about 6 seconds with 110 players). Work out each squad
-- once and count from that.

create or replace function public.super_fantasy_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g date;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  g := coalesce(fantasy_next_gw(), fantasy_start());
  return coalesce((
    with picked as (
      select s.player_id, count(*) as n
        from fantasy_teams t cross join lateral fantasy_squad(t.user_id, g) s
       group by s.player_id)
    select jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'suggested', f.suggested, 'price', f.price,
                                        'picked', coalesce(k.n, 0))
                     order by coalesce(f.price, f.suggested) desc nulls last, p.name)
      from fantasy_prices f join players p on p.id = f.player_id
      left join picked k on k.player_id = p.id), '[]'::jsonb);
end $$;
