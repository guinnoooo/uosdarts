-- Futures categories: the headings markets are grouped under on the Futures
-- page (Futures, Specials, Ham Cup specials...). Super admins add, rename,
-- delete and reorder them, put any market in any of them, and reorder the
-- markets within one. A market's kind still says what its options are:
-- 'player' (players, with suggested prices) or 'special' (typed options).

create table if not exists futures_categories (
  id         bigserial primary key,
  name       text not null unique check (btrim(name) != ''),
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
alter table futures_categories enable row level security;
revoke all on futures_categories from anon, authenticated;

insert into futures_categories (name, sort) values ('Futures', 1), ('Specials', 2) on conflict (name) do nothing;

alter table futures_markets add column if not exists category_id bigint references futures_categories(id) on delete set null;
update futures_markets set category_id = (select id from futures_categories where name = case when kind = 'special' then 'Specials' else 'Futures' end)
 where category_id is null;

-- What the page shows: categories in order, markets in order within them.
create or replace function public.futures_board()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at,
           'category', coalesce(c.name, case when m.kind = 'special' then 'Specials' else 'Futures' end),
           'open', m.status = 'open' and (m.closes_at is null or m.closes_at > now()),
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'player_id', s.player_id, 'name', s.name,
                                                 'price', s.price, 'result', s.result,
                                                 'was', case when s.price_moved_at > now() - interval '7 days' then s.prev_price end)
                              order by s.result = 'won' desc nulls last, frac_decimal(s.price) nulls last, s.name)
               from futures_selections s
              where s.market_id = m.id and (s.price is not null or s.result is not null)), '[]'::jsonb))
         order by c.sort nulls last, c.id, m.sort, m.id), '[]'::jsonb)
    from futures_markets m
    left join futures_categories c on c.id = m.category_id
   where m.status != 'draft';
$function$;

create or replace function public.super_futures()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at, 'category_id', m.category_id,
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', s.id, 'player_id', s.player_id, 'name', s.name, 'suggested', s.suggested,
                      'price', s.price, 'base_price', s.base_price, 'result', s.result,
                      'proposed', s.proposed, 'proposed_reason', s.proposed_reason,
                      'bets', coalesce(b.n, 0), 'staked', coalesce(b.staked, 0), 'liability', coalesce(b.liability, 0))
                    order by frac_decimal(coalesce(s.price, s.suggested)) nulls last, s.name)
               from futures_selections s
               left join lateral (select count(*) as n, sum(stake) as staked,
                                         sum(floor(stake * decimal_odds)) filter (where status = 'open') as liability
                                    from bets where future_id = s.id and status != 'cancelled') b on true
              where s.market_id = m.id), '[]'::jsonb))
         order by c.sort nulls last, c.id, m.sort, m.id)
    from futures_markets m left join futures_categories c on c.id = m.category_id), '[]'::jsonb);
end $function$;

create or replace function public.super_future_categories()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort', c.sort,
           'markets', (select count(*) from futures_markets m where m.category_id = c.id)) order by c.sort, c.id)
    from futures_categories c), '[]'::jsonb);
end $function$;

-- Add a category (no id) or rename one.
create or replace function public.super_future_category(p_id bigint, p_name text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare cid bigint;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Give the category a name'; end if;
  if exists (select 1 from futures_categories where lower(name) = lower(btrim(p_name)) and id is distinct from p_id) then
    raise exception 'There''s already a category called %', btrim(p_name);
  end if;
  if p_id is null then
    insert into futures_categories (name, sort)
    values (btrim(p_name), coalesce((select max(sort) from futures_categories), 0) + 1)
    returning id into cid;
  else
    update futures_categories set name = btrim(p_name) where id = p_id returning id into cid;
    if cid is null then raise exception 'Category not found'; end if;
  end if;
  return cid;
end $function$;

create or replace function public.super_future_category_delete(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if exists (select 1 from futures_markets where category_id = p_id) then
    raise exception 'Move its markets to another category first';
  end if;
  delete from futures_categories where id = p_id;
end $function$;

-- Move a category, or a market within its category, one place up (-1) or
-- down (1), by swapping with its neighbour. Sort numbers are renumbered
-- first so there are no ties.
create or replace function public.super_future_move(p_what text, p_id bigint, p_dir integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare cat bigint; ids bigint[]; i integer; j integer;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_dir not in (-1, 1) then raise exception 'Move up or down one place'; end if;
  if p_what = 'category' then
    select array_agg(id order by sort, id) into ids from futures_categories;
  elsif p_what = 'market' then
    select category_id into cat from futures_markets where id = p_id;
    select array_agg(id order by sort, id) into ids from futures_markets where category_id is not distinct from cat;
  else
    raise exception 'Unknown thing to move';
  end if;
  i := array_position(ids, p_id);
  if i is null then raise exception 'Not found'; end if;
  j := i + p_dir;
  if j < 1 or j > cardinality(ids) then return; end if;
  ids[i] := ids[j]; ids[j] := p_id;
  if p_what = 'category' then
    update futures_categories c set sort = x.n from unnest(ids) with ordinality x(id, n) where c.id = x.id;
  else
    update futures_markets m set sort = x.n from unnest(ids) with ordinality x(id, n) where m.id = x.id;
  end if;
end $function$;

-- Put a market in a category (it goes to the end of that category).
create or replace function public.super_future_set_category(p_market bigint, p_category bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if not exists (select 1 from futures_categories where id = p_category) then raise exception 'Category not found'; end if;
  update futures_markets set category_id = p_category,
         sort = coalesce((select max(sort) from futures_markets where category_id = p_category and id != p_market), 0) + 1
   where id = p_market and category_id is distinct from p_category;
end $function$;

-- A new market in a category: 'player' (pick players) or 'special' (typed
-- options). Starts as a hidden draft at the end of the category.
create or replace function public.super_future_create(p_title text, p_category bigint, p_kind text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare mid bigint;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if nullif(btrim(p_title), '') is null then raise exception 'Give the market a title'; end if;
  if p_kind not in ('player', 'special') then raise exception 'Pick players or typed options'; end if;
  if not exists (select 1 from futures_categories where id = p_category) then raise exception 'Pick a category'; end if;
  insert into futures_markets (slug, title, kind, status, sort, category_id)
  values (p_kind || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10), btrim(p_title), p_kind, 'draft',
          coalesce((select max(sort) from futures_markets where category_id = p_category), 0) + 1, p_category)
  returning id into mid;
  return mid;
end $function$;

revoke all on function public.super_future_categories() from public, anon;
revoke all on function public.super_future_category(bigint, text) from public, anon;
revoke all on function public.super_future_category_delete(bigint) from public, anon;
revoke all on function public.super_future_move(text, bigint, integer) from public, anon;
revoke all on function public.super_future_set_category(bigint, bigint) from public, anon;
revoke all on function public.super_future_create(text, bigint, text) from public, anon;
grant execute on function public.super_future_categories() to authenticated;
grant execute on function public.super_future_category(bigint, text) to authenticated;
grant execute on function public.super_future_category_delete(bigint) to authenticated;
grant execute on function public.super_future_move(text, bigint, integer) to authenticated;
grant execute on function public.super_future_set_category(bigint, bigint) to authenticated;
grant execute on function public.super_future_create(text, bigint, text) to authenticated;

-- Any market nobody has bet on can be deleted, not just specials, now that
-- player markets can be made from the super admin page too.
create or replace function public.super_special_delete(p_market bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if not exists (select 1 from futures_markets where id = p_market) then raise exception 'Market not found'; end if;
  if exists (select 1 from bets b join futures_selections s on s.id = b.future_id where s.market_id = p_market) then
    raise exception 'People have bet on this. Close or settle it instead.';
  end if;
  delete from futures_selections where market_id = p_market;
  delete from futures_markets where id = p_market;
end $function$;
