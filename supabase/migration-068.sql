-- Fantasy: how many teams have each player, as a percentage (never which
-- teams). Counted from every team's squad for the week being picked for,
-- or the latest week if none is coming up.
create or replace function public.fantasy_market()
returns jsonb language plpgsql security definer set search_path = public as $$
declare g record; last_gw date; target date; teams integer;
begin
  select max(gw) into last_gw from fantasy_gws() where locks_at <= now();
  target := coalesce(fantasy_next_gw(), last_gw, fantasy_start());
  for g in select gw from fantasy_gws() where locks_at <= now() loop
    perform 1 from fantasy_pp(g.gw) limit 1;
  end loop;
  return (
    with pts as (
      select c.player_id, sum(c.points) as season, max(case when c.gw = last_gw then c.points end) as last
        from fantasy_pp_cache c where not c.europa and c.gw in (select gw from fantasy_gws() where locks_at <= now())
       group by c.player_id),
    latest as (
      select user_id, max(gw) as gw from fantasy_picks where gw <= target group by user_id),
    owned as (
      select k.player_id, count(distinct k.user_id) as n
        from fantasy_picks k join latest l on l.user_id = k.user_id and l.gw = k.gw
       group by k.player_id),
    total as (select count(*) as n from latest)
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug, 'price', f.price,
                      'season', coalesce(pts.season, 0), 'last', coalesce(pts.last, 0),
                      'picked', case when total.n > 0 then round(100.0 * coalesce(o.n, 0) / total.n) else 0 end)
                    order by f.price desc, p.name), '[]'::jsonb)
      from fantasy_prices f join players p on p.id = f.player_id
      cross join total
      left join pts on pts.player_id = f.player_id
      left join owned o on o.player_id = f.player_id
     where f.price is not null);
end $$;
