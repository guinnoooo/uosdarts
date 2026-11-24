-- Migration 075: the weekly token top-up drops from 500 to 250.
create or replace function public.apply_topups(p_user uuid default null)
returns void language sql security definer set search_path = public as $$
  update accounts
     set tokens = tokens + 250 * round(extract(epoch from (g - last_grant)) / 604800)::int,
         last_grant = g
    from (select week_grant_time() as g) w
   where (p_user is null or user_id = p_user) and can_bet and g > last_grant + interval '6 days';
$$;
