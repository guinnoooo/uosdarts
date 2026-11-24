-- Futures prices that move with form, from the baselines you publish.
--
-- Every selection keeps the model's chance for it (model_p, refreshed each
-- week by tools/futures-model.mjs), plus a baseline: the last price you set
-- by hand and the model's chance at that moment. Each week an open market's
-- prices are moved from the baseline by however much the model's view of
-- that player has changed since. Your hand-set gaps between players are kept;
-- only the change in form moves them. Typing a new price resets the baseline.

alter table public.futures_selections
  add column if not exists model_p numeric,
  add column if not exists base_price text,
  add column if not exists base_model numeric;

-- Mikey and Lewis are off the qualifier market; Garratt in ahead of English.
delete from public.futures_selections fs using public.futures_markets m, public.players p
 where m.id = fs.market_id and p.id = fs.player_id and m.slug = 'dartsity-qualifiers'
   and p.name in ('Mikey Guinness', 'Lewis Forrest')
   and not exists (select 1 from public.bets b where b.future_id = fs.id);
update public.futures_selections fs set suggested = case m.slug when 'dartsity-stage' then '8/1' else '10/1' end
  from public.futures_markets m, public.players p
 where m.id = fs.market_id and p.id = fs.player_id and p.name = 'Aidan Garratt'
   and m.slug in ('dartsity-stage', 'dartsity-qualifiers');

-- The price ladder, shortest first.
create or replace function public.price_ladder() returns text[]
language sql immutable as $$
  select array['1/10','1/8','1/6','1/5','1/4','2/7','1/3','2/5','4/9','1/2','4/7','4/6','4/5','10/11','Evens',
    '6/5','5/4','6/4','7/4','2/1','9/4','5/2','11/4','3/1','7/2','4/1','9/2','5/1','11/2','6/1','13/2','7/1',
    '8/1','9/1','10/1','12/1','14/1','16/1','20/1','25/1','33/1','40/1','50/1','66/1','80/1','100/1','150/1',
    '250/1','500/1'];
$$;

-- The longest ladder price whose implied chance is still at least p.
create or replace function public.ladder_price(p numeric) returns text
language sql immutable as $$
  select coalesce((select f from unnest(price_ladder()) f
                    where 1 / frac_decimal(f) >= p - 0.000001 order by frac_decimal(f) desc limit 1), '1/10');
$$;

-- p_probs: { "<market slug>": { "<player id>": chance, ... }, ... } from
-- tools/futures-model.mjs. Returns the prices it moved.
create or replace function public.futures_apply_model(p_probs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  pnew numeric; pb numeric; pm numeric; p0 numeric; fresh text;
  moved jsonb := '[]'::jsonb;
  lo constant numeric := 0.002; hi constant numeric := 0.995;
  damp constant numeric := 0.5;   -- move half as far as the model does, so one odd week doesn't swing a price
begin
  for r in
    select s.*, m.slug, m.status as mstatus, (x.value)::numeric as prob
      from jsonb_each(p_probs) mk
      join futures_markets m on m.slug = mk.key
      cross join lateral jsonb_each(mk.value) x
      join futures_selections s on s.market_id = m.id and s.player_id = x.key::uuid
  loop
    -- A selection added by hand starts tracking from its first model reading.
    if r.base_price is not null and r.base_model is null then
      update futures_selections set base_model = r.prob where id = r.id;
      r.base_model := r.prob;
    end if;
    update futures_selections set model_p = r.prob where id = r.id;
    continue when r.mstatus <> 'open' or r.result is not null or r.price is null or r.base_price is null;

    -- Shift the baseline's chance by (half) the change in the model, in log-odds.
    pb := 1 / frac_decimal(r.base_price);
    pm := least(hi, greatest(lo, r.prob));
    p0 := least(hi, greatest(lo, r.base_model));
    pnew := 1 / (1 + exp(-(ln(pb / (1 - pb)) + damp * (ln(pm / (1 - pm)) - ln(p0 / (1 - p0))))));
    fresh := ladder_price(pnew);
    -- Not far enough to reach another rung: keep the price as you typed it.
    if fresh = ladder_price(pb) then fresh := r.base_price; end if;
    if fresh is distinct from r.price then
      update futures_selections set price = fresh where id = r.id;
      moved := moved || jsonb_build_object('market', r.slug, 'name', r.name, 'from', r.price, 'to', fresh);
    end if;
  end loop;
  return moved;
end $$;
revoke execute on function public.futures_apply_model(jsonb) from public, anon, authenticated;

-- Everything tools/futures-model.mjs needs, in one small value:
-- players [id, name, prov, career [darts, avg, first9, dbl], form [wdarts, avg,
-- first9, dbl], played, won, rating, rd, sd] and the order of merit [name, rank, points].
create or replace function public.futures_model_data()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ids uuid[];
begin
  select array_agg(distinct pid) into ids from (
    select unnest(array[m.player1_id, m.player2_id]) pid
      from matches m join tournaments t on t.id = m.tournament_id and t.deleted_at is null
     where m.status = 'complete' and coalesce(m.finished_at, m.updated_at) > now() - interval '120 days'
    union select player_id from external_events
    union select player_id from player_seeds
    union select player_id from futures_selections) u where pid is not null;
  return jsonb_build_object(
    'players', (
      select jsonb_agg(jsonb_build_array(p.id, p.name, p.provisional_avg,
               case when a.player_id is not null then jsonb_build_array(a.darts, a.avg, a.first9, replace(a.dbl_pct, '%', '')) end,
               case when f.player_id is not null then jsonb_build_array(f.wdarts, f.avg, f.first9, replace(f.dbl_pct, '%', '')) end,
               coalesce(r.played, 0) + ext_played(p.id), coalesce(r.won, 0) + ext_won(p.id), g.rating, g.rd, sd.sd))
        from players p
        left join player_averages_for(ids) a on a.player_id = p.id
        left join player_form_for(ids) f on f.player_id = p.id
        left join glicko_at(now()) g on g.player_id = p.id
        left join player_sd_at(ids, now()) sd on sd.player_id = p.id
        left join lateral (
          select count(*) as played, count(*) filter (where x.winner_id = p.id) as won
            from matches x join tournaments t on t.id = x.tournament_id and t.deleted_at is null
           where x.status = 'complete' and p.id in (x.player1_id, x.player2_id)
             and x.player1_id is not null and x.player2_id is not null) r on true
       where p.id = any (ids)),
    'oom', (select jsonb_agg(jsonb_build_array(o.player_name, o.rank, o.total_points)) from oom_table(p_pc_only => false) o));
end $$;
revoke execute on function public.futures_model_data() from public, anon, authenticated;

-- Typing a price makes it the new baseline.
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
    update futures_selections set price = v, base_price = v, base_model = model_p
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
           'id', m.id, 'slug', m.slug, 'title', m.title, 'rules', m.rules, 'places', m.places,
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
         order by m.sort, m.id) from futures_markets m), '[]'::jsonb);
end $$;
