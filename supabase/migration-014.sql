-- Migration 014: player profiles that live in the database.
--
-- Until now a player's profile (nickname, Student/Alumni, and their 180s,
-- 100+ checkouts and sheet legs from before live scoring) only existed as a
-- yaml file in the repo, so someone added on the night had no profile until
-- a file was written and pushed. Profiles made on the site are stored here
-- instead, and the order of merit page builds a profile from them.
--
-- Players who already have a yaml file are untouched: their columns below
-- stay empty and zero, and the page keeps using the yaml.
--
-- Run this BEFORE merging the matching pull request: the new admin page calls
-- admin_add_player with the extra fields.

alter table public.players
  add column if not exists nickname        text,
  add column if not exists year            text,
  add column if not exists base_180s       int not null default 0,
  add column if not exists base_100_plus   int not null default 0,
  add column if not exists base_sheet_legs int not null default 0;

alter table public.players drop constraint if exists players_base_nonnegative;
alter table public.players add constraint players_base_nonnegative
  check (base_180s >= 0 and base_100_plus >= 0 and base_sheet_legs >= 0);

-- Creating a player now takes the profile at the same time. Every extra field
-- has a default, so a call with just a name behaves exactly as before. The old
-- one-argument version has to go first, or a call naming only p_name would
-- match both and fail as ambiguous.
drop function if exists public.admin_add_player(text);

create or replace function public.admin_add_player(
  p_name            text,
  p_year            text default null,
  p_nickname        text default null,
  p_180s            int  default 0,
  p_100_plus        int  default 0,
  p_sheet_legs      int  default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'Give the player a name'; end if;
  if coalesce(p_180s, 0) < 0 or coalesce(p_100_plus, 0) < 0 or coalesce(p_sheet_legs, 0) < 0 then
    raise exception 'Stats can''t be negative';
  end if;

  -- Same name already on file: hand back that player and change nothing.
  select id into pid from players where lower(name) = lower(btrim(p_name));
  if pid is not null then return pid; end if;

  insert into players (name, year, nickname, base_180s, base_100_plus, base_sheet_legs)
  values (btrim(p_name),
          nullif(btrim(p_year), ''),
          nullif(btrim(p_nickname), ''),
          coalesce(p_180s, 0), coalesce(p_100_plus, 0), coalesce(p_sheet_legs, 0))
  returning id into pid;
  return pid;
end $$;

revoke execute on function public.admin_add_player(text, text, text, int, int, int) from public, anon;
grant  execute on function public.admin_add_player(text, text, text, int, int, int) to authenticated;

-- Editing a profile afterwards, from the super admin page.
create or replace function public.super_set_player_profile(
  p_player     uuid,
  p_year       text,
  p_nickname   text,
  p_180s       int,
  p_100_plus   int,
  p_sheet_legs int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super() then raise exception 'Super admins only'; end if;
  if coalesce(p_180s, 0) < 0 or coalesce(p_100_plus, 0) < 0 or coalesce(p_sheet_legs, 0) < 0 then
    raise exception 'Stats can''t be negative';
  end if;
  update players
     set year            = nullif(btrim(p_year), ''),
         nickname        = nullif(btrim(p_nickname), ''),
         base_180s       = coalesce(p_180s, 0),
         base_100_plus   = coalesce(p_100_plus, 0),
         base_sheet_legs = coalesce(p_sheet_legs, 0)
   where id = p_player;
  if not found then raise exception 'Player not found'; end if;
end $$;

revoke execute on function public.super_set_player_profile(uuid, text, text, int, int, int) from public, anon;
grant  execute on function public.super_set_player_profile(uuid, text, text, int, int, int) to authenticated;

-- Stats now include the starting figures entered with the profile. For yaml
-- players those are zero, so nothing they show changes.
create or replace function public.player_stats(p_season text default '2026/27')
returns table (
  player_slug        text,
  player_name        text,
  hit_180s           int,
  checkouts_100_plus int,
  sheet_legs         int,
  high_checkout      int,
  pc_best            text,
  pc_wins            int,
  major_best         text,
  major_wins         int
)
language sql stable security definer set search_path = public as $$
  with scoring as (
    select
      pv.player_id,
      count(*) filter (where pv.score = 180)::int                        as hit_180s,
      count(*) filter (where pv.remaining = 0 and pv.score >= 100)::int  as checkouts_100_plus,
      coalesce(max(pv.score) filter (where pv.remaining = 0), 0)::int    as high_checkout
    from player_visits pv
    group by pv.player_id
  ),
  -- A sheet leg is one won in 21 darts or fewer.
  leg_darts as (
    select
      case when l.winner = 1 then m.player1_id else m.player2_id end as player_id,
      sum(v.darts) filter (where v.player = l.winner) as darts
    from legs l
    join matches m on m.id = l.match_id
    join visits v on v.leg_id = l.id
    where l.winner is not null
    group by l.id, m.player1_id, m.player2_id, l.winner
  ),
  sheets as (
    select player_id, count(*)::int as sheet_legs
      from leg_darts where darts is not null and darts <= 21
     group by player_id
  ),
  runs as (
    select
      o.player_id,
      min(reached_order(o.reached)) filter (where o.is_pc)    as pc_best_ord,
      count(*) filter (where o.is_pc and o.reached = 'winner')::int    as pc_wins,
      min(reached_order(o.reached)) filter (where o.is_major) as major_best_ord,
      count(*) filter (where o.is_major and o.reached = 'winner')::int as major_wins
    from oom_points o
    where o.season = p_season
    group by o.player_id
  )
  select
    p.slug, p.name,
    coalesce(s.hit_180s, 0)           + p.base_180s,
    coalesce(s.checkouts_100_plus, 0) + p.base_100_plus,
    coalesce(sh.sheet_legs, 0)        + p.base_sheet_legs,
    coalesce(s.high_checkout, 0),
    case when r.pc_best_ord is null then null else reached_label(
      (select k from (values ('winner',0),('final',1),('semi',2),('quarter',3),
                             ('last_16',4),('last_32',5),('last_64',6)) v(k, o)
        where o = r.pc_best_ord)) end,
    coalesce(r.pc_wins, 0),
    case when r.major_best_ord is null then null else reached_label(
      (select k from (values ('winner',0),('final',1),('semi',2),('quarter',3),
                             ('last_16',4),('last_32',5),('last_64',6)) v(k, o)
        where o = r.major_best_ord)) end,
    coalesce(r.major_wins, 0)
  from players p
  left join scoring s on s.player_id = p.id
  left join sheets  sh on sh.player_id = p.id
  left join runs    r on r.player_id = p.id;
$$;
