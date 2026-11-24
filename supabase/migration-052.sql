-- Migration 052: admins can chat but not bet.
--
-- Admin logins (username@uosdarts.com) now get an account too, named after
-- their username, so they can chat. It's marked can_bet = false: no bets,
-- and it's left off the leaderboard.

alter table public.accounts add column if not exists can_bet boolean not null default true;

create or replace function public.make_account() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  admin_login boolean;
  base text;
  nm text;
  i int := 1;
begin
  if coalesce(new.is_anonymous, false) or new.email_confirmed_at is null or new.email is null then return new; end if;
  admin_login := lower(new.email) like '%@uosdarts.com';
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
  insert into accounts (user_id, display_name, email, can_bet, tokens)
  values (new.id, nm, new.email, not admin_login, case when admin_login then 0 else 10000 end);
  return new;
end $$;

-- The admin logins that already exist.
insert into public.accounts (user_id, display_name, email, can_bet, tokens)
select u.id, left(split_part(u.email, '@', 1), 30), u.email, false, 0
  from auth.users u
 where lower(u.email) like '%@uosdarts.com' and not coalesce(u.is_anonymous, false)
   and not exists (select 1 from public.accounts a where a.user_id = u.id)
   and not exists (select 1 from public.accounts a where lower(a.display_name) = lower(left(split_part(u.email, '@', 1), 30)));

-- No top-ups for accounts that can't bet.
create or replace function public.apply_topups(p_user uuid default null) returns void
language sql security definer set search_path = public as $$
  update accounts
     set tokens = tokens + 500 * round(extract(epoch from (g - last_grant)) / 604800)::int,
         last_grant = g
    from (select week_grant_time() as g) w
   where (p_user is null or user_id = p_user) and can_bet and g > last_grant + interval '6 days';
$$;

create or replace function public.my_account() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a accounts;
begin
  if auth.uid() is null then return null; end if;
  perform apply_topups(auth.uid());
  select * into a from accounts where user_id = auth.uid();
  if not found then return null; end if;
  return jsonb_build_object(
    'display_name', a.display_name, 'email', a.email, 'tokens', a.tokens, 'banned', a.banned, 'can_bet', a.can_bet,
    'in_play', (select coalesce(sum(stake), 0) from bets where user_id = a.user_id and status = 'open'),
    'next_topup', week_grant_time() + interval '7 days');
end $$;

-- place_bet_internal: refuse accounts that can't bet.
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.place_bet_internal(uuid, uuid, uuid, smallint, uuid, text, text, text, numeric, integer, integer)'::regprocedure), E'\r', '');
  if position('can_bet' in def) = 0 then
    def := replace(def, $r$  if a.banned then raise exception 'Your account can''t place bets'; end if;$r$,
      $r$  if a.banned then raise exception 'Your account can''t place bets'; end if;
  if not a.can_bet then raise exception 'Admin logins can''t bet. Sign up with your email to bet.'; end if;$r$);
    if position('can_bet' in def) = 0 then raise exception 'place_bet_internal has changed shape'; end if;
    execute def;
  end if;
end $$;

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
                       from bets where status not in ('void', 'cancelled') group by user_id) s on s.user_id = a.user_id
         where not a.banned and a.can_bet
      ) x), '[]'::jsonb);
end $$;

-- Anyone in the admins table counts as an admin login here, whatever their
-- email: they get an account to chat with, and can't bet.
create or replace function public.admin_account_follow() returns trigger
language plpgsql security definer set search_path = public as $$
declare u auth.users;
begin
  if tg_op = 'DELETE' then
    update accounts set can_bet = true
     where user_id = old.user_id and coalesce(lower(email), '') not like '%@uosdarts.com';
    return old;
  end if;
  update accounts set can_bet = false where user_id = new.user_id;
  if not found then
    select * into u from auth.users where id = new.user_id;
    if u.id is not null and u.email is not null then
      insert into accounts (user_id, display_name, email, can_bet, tokens)
      select u.id, nm, u.email, false, 0
        from (select case when exists (select 1 from accounts where lower(display_name) = lower(b))
                          then left(b, 26) || ' ' || floor(random() * 900 + 100)::int else b end as nm
                from (select left(coalesce(nullif(btrim(u.raw_user_meta_data->>'display_name'), ''), split_part(u.email, '@', 1)), 30) as b) s) x
      on conflict (user_id) do nothing;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists admins_account on public.admins;
create trigger admins_account after insert or delete on public.admins
  for each row execute function public.admin_account_follow();

-- Admins who already exist.
insert into public.accounts (user_id, display_name, email, can_bet, tokens)
select u.id, case when u.email = 'mmg.guinness@gmail.com' then 'Mikey Guinness' else left(split_part(u.email, '@', 1), 30) end,
       u.email, false, 0
  from public.admins ad join auth.users u on u.id = ad.user_id
 where not exists (select 1 from public.accounts a where a.user_id = u.id)
on conflict do nothing;
update public.accounts set can_bet = false where user_id in (select user_id from public.admins);
