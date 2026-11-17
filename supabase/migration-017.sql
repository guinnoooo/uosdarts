-- 017: dart limits, bull offs and tournament summaries
--
-- * tournaments.dart_limit: when both players have thrown this many darts in
--   a leg without a winner, the scorer can settle it with a bull off.
-- * legs.bull_off marks legs settled that way. They don't count as a double
--   hit, a best leg or a sheet leg.
-- * tournament_summary() gives per-player figures for the summary page.
--
-- Safe to run more than once.

alter table public.tournaments add column if not exists dart_limit int;
alter table public.tournaments drop constraint if exists tournaments_dart_limit_check;
alter table public.tournaments add constraint tournaments_dart_limit_check
  check (dart_limit is null or dart_limit between 3 and 300);

alter table public.legs add column if not exists bull_off boolean not null default false;

-- ------------------------------------------------------------------ bull off

create or replace function public.bull_off(p_match uuid, p_winner int) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  l legs;
  lim int;
  d1 int;
  d2 int;
begin
  if p_winner is null or p_winner not in (1, 2) then raise exception 'Pick who won the bull'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;
  if m.status <> 'live' then raise exception 'Match is not in progress'; end if;

  select dart_limit into lim from tournaments where id = m.tournament_id;
  if lim is null then raise exception 'This tournament has no dart limit'; end if;

  select * into l from legs where match_id = p_match order by leg_no desc limit 1;
  if l.winner is not null then raise exception 'This leg is already won'; end if;
  select coalesce(sum(darts) filter (where player = 1), 0), coalesce(sum(darts) filter (where player = 2), 0)
    into d1, d2 from visits where leg_id = l.id;
  if least(d1, d2) < lim then
    raise exception 'Both players need to have thrown % darts before a bull off', lim;
  end if;

  update legs set winner = p_winner, bull_off = true where id = l.id;
  if p_winner = 1 then m.p1_legs := m.p1_legs + 1; else m.p2_legs := m.p2_legs + 1; end if;

  if greatest(m.p1_legs, m.p2_legs) >= m.legs_to_win then
    update matches
       set p1_legs = m.p1_legs, p2_legs = m.p2_legs, status = 'complete',
           winner_id = case when p_winner = 1 then m.player1_id else m.player2_id end,
           finished_at = now()
     where id = p_match;
  else
    update matches set p1_legs = m.p1_legs, p2_legs = m.p2_legs where id = p_match;
    insert into legs (match_id, leg_no, starter) values (p_match, l.leg_no + 1, 3 - l.starter);
  end if;

  perform refresh_match_state(p_match);
end $$;

revoke execute on function public.bull_off(uuid, int) from public, anon;
grant  execute on function public.bull_off(uuid, int) to authenticated;

-- Undo now takes back a bull off if that was the last thing entered, and
-- otherwise works exactly as before.
create or replace function public.undo_visit(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  v visits;
  l legs;
begin
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.scorer_id is distinct from auth.uid() then raise exception 'You are not the scorer for this match'; end if;

  select * into l from legs where match_id = p_match and bull_off order by leg_no desc limit 1;
  if found and not exists (
    select 1 from visits vv join legs ll on ll.id = vv.leg_id
     where vv.match_id = p_match and ll.leg_no > l.leg_no
  ) then
    if m.status = 'complete' and m.next_match_id is not null
       and exists (select 1 from matches where id = m.next_match_id and status <> 'pending') then
      raise exception 'The next round match has already started, ask an admin to fix this';
    end if;
    delete from legs where match_id = p_match and leg_no > l.leg_no;
    update legs set winner = null, bull_off = false where id = l.id;
    update matches
       set p1_legs = p1_legs - (l.winner = 1)::int,
           p2_legs = p2_legs - (l.winner = 2)::int,
           status = 'live', winner_id = null, finished_at = null
     where id = p_match;
    perform refresh_match_state(p_match);
    return;
  end if;

  select * into v from visits where match_id = p_match order by id desc limit 1;
  if not found then raise exception 'Nothing to undo'; end if;
  select * into l from legs where id = v.leg_id;

  if l.winner is not null then
    if m.status = 'complete' and m.next_match_id is not null
       and exists (select 1 from matches where id = m.next_match_id and status <> 'pending') then
      raise exception 'The next round match has already started, ask an admin to fix this';
    end if;
    delete from legs where match_id = p_match and leg_no > l.leg_no;
    update legs set winner = null where id = l.id;
    update matches
       set p1_legs = p1_legs - (l.winner = 1)::int,
           p2_legs = p2_legs - (l.winner = 2)::int,
           status = 'live', winner_id = null, finished_at = null
     where id = p_match;
  end if;

  delete from visits where id = v.id;
  perform refresh_match_state(p_match);
end $$;

-- Same as migration-014, except a leg settled on the bull isn't a sheet leg.
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
    where l.winner is not null and not l.bull_off
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

-- ------------------------------------------------------------------ summary

-- Per-player figures for one tournament. Score bands don't overlap: a 180
-- is only a 180, a 140 is only in 140+.
create or replace function public.tournament_summary(p_tournament uuid)
returns table (
  player_id     uuid,
  player_name   text,
  played        int,
  won           int,
  legs_won      int,
  legs_lost     int,
  darts         int,
  scored        int,
  first9_darts  int,
  first9_scored int,
  s100          int,
  s140          int,
  s180          int,
  hi_checkout   int,
  ton_checkouts int,
  best_leg      int
)
language sql stable security definer set search_path = public as $$
  with m as (
    select * from matches
     where tournament_id = p_tournament and player1_id is not null and player2_id is not null
  ),
  v as (
    select vi.*, case when vi.player = 1 then m.player1_id else m.player2_id end as pid,
           row_number() over (partition by vi.leg_id, vi.player order by vi.id) as n
      from visits vi join m on m.id = vi.match_id
  ),
  pv as (
    select pid,
           sum(v.darts)::int                                       as darts,
           sum(v.score)::int                                       as scored,
           sum(v.darts) filter (where n <= 3)::int                 as d9,
           sum(v.score) filter (where n <= 3)::int                 as s9,
           count(*) filter (where v.score between 100 and 139)::int as s100,
           count(*) filter (where v.score between 140 and 179)::int as s140,
           count(*) filter (where v.score = 180)::int              as s180,
           max(v.score) filter (where v.remaining = 0)::int        as hi,
           count(*) filter (where v.remaining = 0 and v.score >= 100)::int as tons
      from v group by pid
  ),
  bl as (
    select case when l.winner = 1 then m.player1_id else m.player2_id end as pid,
           min(x.d)::int as best
      from legs l
      join m on m.id = l.match_id
      join lateral (select sum(vi.darts) as d from visits vi where vi.leg_id = l.id and vi.player = l.winner) x on true
     where l.winner is not null and not l.bull_off and x.d is not null
     group by 1
  ),
  mr as (
    select pid, count(*)::int as played, count(*) filter (where w)::int as won,
           sum(lw)::int as lw, sum(ll)::int as ll
      from (
        select player1_id as pid, winner_id = player1_id as w, p1_legs as lw, p2_legs as ll from m where status = 'complete'
        union all
        select player2_id, winner_id = player2_id, p2_legs, p1_legs from m where status = 'complete'
      ) z
     group by pid
  ),
  ids as (select pid from pv union select pid from mr)
  select p.id, p.name,
         coalesce(mr.played, 0), coalesce(mr.won, 0), coalesce(mr.lw, 0), coalesce(mr.ll, 0),
         coalesce(pv.darts, 0), coalesce(pv.scored, 0), coalesce(pv.d9, 0), coalesce(pv.s9, 0),
         coalesce(pv.s100, 0), coalesce(pv.s140, 0), coalesce(pv.s180, 0),
         pv.hi, coalesce(pv.tons, 0), bl.best
    from ids
    join players p on p.id = ids.pid
    left join pv on pv.pid = ids.pid
    left join mr on mr.pid = ids.pid
    left join bl on bl.pid = ids.pid;
$$;

grant execute on function public.tournament_summary(uuid) to anon, authenticated;
