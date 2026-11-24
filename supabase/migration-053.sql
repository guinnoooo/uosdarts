-- Migration 053: admins can see every registered account.
-- Confirmed accounts, plus sign-ups still waiting on their confirmation
-- email, so admins can tell when an email hasn't arrived. Read only:
-- blocking and tokens stay on the super admin page.

create or replace function public.admin_list_accounts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return coalesce((
    select jsonb_agg(x order by x.confirmed desc, x.created_at desc) from (
      select a.display_name, a.email, true as confirmed, a.created_at, a.tokens, a.banned,
             not a.can_bet as is_admin,
             (select count(*) from bets b where b.user_id = a.user_id and b.status not in ('void', 'cancelled')) as bets,
             (select count(*) from match_chat c where c.user_id = a.user_id) as messages
        from accounts a
      union all
      select nullif(btrim(u.raw_user_meta_data->>'display_name'), ''), u.email, false, u.created_at, null, false, false, 0, 0
        from auth.users u
       where not coalesce(u.is_anonymous, false) and u.email is not null and u.email_confirmed_at is null
         and not exists (select 1 from accounts a where a.user_id = u.id)
    ) x), '[]'::jsonb);
end $$;
revoke execute on function public.admin_list_accounts() from public, anon;
grant execute on function public.admin_list_accounts() to authenticated;
