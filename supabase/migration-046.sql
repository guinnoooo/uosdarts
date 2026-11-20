-- Migration 046: starting ratings, and results that count by format and margin.
--
-- 1. player_seeds: a starting rating (and how sure we are of it) per player,
--    set by a super admin from what they know of people's level. Only super
--    admins can read or change it. A seed counts for ratings from the moment
--    it's set, so the odds rebuilt for past matches aren't helped by hindsight.
-- 2. glicko_at now:
--    - starts seeded players from their seed instead of 1500,
--    - counts a longer match as more evidence than a short one (first to 3
--      counts as one full result, first to 1 as 0.58, first to 6 as 1.41,
--      at most 1.5),
--    - scores a result by margin as well: a whitewash counts as a full win,
--      3-2 as 0.83 of one (the loser gets the rest),
--    - leaves friendlies out, as win rates do.

create table if not exists public.player_seeds (
  player_id uuid primary key references public.players(id) on delete cascade,
  rating numeric not null check (rating between 1000 and 2500),
  rd numeric not null default 175 check (rd between 30 and 350),
  seeded_at timestamptz not null default now()
);
alter table public.player_seeds enable row level security;
drop policy if exists "seeds super only" on public.player_seeds;
create policy "seeds super only" on public.player_seeds for select using ((select is_super()));

create or replace function public.super_set_seed(p_player uuid, p_rating numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if p_rating is null then
    delete from player_seeds where player_id = p_player;
  else
    insert into player_seeds (player_id, rating) values (p_player, p_rating)
    on conflict (player_id) do update set rating = excluded.rating, seeded_at = now();
  end if;
end $$;
revoke execute on function public.super_set_seed(uuid, numeric) from public, anon;
grant execute on function public.super_set_seed(uuid, numeric) to authenticated;

create or replace function public.glicko_at(p_at timestamptz)
returns table(player_id uuid, rating numeric, rd numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  q constant numeric := ln(10) / 400;
  c2 constant numeric := 328;          -- rd grows by this (squared) per day without a match
  st jsonb := '{}'::jsonb;
  x record;
  ra numeric; rda numeric; rb numeric; rdb numeric;
  ta numeric; tb numeric; tnow numeric;
  ga numeric; gb numeric; ea numeric; eb numeric; sa numeric; sw numeric; w numeric;
  da numeric; db numeric;
begin
  -- Seeded players start where they were put, if the seed was set by then.
  select coalesce(jsonb_object_agg(s.player_id::text,
           jsonb_build_array(s.rating, s.rd, extract(epoch from s.seeded_at))), '{}'::jsonb)
    into st from player_seeds s where s.seeded_at <= p_at;

  for x in
    select m.player1_id a, m.player2_id b, (m.winner_id = m.player1_id) as a_won,
           extract(epoch from coalesce(m.finished_at, m.updated_at)) as ts,
           case when m.sets_to_win is not null then m.sets_to_win * coalesce(m.legs_to_win, 1) else coalesce(m.legs_to_win, 1) end as target,
           case when m.sets_to_win is not null then greatest(coalesce(m.p1_sets, 0), coalesce(m.p2_sets, 0))
                else greatest(coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0)) end as won_units,
           case when m.sets_to_win is not null then least(coalesce(m.p1_sets, 0), coalesce(m.p2_sets, 0))
                else least(coalesce(m.p1_legs, 0), coalesce(m.p2_legs, 0)) end as lost_units
      from matches m join tournaments t on t.id = m.tournament_id and t.deleted_at is null and not t.is_friendly
     where m.status = 'complete' and m.player1_id is not null and m.player2_id is not null and m.winner_id is not null
       and coalesce(m.finished_at, m.updated_at) < p_at
     order by coalesce(m.finished_at, m.updated_at)
  loop
    tnow := x.ts;
    ra := coalesce((st->x.a::text->>0)::numeric, 1500); rda := coalesce((st->x.a::text->>1)::numeric, 350);
    ta := coalesce((st->x.a::text->>2)::numeric, tnow);
    rb := coalesce((st->x.b::text->>0)::numeric, 1500); rdb := coalesce((st->x.b::text->>1)::numeric, 350);
    tb := coalesce((st->x.b::text->>2)::numeric, tnow);
    rda := least(350, sqrt(rda * rda + c2 * greatest(0, tnow - ta) / 86400));
    rdb := least(350, sqrt(rdb * rdb + c2 * greatest(0, tnow - tb) / 86400));

    w := least(1.5, sqrt(x.target / 3.0));
    sw := 1 - 0.25 * x.lost_units / greatest(x.won_units, 1);
    sa := case when x.a_won then sw else 1 - sw end;

    ga := 1 / sqrt(1 + 3 * q * q * rdb * rdb / (pi() * pi()));
    gb := 1 / sqrt(1 + 3 * q * q * rda * rda / (pi() * pi()));
    ea := 1 / (1 + power(10, -ga * (ra - rb) / 400));
    eb := 1 / (1 + power(10, -gb * (rb - ra) / 400));
    da := 1 / (rda * rda) + w * q * q * ga * ga * ea * (1 - ea);
    db := 1 / (rdb * rdb) + w * q * q * gb * gb * eb * (1 - eb);
    st := st || jsonb_build_object(
      x.a::text, jsonb_build_array(ra + q / da * w * ga * (sa - ea), greatest(30, sqrt(1 / da)), tnow),
      x.b::text, jsonb_build_array(rb + q / db * w * gb * ((1 - sa) - eb), greatest(30, sqrt(1 / db)), tnow));
  end loop;
  tnow := extract(epoch from p_at);
  return query
    select k::uuid, round((v->>0)::numeric, 1),
           round(least(350, sqrt(power((v->>1)::numeric, 2) + c2 * greatest(0, tnow - (v->>2)::numeric) / 86400)), 1)
      from jsonb_each(st) as e(k, v);
end $$;
revoke execute on function public.glicko_at(timestamptz) from public, anon, authenticated;

-- Ratings in the saved snapshots, worked out again the new way. Every
-- snapshot so far predates the seeds, so none of them use one.
update public.model_snapshots s
   set features = s.features || coalesce(public.player_extra_json(m.player1_id, m.player2_id, s.taken_at), '{}'::jsonb)
  from public.matches m
 where m.id = s.match_id;
