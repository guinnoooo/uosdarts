-- Fantasy prices are shown as £ millions; the over-budget message matches.
create or replace function public.fantasy_save(p_name text, p_players uuid[], p_captain uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); a accounts; nxt date := fantasy_next_gw(); cost numeric; i integer;
begin
  if uid is null then raise exception 'Log in to play'; end if;
  select * into a from accounts where user_id = uid;
  if not found then raise exception 'Confirm your email to play'; end if;
  if a.banned then raise exception 'Your account is blocked'; end if;
  if nxt is null then raise exception 'There''s no PC or major coming up to pick a team for'; end if;
  if coalesce(array_length(p_players, 1), 0) <> 6 or array_position(p_players, null) is not null then
    raise exception 'Fill all five roles and the bench';
  end if;
  if (select count(distinct x) from unnest(p_players) x) <> 6 then raise exception 'Each player can only be picked once'; end if;
  if exists (select 1 from unnest(p_players) x left join fantasy_prices f on f.player_id = x where f.price is null) then
    raise exception 'One of those players can''t be picked';
  end if;
  select sum(f.price) into cost from unnest(p_players) x join fantasy_prices f on f.player_id = x;
  if cost > fantasy_budget() then raise exception 'That squad costs £%m, over the £%m budget', cost, fantasy_budget(); end if;

  insert into fantasy_teams (user_id, name) values (uid, coalesce(nullif(btrim(p_name), ''), a.display_name))
  on conflict (user_id) do update set name = coalesce(nullif(btrim(excluded.name), ''), fantasy_teams.name);
  delete from fantasy_picks where user_id = uid and gw = nxt;
  for i in 1..6 loop
    insert into fantasy_picks (user_id, gw, slot, player_id, captain, price)
    select uid, nxt, i, p_players[i], i = 1, price from fantasy_prices where player_id = p_players[i];
  end loop;
  return jsonb_build_object('gw', nxt, 'cost', cost, 'changes', fantasy_changes(uid, nxt));
end $$;
