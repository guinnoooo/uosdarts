-- Futures: long-range markets priced by hand (Ham Cup winner, Dartsity).
-- A super admin sets each price; the site suggests one. Bets are fixed odds:
-- changing a price later doesn't touch bets already placed.

create table if not exists public.futures_markets (
  id bigserial primary key,
  slug text not null unique,
  title text not null,
  rules text,
  places integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'open', 'suspended', 'closed', 'settled')),
  closes_at timestamptz,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.futures_selections (
  id bigserial primary key,
  market_id bigint not null references public.futures_markets(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  name text not null,
  suggested text,
  price text,
  result text check (result in ('won', 'lost', 'void')),
  settled_at timestamptz,
  unique (market_id, player_id)
);

alter table public.futures_markets enable row level security;
alter table public.futures_selections enable row level security;

alter table public.bets alter column tournament_id drop not null;
alter table public.bets add column if not exists future_id bigint references public.futures_selections(id) on delete restrict;
create index if not exists bets_future_idx on public.bets (future_id) where future_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bets_has_target') then
    alter table public.bets add constraint bets_has_target check (tournament_id is not null or future_id is not null);
  end if;
end $$;

-- 'Evens', '5/2', '1/10' as decimal odds (stake included). Anything else is null.
create or replace function public.frac_decimal(p text) returns numeric
language sql immutable as $$
  select case
    when p ~* '^\s*evens\s*$' then 2::numeric
    when p ~ '^\s*\d{1,6}\s*/\s*[1-9]\d{0,5}\s*$'
      then round(1 + split_part(p, '/', 1)::numeric / split_part(p, '/', 2)::numeric, 6)
  end;
$$;

-- Why a selection can't be backed (or a bet on it cancelled) right now, or null.
create or replace function public.future_bet_block(p_selection bigint, p_cancel boolean default false)
returns text language sql stable security definer set search_path = public as $$
  select case
    when s.id is null then 'Market not found'
    when m.status = 'draft' then 'This market isn''t open yet'
    when m.status = 'suspended' then 'Betting on this market is suspended'
    when m.status in ('closed', 'settled') or m.closes_at <= now() then 'Betting on this market has closed'
    when s.result is not null then 'That selection has been settled'
    when not p_cancel and s.price is null then 'No price for that'
  end
  from (select 1) x
  left join futures_selections s on s.id = p_selection
  left join futures_markets m on m.id = s.market_id;
$$;

create or replace function public.place_future_bet(p_selection bigint, p_price text, p_stake integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  a accounts;
  s futures_selections;
  m futures_markets;
  why text;
  bid bigint;
begin
  if uid is null then raise exception 'Log in to bet'; end if;
  perform apply_topups(uid);
  select * into a from accounts where user_id = uid for update;
  if not found then raise exception 'Confirm your email to start betting'; end if;
  if a.banned then raise exception 'Your account can''t place bets'; end if;
  if not a.can_bet then raise exception 'Admin logins can''t bet. Sign up with your email to bet.'; end if;
  if p_stake is null or p_stake < 10 then raise exception 'The smallest bet is 10 tokens'; end if;
  if p_stake > a.tokens then raise exception 'You only have % tokens', a.tokens; end if;

  select * into s from futures_selections where id = p_selection for share;
  why := future_bet_block(p_selection);
  if why is not null then raise exception '%', why; end if;
  select * into m from futures_markets where id = s.market_id;
  if p_price is distinct from s.price then
    return jsonb_build_object('changed', true, 'price', s.price);
  end if;
  if frac_decimal(s.price) is null or frac_decimal(s.price) <= 1 then raise exception 'No price for that'; end if;

  update accounts set tokens = tokens - p_stake where user_id = uid;
  insert into bets (user_id, tournament_id, future_id, player_id, selection, market, price, decimal_odds, stake)
  values (uid, null, s.id, s.player_id, s.name, m.title, s.price, frac_decimal(s.price), p_stake)
  returning id into bid;
  return jsonb_build_object('id', bid, 'tokens', a.tokens - p_stake);
end $$;

-- The public board: every market that isn't a draft, with its priced runners.
create or replace function public.futures_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places,
           'status', m.status, 'closes_at', m.closes_at,
           'open', m.status = 'open' and (m.closes_at is null or m.closes_at > now()),
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'player_id', s.player_id, 'name', s.name,
                                                 'price', s.price, 'result', s.result)
                              order by s.result = 'won' desc nulls last, frac_decimal(s.price) nulls last, s.name)
               from futures_selections s
              where s.market_id = m.id and (s.price is not null or s.result is not null)), '[]'::jsonb))
         order by m.sort, m.id), '[]'::jsonb)
    from futures_markets m
   where m.status <> 'draft';
$$;

-- Settle one selection: won, lost, void, or null to put its bets back to open.
-- Whatever the selection paid out before is taken back first, so it can be
-- changed if a result was entered wrongly.
create or replace function public.settle_future_selection(p_selection bigint, p_result text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_result is not null and p_result not in ('won', 'lost', 'void') then raise exception 'Unknown result %', p_result; end if;
  perform 1 from futures_selections where id = p_selection for update;
  if not found then raise exception 'Selection not found'; end if;

  update accounts a set tokens = a.tokens - x.back
    from (select user_id, sum(case status when 'won' then payout when 'void' then stake else 0 end) as back
            from bets where future_id = p_selection and status in ('won', 'void') group by user_id) x
   where a.user_id = x.user_id;
  update bets set status = 'open', payout = 0, settled_at = null
   where future_id = p_selection and status in ('won', 'lost', 'void');

  if p_result is not null then
    update bets set status = p_result,
                    payout = case when p_result = 'won' then floor(stake * decimal_odds)::bigint else 0 end,
                    settled_at = now()
     where future_id = p_selection and status = 'open';
    update accounts a set tokens = a.tokens + x.back
      from (select user_id, sum(case status when 'won' then payout when 'void' then stake else 0 end) as back
              from bets where future_id = p_selection and status in ('won', 'void') group by user_id) x
     where a.user_id = x.user_id;
  end if;
  update futures_selections set result = p_result, settled_at = case when p_result is null then null else now() end
   where id = p_selection;
end $$;
revoke execute on function public.settle_future_selection(bigint, text) from public, anon, authenticated;

-- ------------------------------------------------------------ super admin

create or replace function public.super_futures()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places,
           'status', m.status, 'closes_at', m.closes_at,
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', s.id, 'player_id', s.player_id, 'name', s.name, 'suggested', s.suggested,
                      'price', s.price, 'result', s.result,
                      'bets', coalesce(b.n, 0), 'staked', coalesce(b.staked, 0), 'liability', coalesce(b.liability, 0))
                    order by frac_decimal(coalesce(s.price, s.suggested)) nulls last, s.name)
               from futures_selections s
               left join lateral (select count(*) as n, sum(stake) as staked,
                                         sum(floor(stake * decimal_odds)) filter (where status = 'open') as liability
                                    from bets where future_id = s.id and status <> 'cancelled') b on true
              where s.market_id = m.id), '[]'::jsonb))
         order by m.sort, m.id) from futures_markets m), '[]'::jsonb);
end $$;

create or replace function public.super_future_market(p_market bigint, p_title text, p_rules text, p_status text, p_closes_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_status not in ('draft', 'open', 'suspended', 'closed', 'settled') then raise exception 'Unknown status'; end if;
  if p_status = 'open' and not exists (select 1 from futures_selections where market_id = p_market and price is not null) then
    raise exception 'Set at least one price before opening the market';
  end if;
  update futures_markets set title = coalesce(nullif(btrim(p_title), ''), title), rules = nullif(btrim(p_rules), ''),
         status = p_status, closes_at = p_closes_at
   where id = p_market;
  if not found then raise exception 'Market not found'; end if;
end $$;

-- Prices for many selections at once: { "<selection id>": "5/2" | null }.
create or replace function public.super_future_prices(p_market bigint, p_prices jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare k text; v text; n integer := 0;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p_prices) loop
    v := nullif(btrim(v), '');
    if v is not null then
      if v ~* '^evens$' then v := 'Evens'; end if;
      v := regexp_replace(v, '\s+', '', 'g');
      if frac_decimal(v) is null or frac_decimal(v) <= 1 then raise exception 'Can''t read % as a price. Use 5/2, 1/3 or Evens.', v; end if;
    end if;
    update futures_selections set price = v where id = k::bigint and market_id = p_market and price is distinct from v;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function public.super_future_add(p_market bigint, p_player uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare sid bigint;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  insert into futures_selections (market_id, player_id, name)
  select p_market, p.id, p.name from players p where p.id = p_player
  on conflict (market_id, player_id) do nothing
  returning id into sid;
  if sid is null then raise exception 'They''re already in this market'; end if;
  return sid;
end $$;

create or replace function public.super_future_remove(p_selection bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if exists (select 1 from bets where future_id = p_selection) then
    raise exception 'People have bet on them. Take the price off instead, or settle them as void.';
  end if;
  delete from futures_selections where id = p_selection;
end $$;

create or replace function public.super_future_settle(p_selection bigint, p_result text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  perform settle_future_selection(p_selection, nullif(p_result, ''));
end $$;

-- Every selection in the market not settled yet, settled as lost. For when
-- the winners are in.
create or replace function public.super_future_settle_rest(p_market bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare s record; n integer := 0;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  for s in select id from futures_selections where market_id = p_market and result is null loop
    perform settle_future_selection(s.id, 'lost');
    n := n + 1;
  end loop;
  update futures_markets set status = 'settled' where id = p_market;
  return n;
end $$;

-- Everything one account has bet, for the super admin page.
create or replace function public.super_account_bets(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.placed_at desc) from (
    select b.id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as event, b.match_id, b.tournament_id
      from bets b
      left join tournaments t on t.id = b.tournament_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     where b.user_id = p_user) x), '[]'::jsonb);
end $$;

-- ------------------------------------------------- existing bet functions

create or replace function public.my_bets(p_limit integer default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.tournament_id, b.match_id, b.side, b.player_id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::bigint as returns, b.placed_at, b.settled_at,
           coalesce(t.name, fm.title) as tournament, fs.market_id as future_market,
           b.status = 'open' and (case when b.match_id is not null then match_bet_block(b.match_id)
                                       when b.future_id is not null then future_bet_block(b.future_id, true)
                                       else outright_bet_block(b.tournament_id) end) is null as can_cancel
      from bets b
      left join tournaments t on t.id = b.tournament_id
      left join futures_selections fs on fs.id = b.future_id
      left join futures_markets fm on fm.id = fs.market_id
     where b.user_id = auth.uid()
     order by b.placed_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
$$;

create or replace function public.cancel_bet(p_bet bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  b bets;
  why text;
begin
  select * into b from bets where id = p_bet and user_id = auth.uid() for update;
  if not found then raise exception 'Bet not found'; end if;
  if b.status <> 'open' then raise exception 'That bet has already been settled'; end if;
  why := case when b.match_id is not null then match_bet_block(b.match_id)
              when b.future_id is not null then future_bet_block(b.future_id, true)
              else outright_bet_block(b.tournament_id) end;
  if why is not null then raise exception 'Too late to cancel: %', lower(left(why, 1)) || substr(why, 2); end if;
  update bets set status = 'cancelled', settled_at = now() where id = b.id;
  update accounts set tokens = tokens + b.stake where user_id = b.user_id;
  return (select tokens from accounts where user_id = b.user_id);
end $$;

-- ------------------------------------------------------------ the markets

insert into public.futures_markets (slug, title, rules, places, closes_at, sort) values
  ('ham-cup', 'Ham Cup winner',
   'Who wins the Ham Cup on Saturday 5 December. Anyone who doesn''t play is void and your stake comes back.',
   1, timestamptz '2026-12-05 10:00 Europe/London', 1),
  ('dartsity-stage', 'To play on stage at Dartsity',
   'Wins if they play on stage at Dartsity on 3 March 2027, as one of Ben''s picks or a qualifier winner.',
   6, null, 2),
  ('dartsity-qualifiers', 'To win a Dartsity qualifier',
   'Wins if they win either of the two qualifiers. Void, with your stake back, if Ben picks them for the stage.',
   2, null, 3)
on conflict (slug) do nothing;

-- Suggested prices (from simulating the Ham Cup, Ben's picks and the qualifiers
-- with the match model). Final prices are set on the super admin page.
insert into public.futures_selections (market_id, player_id, name, suggested)
select m.id, p.id, p.name, s.value
  from jsonb_each('{"ham-cup":{"Lewis Forrest":"10/11","Luke Davies":"4/1","Mikey Guinness":"5/1","Oli Graham":"6/1","Dan Wells":"10/1","Matt Watts":"16/1","Adam Khalil":"66/1","Luke Egan":"50/1","Joel Keaney":"66/1","Matt Duke":"100/1","Max Halder":"150/1","Barney Chaudhry":"250/1"},"dartsity-stage":{"Lewis Forrest":"1/10","Luke Davies":"1/6","Mikey Guinness":"1/10","Oli Graham":"1/10","Dan Wells":"2/5","Matt Watts":"1/2","Adam Khalil":"5/2","Luke Egan":"11/4","Joel Keaney":"7/2","Matt Duke":"9/2","Max Halder":"8/1","Barney Chaudhry":"16/1","Liam English":"20/1","Jack Warby":"25/1","Joseph D''Ambrosio":"33/1","Dan Buckley":"33/1","Rory Peach":"66/1","James Lauer":"80/1","James Beer":"80/1","Darsh Johar":"80/1","Cian Hughes":"100/1","Jack Newton":"66/1","Louis Woods-Kelly":"66/1","Dan Campbell":"150/1","Tom Sibley":"150/1","Evan Buxton":"150/1","Iwan James":"250/1","Ed Browne":"250/1","Alfie Mortimer":"250/1"},"dartsity-qualifiers":{"Lewis Forrest":"1/5","Luke Davies":"4/9","Mikey Guinness":"1/2","Oli Graham":"4/7","Dan Wells":"4/6","Matt Watts":"5/4","Adam Khalil":"7/2","Luke Egan":"7/2","Joel Keaney":"9/2","Matt Duke":"6/1","Max Halder":"9/1","Barney Chaudhry":"16/1","Liam English":"25/1","Jack Warby":"25/1","Joseph D''Ambrosio":"40/1","Dan Buckley":"40/1","Rory Peach":"66/1","James Lauer":"100/1","James Beer":"100/1","Darsh Johar":"80/1","Cian Hughes":"100/1","Jack Newton":"66/1","Louis Woods-Kelly":"66/1","Dan Campbell":"150/1","Tom Sibley":"250/1","Evan Buxton":"150/1","Iwan James":"250/1","Ed Browne":"250/1","Alfie Mortimer":"250/1"}}'::jsonb) mk
  join public.futures_markets m on m.slug = mk.key
  cross join lateral jsonb_each_text(mk.value) s
  join public.players p on p.name = s.key
on conflict (market_id, player_id) do update set suggested = excluded.suggested;

-- Only students and first-year alumni can play on stage, so these four are out
-- of both Dartsity markets, and the Dartsity suggestions are rerun without them.
delete from public.futures_selections s using public.futures_markets m, public.players p
 where m.id = s.market_id and p.id = s.player_id
   and m.slug in ('dartsity-stage', 'dartsity-qualifiers')
   and p.name in ('Matt Watts', 'Luke Davies', 'Oli Graham', 'Adam Khalil')
   and not exists (select 1 from public.bets b where b.future_id = s.id);

insert into public.futures_selections (market_id, player_id, name, suggested)
select m.id, p.id, p.name, s.value
  from jsonb_each('{"dartsity-stage":{"Lewis Forrest":"1/10","Mikey Guinness":"1/10","Dan Wells":"1/10","Luke Egan":"4/9","Joel Keaney":"4/7","Matt Duke":"4/5","Max Halder":"6/4","Barney Chaudhry":"7/2","Liam English":"9/2","Jack Warby":"11/2","Joseph D''Ambrosio":"8/1","Dan Buckley":"7/1","Rory Peach":"14/1","James Lauer":"16/1","James Beer":"20/1","Darsh Johar":"16/1","Cian Hughes":"20/1","Jack Newton":"16/1","Louis Woods-Kelly":"16/1","Dan Campbell":"33/1","Tom Sibley":"40/1","Evan Buxton":"40/1","Iwan James":"40/1","Ed Browne":"66/1","Alfie Mortimer":"66/1","Sam Tookey":"100/1","Aidan Garratt":"100/1","Finley Bowden":"150/1","Aidan Wood":"100/1","James Phillips":"100/1","Adam Butcher":"150/1","Harvey Simpson":"100/1","Oli Makin":"150/1","George Burton":"150/1","Luke Lavery":"150/1","Matt Hawkins":"150/1","Danny Hartland":"150/1","Jude Cockin":"150/1","Ben Clarke":"150/1","Mike Britland":"250/1","Finley Jackson":"250/1","Leila Mitchell":"150/1","Ben Browne":"250/1","Thomas Batho":"250/1","Jack Vicars":"250/1"},"dartsity-qualifiers":{"Lewis Forrest":"1/8","Mikey Guinness":"1/5","Dan Wells":"2/7","Luke Egan":"10/11","Joel Keaney":"5/4","Matt Duke":"6/4","Max Halder":"5/2","Barney Chaudhry":"9/2","Liam English":"6/1","Jack Warby":"7/1","Joseph D''Ambrosio":"10/1","Dan Buckley":"9/1","Rory Peach":"16/1","James Lauer":"16/1","James Beer":"20/1","Darsh Johar":"20/1","Cian Hughes":"25/1","Jack Newton":"20/1","Louis Woods-Kelly":"20/1","Dan Campbell":"33/1","Tom Sibley":"40/1","Evan Buxton":"50/1","Iwan James":"50/1","Ed Browne":"80/1","Alfie Mortimer":"80/1","Sam Tookey":"100/1","Aidan Garratt":"150/1","Finley Bowden":"150/1","Aidan Wood":"100/1","James Phillips":"150/1","Adam Butcher":"150/1","Harvey Simpson":"150/1","Oli Makin":"150/1","George Burton":"150/1","Luke Lavery":"150/1","Matt Hawkins":"150/1","Danny Hartland":"250/1","Jude Cockin":"250/1","Ben Clarke":"150/1","Mike Britland":"250/1","Finley Jackson":"250/1","Leila Mitchell":"150/1","Ben Browne":"250/1","Thomas Batho":"250/1","Jack Vicars":"250/1"}}'::jsonb) mk
  join public.futures_markets m on m.slug = mk.key
  cross join lateral jsonb_each_text(mk.value) s
  join public.players p on p.name = s.key
on conflict (market_id, player_id) do update set suggested = excluded.suggested;

-- At most two alumni can play on stage, and Jack Newton isn't eligible. Dartsity
-- suggestions rerun with that cap; anyone no longer suggested is dropped if
-- nobody has bet on them.
with j as (select '{"dartsity-stage":{"Lewis Forrest":"1/10","Mikey Guinness":"1/10","Dan Wells":"1/10","Luke Egan":"2/7","Joel Keaney":"1/2","Matt Duke":"40/1","Max Halder":"Evens","Barney Chaudhry":"5/2","Liam English":"3/1","Jack Warby":"9/2","Joseph D''Ambrosio":"6/1","Dan Buckley":"11/2","Rory Peach":"9/1","James Lauer":"10/1","Darsh Johar":"14/1","Cian Hughes":"16/1","Dan Campbell":"20/1","Tom Sibley":"25/1","Evan Buxton":"25/1","Iwan James":"33/1","Ed Browne":"40/1","Alfie Mortimer":"50/1","Sam Tookey":"66/1","Aidan Garratt":"80/1","Finley Bowden":"80/1","Aidan Wood":"80/1","James Phillips":"100/1","Harvey Simpson":"80/1","Oli Makin":"100/1","George Burton":"100/1","Luke Lavery":"100/1","Matt Hawkins":"100/1","Danny Hartland":"150/1","Jude Cockin":"100/1","Ben Clarke":"150/1","Mike Britland":"100/1","Finley Jackson":"150/1","Leila Mitchell":"100/1","Ben Browne":"250/1","Thomas Batho":"150/1","Jack Vicars":"150/1","Jono Blatch":"250/1","Alex Vienna":"250/1"},"dartsity-qualifiers":{"Lewis Forrest":"40/1","Mikey Guinness":"10/1","Dan Wells":"1/4","Luke Egan":"4/6","Joel Keaney":"10/11","Max Halder":"7/4","Barney Chaudhry":"3/1","Liam English":"4/1","Jack Warby":"11/2","Joseph D''Ambrosio":"7/1","Dan Buckley":"13/2","Rory Peach":"10/1","James Lauer":"12/1","Darsh Johar":"16/1","Cian Hughes":"16/1","Dan Campbell":"20/1","Tom Sibley":"33/1","Evan Buxton":"33/1","Iwan James":"40/1","Ed Browne":"50/1","Alfie Mortimer":"50/1","Sam Tookey":"66/1","Aidan Garratt":"100/1","Finley Bowden":"100/1","Aidan Wood":"80/1","James Phillips":"100/1","Harvey Simpson":"100/1","Oli Makin":"100/1","George Burton":"100/1","Luke Lavery":"100/1","Matt Hawkins":"150/1","Danny Hartland":"150/1","Jude Cockin":"150/1","Ben Clarke":"150/1","Mike Britland":"150/1","Finley Jackson":"150/1","Leila Mitchell":"100/1","Ben Browne":"250/1","Thomas Batho":"150/1","Jack Vicars":"250/1","Jono Blatch":"250/1","Alex Vienna":"250/1"}}'::jsonb as v),
want as (
  select m.id as market_id, p.id as player_id, p.name, s.value as sugg
    from j cross join lateral jsonb_each(j.v) mk
    join public.futures_markets m on m.slug = mk.key
    cross join lateral jsonb_each_text(mk.value) s
    join public.players p on p.name = s.key),
gone as (
  delete from public.futures_selections fs using public.futures_markets m
   where m.id = fs.market_id and m.slug in ('dartsity-stage', 'dartsity-qualifiers')
     and not exists (select 1 from want w where w.market_id = fs.market_id and w.player_id = fs.player_id)
     and not exists (select 1 from public.bets b where b.future_id = fs.id))
insert into public.futures_selections (market_id, player_id, name, suggested)
select market_id, player_id, name, sugg from want
on conflict (market_id, player_id) do update set suggested = excluded.suggested;
