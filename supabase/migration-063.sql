-- Fantasy: scoring values in a table (edited on the super admin page), and
-- the Tricky Player role becomes the Europa Specialist.
--
-- Only PCs and majors score, except for whoever is in the Europa Specialist
-- spot: they also score, at the same values, for Europa matches that week.

create table if not exists public.fantasy_scoring (
  key text primary key,
  label text not null,
  points integer not null check (points between -50 and 100),
  sort integer not null default 0
);
alter table public.fantasy_scoring enable row level security;
drop policy if exists "fantasy scoring readable" on public.fantasy_scoring;
create policy "fantasy scoring readable" on public.fantasy_scoring for select using (true);
grant select on public.fantasy_scoring to anon, authenticated;

insert into public.fantasy_scoring (key, label, points, sort) values
  ('win',   'Match won',                 2,  1),
  ('leg',   'Leg won',                   1,  2),
  ('t140',  '140+',                      1,  3),
  ('t180',  '180',                       3,  4),
  ('out100','100+ checkout',             5,  5),
  ('title', 'Winning the event',        10,  6),
  ('avg50', '50+ match average',         1,  7),
  ('avg60', '60+ match average',         2,  8),
  ('avg70', '70+ match average',         4,  9),
  ('avg80', '80+ match average',         6, 10),
  ('d21',   'Leg won in 19 to 21 darts', 2, 11),
  ('d18',   'Leg won in 16 to 18 darts', 4, 12),
  ('d15',   'Leg won in 15 darts or fewer', 8, 13)
on conflict (key) do nothing;

create or replace function public.fantasy_pts(p_key text) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select points from fantasy_scoring where key = p_key), 0);
$$;

-- Europa events in a gameweek (not PCs or majors).
create or replace function public.fantasy_europa_events(p_gw date)
returns setof public.tournaments language sql stable security definer set search_path = public as $$
  select t.* from tournaments t
   where t.deleted_at is null and not t.is_friendly and t.kind is null and not t.is_pc and not t.is_major
     and t.name ilike 'europa%' and t.status <> 'cancelled' and fantasy_gw_of(t.starts_at) = p_gw;
$$;

drop function if exists public.fantasy_player_points(date);
drop function if exists public.fantasy_player_points(date, boolean);
create or replace function public.fantasy_player_points(p_gw date, p_europa boolean default false)
returns table(player_id uuid, played boolean, points integer, power integer, finish integer, dark integer, detail jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (
    select id, champion_id, status from fantasy_events(p_gw) where not p_europa
    union all
    select id, champion_id, status from fantasy_europa_events(p_gw) where p_europa),
  ms as (
    select m.*, coalesce(m.player1_id, m.counted_p1_id) as a, coalesce(m.player2_id, m.counted_p2_id) as b
      from matches m join ev on ev.id = m.tournament_id
     where m.status = 'complete' and m.winner_id is not null
       and (m.player1_id is not null or m.counted_p1_id is not null or m.p1_name is not null)
       and (m.player2_id is not null or m.counted_p2_id is not null or m.p2_name is not null)),
  vis as (
    select v.match_id, v.player as s,
           count(*) filter (where v.score = 180 and not v.is_bust) as t180,
           count(*) filter (where v.score between 140 and 179 and not v.is_bust) as t140,
           count(*) filter (where v.remaining = 0 and v.score >= 100 and not v.is_bust) as bigout,
           case when sum(v.darts) > 0 then sum(v.score)::numeric / sum(v.darts) * 3 end as avg
      from visits v where v.match_id in (select id from ms)
     group by v.match_id, v.player),
  legdarts as (
    select l.match_id, l.winner as s, sum(v.darts) as darts
      from legs l join ms on ms.id = l.match_id and ms.start_score = 501
      join visits v on v.leg_id = l.id and v.player = l.winner
     where l.winner is not null and not l.bull_off
     group by l.id, l.match_id, l.winner),
  quick as (
    select match_id, s,
           count(*) filter (where darts between 19 and 21) as d21,
           count(*) filter (where darts between 16 and 18) as d18,
           count(*) filter (where darts <= 15) as d15
      from legdarts group by match_id, s),
  side as (
    select ms.id as match_id, 1 as s, ms.a as pid, ms.p1_legs as legs, ms.winner_id = ms.a as won, o.p1_win as chance
      from ms left join match_odds o on o.match_id = ms.id where ms.a is not null
    union all
    select ms.id, 2, ms.b, ms.p2_legs, ms.winner_id = ms.b, 1 - o.p1_win
      from ms left join match_odds o on o.match_id = ms.id where ms.b is not null),
  per as (
    select x.pid, x.won, coalesce(x.legs, 0) as legs,
           coalesce(v.t180, 0) as t180, coalesce(v.t140, 0) as t140, coalesce(v.bigout, 0) as bigout, v.avg,
           coalesce(q.d21, 0) as d21, coalesce(q.d18, 0) as d18, coalesce(q.d15, 0) as d15,
           x.won and x.chance < 0.5 as upset
      from side x
      left join vis v on v.match_id = x.match_id and v.s = x.s
      left join quick q on q.match_id = x.match_id and q.s = x.s),
  agg as (
    select pid,
           count(*) filter (where won) as wins, sum(legs) as legs, sum(t180) as t180, sum(t140) as t140, sum(bigout) as bigout,
           count(*) filter (where avg >= 80) as avg80,
           count(*) filter (where avg >= 70 and avg < 80) as avg70,
           count(*) filter (where avg >= 60 and avg < 70) as avg60,
           count(*) filter (where avg >= 50 and avg < 60) as avg50,
           sum(d21) as d21, sum(d18) as d18, sum(d15) as d15,
           count(*) filter (where upset) as upsets,
           (select count(*) from ev where ev.champion_id = per.pid and ev.status = 'complete') as titles
      from per group by pid),
  val as (select fantasy_pts('win') win, fantasy_pts('leg') leg, fantasy_pts('t140') t140, fantasy_pts('t180') t180,
               fantasy_pts('out100') out100, fantasy_pts('title') title, fantasy_pts('avg50') avg50, fantasy_pts('avg60') avg60,
               fantasy_pts('avg70') avg70, fantasy_pts('avg80') avg80, fantasy_pts('d21') d21, fantasy_pts('d18') d18, fantasy_pts('d15') d15)
  select a.pid, true,
         (val.win * a.wins + val.leg * a.legs + val.t140 * a.t140 + val.t180 * a.t180 + val.out100 * a.bigout + val.title * a.titles
          + val.avg50 * a.avg50 + val.avg60 * a.avg60 + val.avg70 * a.avg70 + val.avg80 * a.avg80
          + val.d21 * a.d21 + val.d18 * a.d18 + val.d15 * a.d15)::int,
         (val.t140 * a.t140 + val.t180 * a.t180)::int, (val.out100 * a.bigout)::int, (val.win * a.upsets)::int,
         jsonb_build_object('wins', a.wins, 'legs', a.legs, '140+', a.t140, '180s', a.t180, '100+ outs', a.bigout,
                            '50+ avg', a.avg50, '60+ avg', a.avg60, '70+ avg', a.avg70, '80+ avg', a.avg80,
                            '19-21 darters', a.d21, '16-18 darters', a.d18, '15 or under', a.d15,
                            'upset wins', a.upsets, 'titles', a.titles)
    from agg a cross join val;
$$;

create or replace function public.fantasy_role(p_slot integer) returns text
language sql immutable as $$
  select (array['Captain', 'Power Scorer', 'Big Finisher', 'Dark Horse', 'Europa Specialist', 'Bench'])[p_slot];
$$;

drop function if exists public.fantasy_role_points(integer, integer, integer, integer, integer, integer);
-- p_europa is what the player scored in Europa matches; only the Europa
-- Specialist gets it.
create or replace function public.fantasy_role_points(p_slot integer, p_points integer, p_power integer, p_finish integer, p_dark integer, p_europa integer)
returns integer language sql immutable as $$
  select coalesce(p_points, 0) + case p_slot
    when 1 then coalesce(p_points, 0)
    when 2 then 2 * coalesce(p_power, 0)
    when 3 then 2 * coalesce(p_finish, 0)
    when 4 then 2 * coalesce(p_dark, 0)
    when 5 then coalesce(p_europa, 0)
    else 0 end;
$$;

create or replace function public.fantasy_team_points(p_user uuid, p_gw date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  sq jsonb := '[]'::jsonb; total integer := 0; r record; pts integer; hits integer;
  b record; empty_slot integer; sub_pts integer := 0; sub_on boolean := false;
begin
  for r in
    select s.slot, s.player_id, p.name, p.slug,
           coalesce(pp.played, false) as played, coalesce(eu.played, false) as eu_played,
           pp.points, pp.power, pp.finish, pp.dark, pp.detail, eu.points as eu_points, eu.detail as eu_detail
      from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
      left join fantasy_player_points(p_gw) pp on pp.player_id = s.player_id
      left join fantasy_player_points(p_gw, true) eu on eu.player_id = s.player_id
     where s.slot <= 5 order by s.slot
  loop
    pts := case when r.played or (r.slot = 5 and r.eu_played)
                then fantasy_role_points(r.slot, r.points, r.power, r.finish, r.dark, r.eu_points) else 0 end;
    if not (r.played or (r.slot = 5 and r.eu_played)) and empty_slot is null then empty_slot := r.slot; end if;
    sq := sq || jsonb_build_object('slot', r.slot, 'role', fantasy_role(r.slot), 'player_id', r.player_id, 'name', r.name,
                                   'slug', r.slug, 'played', r.played or (r.slot = 5 and r.eu_played),
                                   'base', coalesce(r.points, 0), 'points', pts, 'detail', r.detail,
                                   'europa', case when r.slot = 5 then coalesce(r.eu_points, 0) end,
                                   'europa_detail', case when r.slot = 5 then r.eu_detail end);
    total := total + pts;
  end loop;

  select s.player_id, p.name, p.slug, coalesce(pp.played, false) as played, coalesce(eu.played, false) as eu_played,
         pp.points, pp.power, pp.finish, pp.dark, eu.points as eu_points
    into b
    from fantasy_squad(p_user, p_gw) s join players p on p.id = s.player_id
    left join fantasy_player_points(p_gw) pp on pp.player_id = s.player_id
    left join fantasy_player_points(p_gw, true) eu on eu.player_id = s.player_id
   where s.slot = 6;
  -- The bench player takes the role of the first starter who didn't play.
  if b.player_id is not null and empty_slot is not null and (b.played or (empty_slot = 5 and b.eu_played)) then
    sub_pts := fantasy_role_points(empty_slot, b.points, b.power, b.finish, b.dark, b.eu_points);
    sub_on := true;
    total := total + sub_pts;
  end if;

  hits := greatest(0, fantasy_changes(p_user, p_gw) - 1) * fantasy_hit();
  return jsonb_build_object('gw', p_gw, 'starters', sq,
           'bench_player_id', b.player_id, 'bench_name', b.name, 'bench_slug', b.slug,
           'bench_points', case when sub_on then sub_pts else coalesce(b.points, 0) end,
           'bench_came_on', sub_on, 'bench_role', case when sub_on then fantasy_role(empty_slot) end,
           'hits', hits, 'total', total - hits);
end $$;

-- The points table for the page's scoring window.
create or replace function public.fantasy_scoring_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'label', label, 'points', points) order by sort), '[]'::jsonb)
    from fantasy_scoring;
$$;

-- { "<key>": points, ... }
create or replace function public.super_fantasy_set_scoring(p_points jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare k text; v integer; n integer := 0;
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  for k, v in select key, (value #>> '{}')::integer from jsonb_each(p_points) loop
    update fantasy_scoring set points = v where key = k and points is distinct from v;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;
