-- Migration 079:
-- 1. Bets no longer recalculate futures suggestions. Suggestions are worked
--    out when a super admin presses "Refresh suggestions", and by the weekly
--    model run.
-- 2. Futures bets can be cancelled free for 12 hours (was 24), then cashed out.
-- 3. Each selection remembers its previous price and when it changed, so the
--    Futures page can show a green or red arrow for prices that moved.

drop trigger if exists bets_futures_propose on public.bets;
drop function if exists public.futures_bet_propose();

create or replace function public.future_free_cancel_hours()
returns integer language sql immutable as $$ select 12 $$;

alter table public.futures_selections add column if not exists prev_price text;
alter table public.futures_selections add column if not exists price_moved_at timestamptz;

create or replace function public.futures_track_move()
returns trigger language plpgsql as $$
begin
  if new.price is distinct from old.price and old.price is not null and new.price is not null then
    new.prev_price := old.price;
    new.price_moved_at := now();
  end if;
  return new;
end $$;
drop trigger if exists futures_selections_track_move on public.futures_selections;
create trigger futures_selections_track_move before update of price on public.futures_selections
  for each row execute function public.futures_track_move();

-- The board shows the last move for a week after it happens.
create or replace function public.futures_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places, 'kind', m.kind,
           'status', m.status, 'closes_at', m.closes_at,
           'open', m.status = 'open' and (m.closes_at is null or m.closes_at > now()),
           'selections', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'player_id', s.player_id, 'name', s.name,
                                                 'price', s.price, 'result', s.result,
                                                 'was', case when s.price_moved_at > now() - interval '7 days' then s.prev_price end)
                              order by s.result = 'won' desc nulls last, frac_decimal(s.price) nulls last, s.name)
               from futures_selections s
              where s.market_id = m.id and (s.price is not null or s.result is not null)), '[]'::jsonb))
         order by m.kind = 'special', m.sort, m.id), '[]'::jsonb)
    from futures_markets m
   where m.status <> 'draft';
$$;
