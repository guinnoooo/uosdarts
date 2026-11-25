-- Migration 078: futures prices never move on their own. The model and the
-- betting suggest a new price, and a super admin approves or rejects it.
--
-- A suggestion blends two things:
--   form:  the model's chance against the chance when the price was last set
--          (half the move, as before), and
--   money: how much of the market's open stake is on a selection against how
--          much of the book its price accounts for. Heavy backing shortens a
--          price, little or none lets it drift. The more money in the market,
--          the more it counts. A selection that would cost more than the whole
--          market has taken shortens a little further.

alter table public.futures_selections add column if not exists proposed text;
alter table public.futures_selections add column if not exists proposed_reason text;
alter table public.futures_selections add column if not exists proposed_at timestamptz;
alter table public.futures_selections add column if not exists rejected text;

create or replace function public.futures_propose(p_probs jsonb default '{}'::jsonb, p_market bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  lo constant numeric := 0.002; hi constant numeric := 0.995;
  damp constant numeric := 0.5;
  pcur numeric; pform numeric; pm numeric; p0 numeric; pb numeric; pnew numeric;
  z numeric; shift numeric; w numeric; fresh text; why text[];
  out jsonb := '[]'::jsonb;
begin
  -- Store any new model chances first.
  update futures_selections s
     set model_p = (x.value)::numeric,
         base_model = coalesce(s.base_model, case when s.base_price is not null then (x.value)::numeric end)
    from jsonb_each(coalesce(p_probs, '{}'::jsonb)) mk
    join futures_markets m on m.slug = mk.key
    cross join lateral jsonb_each(mk.value) x
   where s.market_id = m.id and s.player_id = x.key::uuid;

  for r in
    with book as (
      select s.market_id, sum(1 / frac_decimal(s.price)) as overround
        from futures_selections s where s.price is not null and s.result is null group by s.market_id),
    money as (
      select fs.market_id, b.future_id,
             sum(b.stake) as staked, sum(floor(b.stake * b.decimal_odds)) as liability
        from bets b join futures_selections fs on fs.id = b.future_id
       where b.status = 'open' group by fs.market_id, b.future_id),
    market_money as (select market_id, sum(staked) as total from money group by market_id)
    select s.*, m.slug, k.overround, coalesce(mo.staked, 0) as staked, coalesce(mo.liability, 0) as liability,
           coalesce(mm.total, 0) as total
      from futures_selections s
      join futures_markets m on m.id = s.market_id and m.status = 'open'
      join book k on k.market_id = s.market_id
      left join money mo on mo.future_id = s.id
      left join market_money mm on mm.market_id = s.market_id
     where s.price is not null and s.result is null and (p_market is null or s.market_id = p_market)
  loop
    why := '{}';
    pcur := least(hi, greatest(lo, 1 / frac_decimal(r.price)));
    pform := pcur;

    -- Form: the same damped move from the last approved price as before.
    if r.model_p is not null and r.base_model is not null and r.base_price is not null then
      pb := least(hi, greatest(lo, 1 / frac_decimal(r.base_price)));
      pm := least(hi, greatest(lo, r.model_p));
      p0 := least(hi, greatest(lo, r.base_model));
      pform := 1 / (1 + exp(-(ln(pb / (1 - pb)) + damp * (ln(pm / (1 - pm)) - ln(p0 / (1 - p0))))));
      if ladder_price(pform) <> ladder_price(pcur) then
        why := why || format('model %s%% (was %s%%)', round(r.model_p * 100, 1), round(r.base_model * 100, 1));
      end if;
    end if;

    -- Money: share of the stake against share of the book.
    shift := 0;
    if r.total >= 500 then
      w := least(1, r.total / 5000.0);
      z := ln((r.staked / r.total + 0.01) / (pcur / r.overround + 0.01));
      -- Heavy backing shortens. Light backing only lets a price drift when it
      -- is odds-against, and only a little, so favourites never drift for
      -- want of money.
      shift := case when z > 0 then least(0.5, 0.25 * w * z)
                    when pcur <= 0.5 then greatest(-0.15, 0.25 * w * z) else 0 end;
      if shift >= 0.05 then
        why := why || format('%s%% of the market''s money is on them', round(100 * r.staked / r.total));
      elsif shift <= -0.05 then
        why := why || format('little money on them (%s%% of the stake)', round(100 * r.staked / r.total));
      end if;
      -- A selection that would cost more than the whole market has taken.
      if r.liability > r.total then
        shift := shift + least(0.4, 0.15 * w * ln(r.liability / r.total));
        why := why || format('would pay out %s if they win, against %s taken on the market', r.liability, r.total);
      end if;
    end if;

    pnew := 1 / (1 + exp(-(ln(pform / (1 - pform)) + shift)));
    pnew := least(hi, greatest(lo, pnew));
    fresh := ladder_price(pnew);
    -- Prices shorter than the ladder goes (1/20, 1/100) are left alone unless
    -- the suggestion is longer than the ladder's shortest rung.
    if pcur > 1 / frac_decimal('1/10') and pnew >= 1 / frac_decimal('1/10') then fresh := r.price; end if;

    if fresh = r.price or fresh = r.rejected or array_length(why, 1) is null then
      update futures_selections set proposed = null, proposed_reason = null, proposed_at = null
       where id = r.id and proposed is not null;
    elsif fresh is distinct from r.proposed then
      update futures_selections set proposed = fresh, proposed_reason = array_to_string(why, '; '), proposed_at = now()
       where id = r.id;
      out := out || jsonb_build_object('market', r.slug, 'name', r.name, 'from', r.price, 'to', fresh,
                                       'why', array_to_string(why, '; '));
    end if;
  end loop;
  return out;
end $$;

-- The weekly task still calls this. It now only suggests.
create or replace function public.futures_apply_model(p_probs jsonb)
returns jsonb language sql security definer set search_path = public as $$
  select futures_propose(p_probs, null);
$$;

-- New bets update the suggestions for their market straight away.
create or replace function public.futures_bet_propose()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.future_id is not null then
    perform futures_propose('{}'::jsonb, (select market_id from futures_selections where id = new.future_id));
  end if;
  return null;
end $$;
drop trigger if exists bets_futures_propose on public.bets;
create trigger bets_futures_propose after insert or update of status on public.bets
  for each row when (new.future_id is not null) execute function public.futures_bet_propose();

create or replace function public.super_future_approve(p_selection bigint)
returns text language plpgsql security definer set search_path = public as $$
declare s futures_selections;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  select * into s from futures_selections where id = p_selection for update;
  if s.proposed is null then raise exception 'Nothing to approve'; end if;
  update futures_selections
     set price = s.proposed, base_price = s.proposed, base_model = coalesce(s.model_p, s.base_model),
         proposed = null, proposed_reason = null, proposed_at = null, rejected = null
   where id = p_selection;
  return s.proposed;
end $$;

create or replace function public.super_future_reject(p_selection bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  update futures_selections set rejected = proposed, proposed = null, proposed_reason = null, proposed_at = null
   where id = p_selection and proposed is not null;
end $$;

create or replace function public.super_future_approve_all(p_market bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  update futures_selections
     set price = proposed, base_price = proposed, base_model = coalesce(model_p, base_model),
         proposed = null, proposed_reason = null, proposed_at = null, rejected = null
   where market_id = p_market and proposed is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Recalculate suggestions now, from the stored model chances and the bets.
create or replace function public.super_future_suggest()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  return futures_propose('{}'::jsonb, null);
end $$;

-- Setting a price by hand clears any suggestion and rebases the form move.
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
    update futures_selections set price = v, base_price = v, base_model = model_p,
                                  proposed = null, proposed_reason = null, proposed_at = null, rejected = null
     where id = k::bigint and market_id = p_market and price is distinct from v;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

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
                      'proposed', s.proposed, 'proposed_reason', s.proposed_reason,
                      'bets', coalesce(b.n, 0), 'staked', coalesce(b.staked, 0), 'liability', coalesce(b.liability, 0))
                    order by frac_decimal(coalesce(s.price, s.suggested)) nulls last, s.name)
               from futures_selections s
               left join lateral (select count(*) as n, sum(stake) as staked,
                                         sum(floor(stake * decimal_odds)) filter (where status = 'open') as liability
                                    from bets where future_id = s.id and status <> 'cancelled') b on true
              where s.market_id = m.id), '[]'::jsonb))
         order by m.kind = 'special', m.sort, m.id) from futures_markets m), '[]'::jsonb);
end $$;

revoke all on function public.futures_propose(jsonb, bigint) from public, anon, authenticated;
revoke all on function public.super_future_approve(bigint) from public, anon;
revoke all on function public.super_future_reject(bigint) from public, anon;
revoke all on function public.super_future_approve_all(bigint) from public, anon;
revoke all on function public.super_future_suggest() from public, anon;
grant execute on function public.super_future_approve(bigint) to authenticated;
grant execute on function public.super_future_reject(bigint) to authenticated;
grant execute on function public.super_future_approve_all(bigint) to authenticated;
grant execute on function public.super_future_suggest() to authenticated;
