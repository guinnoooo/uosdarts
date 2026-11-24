-- Migration 049: email accounts, token betting and the leaderboard.
--
-- Accounts
--   An account is made when someone confirms their email (the link Supabase
--   sends after sign-up). It holds their chat name, their email (visible to
--   super admins only) and their tokens: 10,000 to start, plus 500 for
--   everyone at 6pm (UK time) every Monday. Top-ups are added whenever an
--   account is looked at, so nothing has to run on a timer.
--   Admin logins (username@uosdarts.com) don't get one.
-- Chat
--   Reading and posting need an account; posting also needs it not banned.
--   The name on a message is the account's name.
-- Bets
--   Placed only through the place-bet edge function, which prices them with
--   the site's own model and then calls place_bet_internal (service role
--   only). Match bets close when the match starts; outright bets close when
--   the tournament's first match starts. Friendlies can't be bet on.
--   Settling is automatic: when a match or tournament finishes, and again if
--   a result is undone or changed. If a match's players change, or the
--   match or tournament is deleted, open bets on it are refunded.

-- ---------------------------------------------------------------- accounts

-- The most recent Monday 6pm, UK time, at or before p_at.
create or replace function public.week_grant_time(p_at timestamptz default now()) returns timestamptz
language sql stable set search_path = public as $$
  select (case when (l18 at time zone 'Europe/London') <= p_at then l18 else l18 - interval '7 days' end)
         at time zone 'Europe/London'
    from (select date_trunc('week', p_at at time zone 'Europe/London') + interval '18 hours' as l18) s;
$$;

create table if not exists public.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text,
  tokens bigint not null default 10000,
  banned boolean not null default false,
  last_grant timestamptz not null default public.week_grant_time(),
  created_at timestamptz not null default now()
);
create unique index if not exists accounts_name_key on public.accounts (lower(display_name));
alter table public.accounts enable row level security;
drop policy if exists "own account" on public.accounts;
create policy "own account" on public.accounts for select
  using (user_id = (select auth.uid()) or (select is_super()));

-- Adds any Monday top-ups owed (one user, or everyone when null).
create or replace function public.apply_topups(p_user uuid default null) returns void
language sql security definer set search_path = public as $$
  update accounts
     set tokens = tokens + 500 * round(extract(epoch from (g - last_grant)) / 604800)::int,
         last_grant = g
    from (select week_grant_time() as g) w
   where (p_user is null or user_id = p_user) and g > last_grant + interval '6 days';
$$;
revoke execute on function public.apply_topups(uuid) from public, anon, authenticated;

-- Makes the account when an email is confirmed. The name comes from what
-- they typed at sign-up; a clash gets a number added.
create or replace function public.make_account() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text;
  nm text;
  i int := 1;
begin
  if coalesce(new.is_anonymous, false) or new.email_confirmed_at is null or new.email is null then return new; end if;
  if lower(new.email) like '%@uosdarts.com' then return new; end if;
  if exists (select 1 from accounts where user_id = new.id) then
    update accounts set email = new.email where user_id = new.id and email is distinct from new.email;
    return new;
  end if;
  base := left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'display_name', ''), '\s+', ' ', 'g')), 30);
  if base = '' then base := left(split_part(new.email, '@', 1), 30); end if;
  nm := base;
  while exists (select 1 from accounts where lower(display_name) = lower(nm)) loop
    i := i + 1;
    nm := left(base, 26) || ' ' || i;
  end loop;
  insert into accounts (user_id, display_name, email) values (new.id, nm, new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_account on auth.users;
create trigger on_auth_user_account
  after insert or update of email_confirmed_at, email on auth.users
  for each row execute function public.make_account();

-- For the sign-up form: is a name free?
create or replace function public.name_available(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select length(btrim(coalesce(p_name, ''))) between 2 and 30
     and not exists (select 1 from accounts where lower(display_name) = lower(btrim(p_name)));
$$;

create or replace function public.has_account() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from accounts where user_id = auth.uid());
$$;

-- The signed-in user's account, with top-ups applied. Null without one.
create or replace function public.my_account() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a accounts;
begin
  if auth.uid() is null then return null; end if;
  perform apply_topups(auth.uid());
  select * into a from accounts where user_id = auth.uid();
  if not found then return null; end if;
  return jsonb_build_object(
    'display_name', a.display_name, 'email', a.email, 'tokens', a.tokens, 'banned', a.banned,
    'in_play', (select coalesce(sum(stake), 0) from bets where user_id = a.user_id and status = 'open'),
    'next_topup', week_grant_time() + interval '7 days');
end $$;

-- ---------------------------------------------------------------- chat

drop policy if exists "chat readable" on public.match_chat;
create policy "chat readable" on public.match_chat for select using ((select has_account()));

create or replace function public.post_chat(p_match uuid, p_name text, p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  a accounts;
  b text := btrim(coalesce(p_body, ''));
  new_id bigint;
begin
  select * into a from accounts where user_id = auth.uid();
  if not found then raise exception 'Log in to chat'; end if;
  if a.banned then raise exception 'Your account can''t post in the chat'; end if;
  if b = '' then raise exception 'Type a message'; end if;
  if length(b) > 280 then raise exception 'Messages can be up to 280 characters'; end if;
  if not exists (select 1 from matches where id = p_match) then raise exception 'Match not found'; end if;
  if exists (select 1 from match_chat where user_id = auth.uid() and created_at > now() - interval '2 seconds') then
    raise exception 'Slow down a little';
  end if;
  if (select count(*) from match_chat where user_id = auth.uid() and created_at > now() - interval '1 minute') >= 15 then
    raise exception 'That''s a lot of messages. Give it a minute';
  end if;
  insert into match_chat (match_id, user_id, author, body) values (p_match, auth.uid(), a.display_name, b)
  returning id into new_id;
  return new_id;
end $$;

-- ---------------------------------------------------------------- bets

create table if not exists public.bets (
  id bigserial primary key,
  user_id uuid not null references public.accounts(user_id) on delete cascade,
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,   -- null for an outright
  side smallint check (side in (1, 2)),                              -- match bets
  player_id uuid references public.players(id),                      -- outright bets
  selection text not null,
  market text not null,
  price text not null,
  decimal_odds numeric not null check (decimal_odds > 1),
  stake integer not null check (stake > 0),
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'void')),
  payout integer not null default 0,
  model_version integer,
  placed_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists bets_user_idx on public.bets (user_id, placed_at desc);
create index if not exists bets_match_idx on public.bets (match_id) where match_id is not null;
create index if not exists bets_tournament_idx on public.bets (tournament_id);
alter table public.bets enable row level security;
drop policy if exists "own bets" on public.bets;
create policy "own bets" on public.bets for select
  using (user_id = (select auth.uid()) or (select is_super()));

-- Who won a finished match, as a side (1 or 2). Null if not finished.
create or replace function public.match_winner_side(m matches) returns smallint
language sql immutable as $$
  select case
    when m.status <> 'complete' then null
    when m.winner_id is not null and m.player1_id is not null and m.player2_id is not null
      then case when m.winner_id = m.player1_id then 1 else 2 end
    when m.sets_to_win is not null
      then case when m.p1_sets > m.p2_sets then 1 when m.p2_sets > m.p1_sets then 2 end
    else case when m.p1_legs > m.p2_legs then 1 when m.p2_legs > m.p1_legs then 2 end
  end::smallint;
$$;

-- Settles a match's bets from scratch: anything already settled is undone,
-- then open bets are paid or lost on the current result.
create or replace function public.resettle_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  w smallint;
begin
  if not exists (select 1 from bets where match_id = p_match and status in ('open', 'won', 'lost')) then return; end if;
  update accounts a set tokens = a.tokens - x.paid
    from (select user_id, sum(payout) as paid from bets where match_id = p_match and status = 'won' group by user_id) x
   where a.user_id = x.user_id;
  update bets set status = 'open', payout = 0, settled_at = null where match_id = p_match and status in ('won', 'lost');

  select * into m from matches where id = p_match;
  w := match_winner_side(m);
  if w is null then return; end if;
  update bets set status = case when side = w then 'won' else 'lost' end,
                  payout = case when side = w then floor(stake * decimal_odds)::int else 0 end,
                  settled_at = now()
   where match_id = p_match and status = 'open';
  update accounts a set tokens = a.tokens + x.paid
    from (select user_id, sum(payout) as paid from bets where match_id = p_match and status = 'won' group by user_id) x
   where a.user_id = x.user_id;
end $$;

-- The same for a tournament's outright bets, on its champion.
create or replace function public.resettle_outright(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t tournaments;
begin
  if not exists (select 1 from bets where tournament_id = p_tournament and match_id is null and status in ('open', 'won', 'lost')) then return; end if;
  update accounts a set tokens = a.tokens - x.paid
    from (select user_id, sum(payout) as paid from bets
           where tournament_id = p_tournament and match_id is null and status = 'won' group by user_id) x
   where a.user_id = x.user_id;
  update bets set status = 'open', payout = 0, settled_at = null
   where tournament_id = p_tournament and match_id is null and status in ('won', 'lost');

  select * into t from tournaments where id = p_tournament;
  if t.status <> 'complete' or t.champion_id is null then return; end if;
  update bets set status = case when player_id = t.champion_id then 'won' else 'lost' end,
                  payout = case when player_id = t.champion_id then floor(stake * decimal_odds)::int else 0 end,
                  settled_at = now()
   where tournament_id = p_tournament and match_id is null and status = 'open';
  update accounts a set tokens = a.tokens + x.paid
    from (select user_id, sum(payout) as paid from bets
           where tournament_id = p_tournament and match_id is null and status = 'won' group by user_id) x
   where a.user_id = x.user_id;
end $$;

-- Refunds open bets: on one match, or (p_match null) everything open in a tournament.
create or replace function public.void_open_bets(p_tournament uuid, p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update accounts a set tokens = a.tokens + x.back
    from (select user_id, sum(stake) as back from bets
           where status = 'open' and (match_id = p_match or (p_match is null and tournament_id = p_tournament))
           group by user_id) x
   where a.user_id = x.user_id;
  update bets set status = 'void', settled_at = now()
   where status = 'open' and (match_id = p_match or (p_match is null and tournament_id = p_tournament));
end $$;

create or replace function public.bets_follow_match() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform void_open_bets(old.tournament_id, old.id);
    return old;
  end if;
  -- Players changed before it started: the bets were on a different match.
  if new.status = 'pending' and (
       (old.player1_id is not null and old.player1_id is distinct from new.player1_id)
    or (old.player2_id is not null and old.player2_id is distinct from new.player2_id)
    or (old.p1_name is not null and old.p1_name is distinct from new.p1_name)
    or (old.p2_name is not null and old.p2_name is distinct from new.p2_name)) then
    perform void_open_bets(new.tournament_id, new.id);
  end if;
  if old.status = 'complete' or new.status = 'complete' then
    perform resettle_match(new.id);
  end if;
  return new;
end $$;
drop trigger if exists matches_bets on public.matches;
create trigger matches_bets
  after update of status, winner_id, p1_legs, p2_legs, p1_sets, p2_sets, player1_id, player2_id, p1_name, p2_name
  on public.matches for each row execute function public.bets_follow_match();
drop trigger if exists matches_bets_delete on public.matches;
create trigger matches_bets_delete before delete on public.matches
  for each row execute function public.bets_follow_match();

create or replace function public.bets_follow_tournament() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform void_open_bets(new.id, null);
    return new;
  end if;
  if new.status is distinct from old.status or new.champion_id is distinct from old.champion_id then
    perform resettle_outright(new.id);
  end if;
  return new;
end $$;
drop trigger if exists tournaments_bets on public.tournaments;
create trigger tournaments_bets after update of status, champion_id, deleted_at on public.tournaments
  for each row execute function public.bets_follow_tournament();

-- Can this match be bet on right now? Returns the reason it can't, or null.
create or replace function public.match_bet_block(p_match uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when m.id is null then 'Match not found'
    when t.deleted_at is not null or t.is_friendly then 'This match can''t be bet on'
    when m.status <> 'pending' or m.started_at is not null
      or exists (select 1 from visits v where v.match_id = m.id) then 'Betting closed when this match started'
    when coalesce(m.player1_id::text, nullif(btrim(m.p1_name), '')) is null
      or coalesce(m.player2_id::text, nullif(btrim(m.p2_name), '')) is null then 'Both players need to be known first'
  end
  from (select 1) x
  left join matches m on m.id = p_match
  left join tournaments t on t.id = m.tournament_id;
$$;

create or replace function public.outright_bet_block(p_tournament uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when t.id is null then 'Tournament not found'
    when t.deleted_at is not null or t.is_friendly or t.kind is not null then 'This tournament can''t be bet on'
    when t.status = 'complete' then 'This tournament has finished'
    when not exists (select 1 from matches m where m.tournament_id = t.id) then 'Betting opens once the draw is made'
    when exists (select 1 from matches m where m.tournament_id = t.id
                  and (m.status = 'live' or (m.status = 'complete' and m.player1_id is not null and m.player2_id is not null)))
      then 'Betting closed when the tournament started'
  end
  from (select 1) x left join tournaments t on t.id = p_tournament;
$$;

-- Called by the place-bet edge function only, after it has worked out the price.
create or replace function public.place_bet_internal(
  p_user uuid, p_tournament uuid, p_match uuid, p_side smallint, p_player uuid,
  p_selection text, p_market text, p_price text, p_decimal numeric, p_stake integer, p_version integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a accounts;
  why text;
  bid bigint;
begin
  perform apply_topups(p_user);
  select * into a from accounts where user_id = p_user for update;
  if not found then raise exception 'Confirm your email to start betting'; end if;
  if a.banned then raise exception 'Your account can''t place bets'; end if;
  if p_stake is null or p_stake < 10 then raise exception 'The smallest bet is 10 tokens'; end if;
  if p_stake > a.tokens then raise exception 'You only have % tokens', a.tokens; end if;
  if p_decimal is null or p_decimal <= 1 then raise exception 'No price for that'; end if;

  if p_match is not null then
    why := match_bet_block(p_match);
    if why is not null then raise exception '%', why; end if;
    if p_side not in (1, 2) then raise exception 'Pick a side'; end if;
    if not exists (select 1 from matches where id = p_match and tournament_id = p_tournament) then raise exception 'Match not found'; end if;
  else
    why := outright_bet_block(p_tournament);
    if why is not null then raise exception '%', why; end if;
    if not exists (select 1 from tournament_players where tournament_id = p_tournament and player_id = p_player) then
      raise exception 'They aren''t in this tournament';
    end if;
  end if;

  update accounts set tokens = tokens - p_stake where user_id = p_user;
  insert into bets (user_id, tournament_id, match_id, side, player_id, selection, market, price, decimal_odds, stake, model_version)
  values (p_user, p_tournament, p_match, case when p_match is not null then p_side end, case when p_match is null then p_player end,
          p_selection, p_market, p_price, p_decimal, p_stake, p_version)
  returning id into bid;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake);
end $$;
revoke execute on function public.place_bet_internal(uuid, uuid, uuid, smallint, uuid, text, text, text, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.place_bet_internal(uuid, uuid, uuid, smallint, uuid, text, text, text, numeric, integer, integer) to service_role;

-- The signed-in user's bets, newest first.
create or replace function public.my_bets(p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.tournament_id, b.match_id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::int as returns, b.placed_at, b.settled_at, t.name as tournament
      from bets b join tournaments t on t.id = b.tournament_id
     where b.user_id = auth.uid()
     order by b.placed_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
$$;

-- ---------------------------------------------------------------- leaderboard

create or replace function public.leaderboard() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform apply_topups(null);
  return coalesce((
    select jsonb_agg(x order by x.total desc, x.name)
      from (
        select a.display_name as name, a.tokens,
               coalesce(o.in_play, 0) as in_play, a.tokens + coalesce(o.in_play, 0) as total,
               coalesce(s.placed, 0) as placed, coalesce(s.won, 0) as won,
               a.user_id = auth.uid() as me
          from accounts a
          left join (select user_id, sum(stake) as in_play from bets where status = 'open' group by user_id) o on o.user_id = a.user_id
          left join (select user_id, count(*) as placed, count(*) filter (where status = 'won') as won
                       from bets where status <> 'void' group by user_id) s on s.user_id = a.user_id
         where not a.banned
      ) x), '[]'::jsonb);
end $$;

-- What's been bet on a match (for the match page): totals only, no names.
create or replace function public.match_bet_totals(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bets', count(*),
    'side1', coalesce(sum(stake) filter (where side = 1), 0),
    'side2', coalesce(sum(stake) filter (where side = 2), 0))
    from bets where match_id = p_match and status <> 'void';
$$;

-- ---------------------------------------------------------------- super admin

create or replace function public.super_list_accounts() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  perform apply_topups(null);
  return coalesce((
    select jsonb_agg(x order by x.created_at desc) from (
      select a.user_id, a.display_name, a.email, a.tokens, a.banned, a.created_at,
             (select count(*) from bets b where b.user_id = a.user_id) as bets,
             (select count(*) from match_chat c where c.user_id = a.user_id) as messages
        from accounts a) x), '[]'::jsonb);
end $$;

create or replace function public.super_set_banned(p_user uuid, p_banned boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  update accounts set banned = coalesce(p_banned, false) where user_id = p_user;
  if not found then raise exception 'Account not found'; end if;
end $$;

create or replace function public.super_adjust_tokens(p_user uuid, p_change integer) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_change is null or p_change = 0 then raise exception 'Enter a number of tokens'; end if;
  update accounts set tokens = greatest(0, tokens + p_change) where user_id = p_user returning tokens into n;
  if not found then raise exception 'Account not found'; end if;
  return n;
end $$;

-- A message's sender, for super admins checking who said what.
create or replace function public.super_chat_sender(p_message bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return (select jsonb_build_object('display_name', a.display_name, 'email', a.email, 'banned', a.banned, 'user_id', a.user_id)
            from match_chat c left join accounts a on a.user_id = c.user_id where c.id = p_message);
end $$;

revoke execute on function public.resettle_match(uuid) from public, anon, authenticated;
revoke execute on function public.resettle_outright(uuid) from public, anon, authenticated;
revoke execute on function public.void_open_bets(uuid, uuid) from public, anon, authenticated;
