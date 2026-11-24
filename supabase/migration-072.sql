-- Migration 072: Specials. Custom futures markets made on the super admin
-- page, with options typed in by hand instead of picked from the players.
-- They settle, cancel and cash out exactly like the other futures.

alter table public.futures_markets add column if not exists kind text not null default 'player';
do $$ begin
  alter table public.futures_markets add constraint futures_markets_kind_check check (kind in ('player', 'special'));
exception when duplicate_object then null; end $$;

-- Two options in the same special can't share a name.
create unique index if not exists futures_selections_special_name
  on public.futures_selections (market_id, lower(name)) where player_id is null;

-- A new special starts as a hidden draft.
create or replace function public.super_special_create(p_title text)
returns bigint language plpgsql security definer set search_path = public as $$
declare mid bigint;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if nullif(btrim(p_title), '') is null then raise exception 'Give the special a title'; end if;
  insert into futures_markets (slug, title, kind, status, sort)
  values ('special-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10), btrim(p_title), 'special', 'draft',
          coalesce((select max(sort) from futures_markets), 0) + 1)
  returning id into mid;
  return mid;
end $$;

create or replace function public.super_special_add(p_market bigint, p_name text, p_price text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare sid bigint; v text := nullif(regexp_replace(coalesce(p_price, ''), '\s+', '', 'g'), '');
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if not exists (select 1 from futures_markets where id = p_market and kind = 'special') then
    raise exception 'That market isn''t a special';
  end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Type the option first'; end if;
  if v ~* '^evens$' then v := 'Evens'; end if;
  if v is not null and (frac_decimal(v) is null or frac_decimal(v) <= 1) then
    raise exception 'Can''t read % as a price. Use 5/2, 1/3 or Evens.', v;
  end if;
  if exists (select 1 from futures_selections where market_id = p_market and lower(name) = lower(btrim(p_name))) then
    raise exception 'That option is already there';
  end if;
  insert into futures_selections (market_id, player_id, name, price, base_price)
  values (p_market, null, btrim(p_name), v, v)
  returning id into sid;
  return sid;
end $$;

-- Only a special nobody has bet on can be deleted.
create or replace function public.super_special_delete(p_market bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if not exists (select 1 from futures_markets where id = p_market and kind = 'special') then
    raise exception 'Only specials can be deleted';
  end if;
  if exists (select 1 from bets b join futures_selections s on s.id = b.future_id where s.market_id = p_market) then
    raise exception 'People have bet on this. Close or settle it instead.';
  end if;
  delete from futures_selections where market_id = p_market;
  delete from futures_markets where id = p_market;
end $$;

create or replace function public.futures_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at,
           'open', m.status = 'open' and (m.closes_at is null or m.closes_at > now()),
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'player_id', s.player_id, 'name', s.name,
                                                 'price', s.price, 'result', s.result)
                              order by s.result = 'won' desc nulls last, frac_decimal(s.price) nulls last, s.name)
               from futures_selections s
              where s.market_id = m.id and (s.price is not null or s.result is not null)), '[]'::jsonb))
         order by m.kind = 'special', m.sort, m.id), '[]'::jsonb)
    from futures_markets m
   where m.status <> 'draft';
$$;

create or replace function public.super_futures()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at,
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', s.id, 'player_id', s.player_id, 'name', s.name, 'suggested', s.suggested,
                      'price', s.price, 'base_price', s.base_price, 'result', s.result,
                      'bets', coalesce(b.n, 0), 'staked', coalesce(b.staked, 0), 'liability', coalesce(b.liability, 0))
                    order by frac_decimal(coalesce(s.price, s.suggested)) nulls last, s.name)
               from futures_selections s
               left join lateral (select count(*) as n, sum(stake) as staked,
                                         sum(floor(stake * decimal_odds)) filter (where status = 'open') as liability
                                    from bets where future_id = s.id and status <> 'cancelled') b on true
              where s.market_id = m.id), '[]'::jsonb))
         order by m.kind = 'special', m.sort, m.id) from futures_markets m), '[]'::jsonb);
end $$;

revoke all on function public.super_special_create(text) from public, anon;
revoke all on function public.super_special_add(bigint, text, text) from public, anon;
revoke all on function public.super_special_delete(bigint) from public, anon;
grant execute on function public.super_special_create(text) to authenticated;
grant execute on function public.super_special_add(bigint, text, text) to authenticated;
grant execute on function public.super_special_delete(bigint) to authenticated;
