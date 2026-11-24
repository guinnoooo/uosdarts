-- Migration 054: faster ratings, and closing a couple of loopholes in betting.
--
-- 1. glicko_at took over a second (numeric maths and copying a growing jsonb
--    object each match). It runs on every match preview, every names
--    preview, the tournament odds and every bet. Rewritten with float8 and
--    arrays: same results to the decimal place, about 7ms.
-- 2. You can't bet on a match you're scoring, and you can't take over
--    scoring a match you've bet on.
-- 3. Payouts are bigint, so a huge stake at a long price can't overflow.

create or replace function public.glicko_at(p_at timestamptz)
returns table(player_id uuid, rating numeric, rd numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  q constant float8 := ln(10::float8) / 400;
  q2pi constant float8 := 3 * (ln(10::float8) / 400) ^ 2 / (pi() * pi());
  c2 constant float8 := 328;
  ids uuid[] := '{}';
  rs float8[] := '{}';
  rds float8[] := '{}';
  ts float8[] := '{}';
  ix int; ib int;
  x record;
  ra float8; rda float8; rb float8; rdb float8; tnow float8;
  ga float8; gb float8; ea float8; eb float8; sa float8; sw float8; w float8; da float8; db float8;
begin
  -- Ratings are kept in parallel arrays (float8 arithmetic, no jsonb copying), which is
  -- far faster than the first version.
  select coalesce(array_agg(s.player_id), '{}'), coalesce(array_agg(s.rating::float8), '{}'),
         coalesce(array_agg(s.rd::float8), '{}'), coalesce(array_agg(extract(epoch from s.seeded_at)::float8), '{}')
    into ids, rs, rds, ts
    from player_seeds s where s.seeded_at <= p_at;

  for x in
    select m.player1_id a, m.player2_id b, (m.winner_id = m.player1_id) as a_won,
           extract(epoch from coalesce(m.finished_at, m.updated_at))::float8 as at,
           (case when m.sets_to_win is not null then m.sets_to_win * coalesce(m.legs_to_win, 1) else coalesce(m.legs_to_win, 1) end)::float8 as target,
           (case when m.sets_to_win is not null then greatest(coalesce(m.p1_sets, 0), coalesce(m.p2_sets, 0))
                 else greatest(coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0)) end)::float8 as won_units,
           (case when m.sets_to_win is not null then least(coalesce(m.p1_sets, 0), coalesce(m.p2_sets, 0))
                 else least(coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0)) end)::float8 as lost_units
      from matches m join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
     where m.status = 'complete' and m.player1_id is not null and m.player2_id is not null and m.winner_id is not null
       and coalesce(m.finished_at, m.updated_at) < p_at
     order by coalesce(m.finished_at, m.updated_at)
  loop
    tnow := x.at;
    ix := array_position(ids, x.a);
    if ix is null then ids := ids || x.a; rs := rs || 1500::float8; rds := rds || 350::float8; ts := ts || tnow; ix := cardinality(ids); end if;
    ib := array_position(ids, x.b);
    if ib is null then ids := ids || x.b; rs := rs || 1500::float8; rds := rds || 350::float8; ts := ts || tnow; ib := cardinality(ids); end if;
    ra := rs[ix]; rb := rs[ib];
    rda := least(350, sqrt(rds[ix] ^ 2 + c2 * greatest(0, tnow - ts[ix]) / 86400));
    rdb := least(350, sqrt(rds[ib] ^ 2 + c2 * greatest(0, tnow - ts[ib]) / 86400));

    w := least(1.5, sqrt(x.target / 3.0));
    sw := 1 - 0.25 * x.lost_units / greatest(x.won_units, 1);
    sa := case when x.a_won then sw else 1 - sw end;

    ga := 1 / sqrt(1 + q2pi * rdb * rdb);
    gb := 1 / sqrt(1 + q2pi * rda * rda);
    ea := 1 / (1 + 10 ^ (-ga * (ra - rb) / 400));
    eb := 1 / (1 + 10 ^ (-gb * (rb - ra) / 400));
    da := 1 / (rda * rda) + w * q * q * ga * ga * ea * (1 - ea);
    db := 1 / (rdb * rdb) + w * q * q * gb * gb * eb * (1 - eb);
    rs[ix] := ra + q / da * w * ga * (sa - ea);
    rs[ib] := rb + q / db * w * gb * ((1 - sa) - eb);
    rds[ix] := greatest(30, sqrt(1 / da));
    rds[ib] := greatest(30, sqrt(1 / db));
    ts[ix] := tnow; ts[ib] := tnow;
  end loop;
  tnow := extract(epoch from p_at);
  return query
    select ids[i], round(rs[i]::numeric, 1),
           round(least(350, sqrt(rds[i] ^ 2 + c2 * greatest(0, tnow - ts[i]) / 86400))::numeric, 1)
      from generate_subscripts(ids, 1) i;
end $$;

alter table public.bets alter column payout type bigint;

do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.place_bet_internal(uuid, uuid, uuid, smallint, uuid, text, text, text, numeric, integer, integer)'::regprocedure), E'\r', '');
  if position('a match you' in def) = 0 then
    def := replace(def, $r$    if p_side not in (1, 2) then raise exception 'Pick a side'; end if;$r$,
      $r$    if p_side not in (1, 2) then raise exception 'Pick a side'; end if;
    if exists (select 1 from matches where id = p_match and p_user in (scorer_id, scorer2_id)) then
      raise exception 'You can''t bet on a match you''re scoring';
    end if;$r$);
    if position('a match you' in def) = 0 then raise exception 'place_bet_internal has changed shape'; end if;
    execute def;
  end if;
end $$;

create or replace function public.no_scoring_own_bets() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.scorer_id is not null and new.scorer_id is distinct from old.scorer_id
        and exists (select 1 from bets where match_id = new.id and user_id = new.scorer_id and status <> 'cancelled'))
  or (new.scorer2_id is not null and new.scorer2_id is distinct from old.scorer2_id
        and exists (select 1 from bets where match_id = new.id and user_id = new.scorer2_id and status <> 'cancelled')) then
    raise exception 'You''ve bet on this match, so someone else needs to score it';
  end if;
  return new;
end $$;
drop trigger if exists matches_no_scoring_own_bets on public.matches;
create trigger matches_no_scoring_own_bets before update of scorer_id, scorer2_id on public.matches
  for each row execute function public.no_scoring_own_bets();

-- Work payouts out as bigint too.
do $$
declare f text; def text;
begin
  foreach f in array array['public.resettle_match(uuid)', 'public.resettle_outright(uuid)', 'public.my_bets(integer)', 'public.my_bets_on(uuid, uuid)'] loop
    def := replace(pg_get_functiondef(f::regprocedure), E'\r', '');
    def := replace(def, 'decimal_odds)::int', 'decimal_odds)::bigint');
    execute def;
  end loop;
end $$;

-- Recent form: the same float8 change (numeric power() per visit was most of
-- its 155ms; now about 30ms, same figures).
do $$
declare def text;
begin
  def := replace(pg_get_functiondef('public.player_form_for(uuid[], integer)'::regprocedure), E'\r', '');
  def := replace(def, 'power(0.5, extract(epoch from (now() - vi.created_at)) / 86400.0 / greatest(p_half_life, 1))',
                      'power(0.5::float8, extract(epoch from (now() - vi.created_at))::float8 / 86400.0 / greatest(p_half_life, 1))');
  def := replace(def, 'sum(power(0.5, extract(epoch from (now() - coalesce(m.finished_at, m.updated_at, now()))) / 86400.0',
                      'sum(power(0.5::float8, extract(epoch from (now() - coalesce(m.finished_at, m.updated_at, now())))::float8 / 86400.0');
  def := replace(def, 'round(a.wd, 1)', 'round(a.wd::numeric, 1)');
  if position('0.5::float8, extract(epoch from (now() - vi' in def) = 0 then raise exception 'player_form_for has changed shape'; end if;
  execute def;
end $$;
