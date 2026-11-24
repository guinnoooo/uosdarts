-- Fantasy money works like FPL, except the whole price rise is yours.
--
-- Each team has a bank. A player you keep stays at the price you bought
-- him for; sell him and you get his price now, so a rise from 5.0 to 5.2
-- puts 0.2 more in the bank (and a fall costs you). Buying a player costs
-- his price now. A squad saves as long as the bank doesn't go below zero.
--
-- The bank is worked out against the squad a team had going into the week
-- being picked for, so saving several times before the lock is fine.

create table if not exists public.fantasy_banks (
  user_id uuid not null references public.accounts(user_id) on delete cascade,
  gw date not null,
  bank numeric(6,1) not null,
  primary key (user_id, gw)
);
alter table public.fantasy_banks enable row level security;

-- Squads saved before this: what was left of the budget after buying them.
insert into public.fantasy_banks (user_id, gw, bank)
select user_id, gw, fantasy_budget() - sum(price) from public.fantasy_picks group by user_id, gw
on conflict do nothing;

-- Money in the bank going into a week: from the latest squad before it, or
-- the whole budget for a first squad.
create or replace function public.fantasy_bank_before(p_user uuid, p_gw date) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select bank from fantasy_banks where user_id = p_user and gw < p_gw order by gw desc limit 1), fantasy_budget());
$$;

create or replace function public.fantasy_save(p_name text, p_players uuid[], p_captain uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); a accounts; nxt date := fantasy_next_gw(); i integer;
  bank numeric; bought numeric;
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

  -- Start from the bank and squad going into this week. Players kept stay
  -- at what they cost; players sold come back at today's price; players
  -- bought go out at today's price.
  bank := fantasy_bank_before(uid, nxt);
  bank := bank + coalesce((
    select sum(coalesce(f.price, s.price)) from fantasy_squad(uid, nxt - 1) s
      left join fantasy_prices f on f.player_id = s.player_id
     where s.player_id <> all (p_players)), 0);
  for i in 1..6 loop
    if exists (select 1 from fantasy_squad(uid, nxt - 1) s where s.player_id = p_players[i]) then continue; end if;
    select price into bought from fantasy_prices where player_id = p_players[i];
    if bought is null then raise exception 'One of those players can''t be picked'; end if;
    bank := bank - bought;
  end loop;
  if bank < 0 then raise exception 'That''s £%m over budget', -bank; end if;

  insert into fantasy_teams (user_id, name) values (uid, coalesce(nullif(btrim(p_name), ''), a.display_name))
  on conflict (user_id) do update set name = coalesce(nullif(btrim(excluded.name), ''), fantasy_teams.name);
  delete from fantasy_picks where user_id = uid and gw = nxt;
  for i in 1..6 loop
    insert into fantasy_picks (user_id, gw, slot, player_id, captain, price)
    values (uid, nxt, i, p_players[i], i = 1,
            coalesce((select s.price from fantasy_squad(uid, nxt - 1) s where s.player_id = p_players[i]),
                     (select price from fantasy_prices where player_id = p_players[i])));
  end loop;
  insert into fantasy_banks values (uid, nxt, bank) on conflict (user_id, gw) do update set bank = excluded.bank;
  return jsonb_build_object('gw', nxt, 'bank', bank, 'changes', fantasy_changes(uid, nxt));
end $$;

-- The page needs: the bank going into the week, the squad before it with
-- what each player cost, and the current squad with cost and today's price.
create or replace function public.fantasy_my_team()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); nxt date := fantasy_next_gw(); cur date;
begin
  if uid is null then return null; end if;
  select max(gw) into cur from fantasy_gws() where locks_at <= now();
  return jsonb_build_object(
    'name', (select name from fantasy_teams where user_id = uid),
    'budget', fantasy_budget(), 'hit', fantasy_hit(),
    'next_gw', nxt, 'locks_at', fantasy_lock(nxt), 'current_gw', cur,
    'bank_before', fantasy_bank_before(uid, coalesce(nxt, fantasy_start())),
    'squad', (select coalesce(jsonb_agg(jsonb_build_object('slot', s.slot, 'player_id', s.player_id,
                     'name', p.name, 'slug', p.slug, 'price', f.price, 'bought', s.price) order by s.slot), '[]'::jsonb)
                from fantasy_squad(uid, coalesce(nxt, cur, fantasy_start())) s join players p on p.id = s.player_id
                left join fantasy_prices f on f.player_id = s.player_id),
    'previous', (select coalesce(jsonb_agg(jsonb_build_object('player_id', s.player_id, 'bought', s.price,
                     'price', coalesce(f.price, s.price))), '[]'::jsonb)
                   from fantasy_squad(uid, coalesce(nxt, fantasy_start()) - 1) s
                   left join fantasy_prices f on f.player_id = s.player_id),
    'first_squad', not exists (select 1 from fantasy_picks where user_id = uid and gw < coalesce(nxt, fantasy_start())),
    'history', (select coalesce(jsonb_agg(fantasy_team_points(uid, g.gw) order by g.gw desc), '[]'::jsonb)
                  from fantasy_gws() g where g.locks_at <= now() and exists (select 1 from fantasy_picks where user_id = uid and gw <= g.gw)));
end $$;
