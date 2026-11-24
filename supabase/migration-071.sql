-- Migration 071: super admin sees every fantasy team before the deadline,
-- and every bet on the site in one list.

-- Teams stay hidden from other players until the gameweek locks, but a super
-- admin can open any of them at any time.
create or replace function public.fantasy_team_view(p_user uuid, p_gw date)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_user is distinct from auth.uid() and not is_super() and coalesce(fantasy_lock(p_gw) > now(), true) then
    raise exception 'Teams are shown once the gameweek starts';
  end if;
  return fantasy_team_points(p_user, p_gw) || jsonb_build_object('name', (select name from fantasy_teams where user_id = p_user));
end $$;

-- Every team as it stands for the next gameweek (or the current one if
-- nothing is coming up), with roles, prices paid, bank and changes.
create or replace function public.super_fantasy_teams()
returns jsonb language plpgsql security definer set search_path = public as $$
declare g date;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  g := coalesce(fantasy_next_gw(), (select max(gw) from fantasy_gws() where locks_at <= now()), fantasy_start());
  return jsonb_build_object('gw', g, 'locks_at', fantasy_lock(g), 'teams', coalesce((
    select jsonb_agg(x order by x.name) from (
      select t.user_id, t.name, a.display_name as manager, a.email,
             exists (select 1 from fantasy_picks k where k.user_id = t.user_id and k.gw = g) as saved_this_week,
             (select bank from fantasy_banks b where b.user_id = t.user_id and b.gw <= g order by b.gw desc limit 1) as bank,
             fantasy_changes(t.user_id, g) as changes,
             (select coalesce(jsonb_agg(jsonb_build_object('slot', s.slot, 'name', p.name, 'paid', s.price, 'price', f.price) order by s.slot), '[]'::jsonb)
                from fantasy_squad(t.user_id, g) s join players p on p.id = s.player_id
                left join fantasy_prices f on f.player_id = s.player_id) as squad
        from fantasy_teams t join accounts a on a.user_id = t.user_id) x), '[]'::jsonb));
end $$;

-- Every bet from every account, newest first.
create or replace function public.super_all_bets(p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.user_id, a.display_name as account, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as event,
           case when m.id is not null then coalesce(p1.name, m.p1_name, 'TBC') || ' v ' || coalesce(p2.name, m.p2_name, 'TBC') end as match
      from bets b
      join accounts a on a.user_id = b.user_id
      left join tournaments t on t.id = b.tournament_id
      left join matches m on m.id = b.match_id
      left join players p1 on p1.id = m.player1_id
      left join players p2 on p2.id = m.player2_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     order by b.placed_at desc limit greatest(1, least(p_limit, 5000))) x), '[]'::jsonb);
end $$;

-- The per-account list also names the match for match bets.
create or replace function public.super_account_bets(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as event, b.match_id, b.tournament_id,
           case when m.id is not null then coalesce(p1.name, m.p1_name, 'TBC') || ' v ' || coalesce(p2.name, m.p2_name, 'TBC') end as match
      from bets b
      left join tournaments t on t.id = b.tournament_id
      left join matches m on m.id = b.match_id
      left join players p1 on p1.id = m.player1_id
      left join players p2 on p2.id = m.player2_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     where b.user_id = p_user) x), '[]'::jsonb);
end $$;

revoke all on function public.super_fantasy_teams() from public, anon;
revoke all on function public.super_all_bets(integer) from public, anon;
grant execute on function public.super_fantasy_teams() to authenticated;
grant execute on function public.super_all_bets(integer) to authenticated;
