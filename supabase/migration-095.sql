-- Price arrows: a super admin can switch off the green/red "moved this
-- week" arrow for any selection (say after correcting a typo'd price). It
-- stays off until switched back on.

alter table futures_selections add column if not exists hide_move boolean not null default false;

create or replace function public.super_future_hide_move(p_selection bigint, p_hide boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  update futures_selections set hide_move = coalesce(p_hide, false) where id = p_selection;
  if not found then raise exception 'Selection not found'; end if;
end $function$;
revoke all on function public.super_future_hide_move(bigint, boolean) from public, anon;
grant execute on function public.super_future_hide_move(bigint, boolean) to authenticated;

-- The board leaves out the old price for hidden ones, so no arrow is drawn;
-- the super admin list says which selections have an arrow showing.
do $$ declare d text; begin
  select pg_get_functiondef('public.futures_board()'::regprocedure) into d;
  if position('hide_move' in d) = 0 then
    d := replace(d, $r$'was', case when s.price_moved_at > now() - interval '7 days' then s.prev_price end$r$,
                    $r$'was', case when s.price_moved_at > now() - interval '7 days' and not s.hide_move then s.prev_price end$r$);
    execute d;
  end if;
  select pg_get_functiondef('public.super_futures()'::regprocedure) into d;
  if position('hide_move' in d) = 0 then
    d := replace(d, $r$'pair', s.pair_no,$r$,
                    $r$'pair', s.pair_no, 'hide_move', s.hide_move,
                      'was', case when s.price_moved_at > now() - interval '7 days' then s.prev_price end,$r$);
    execute d;
  end if;
end $$;
