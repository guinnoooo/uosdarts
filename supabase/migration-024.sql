-- 024: match chat, automatic board calls and referees
--
-- Chat
--   match_chat holds messages on any match (scheduled, live or finished,
--   friendlies too). Posting goes through post_chat(), which needs a
--   sign-in (the silent one scorers already get) and has a rate limit.
--   Admins can delete messages.
--
-- Boards and referees
--   tournaments.boards lists the boards for a tournament, best first.
--   tournaments.auto_boards switches on automatic board calls. While a
--   tournament is live, whenever a board is free the earliest ready match
--   is called to the best free board, and every called match gets a
--   referee (matches.referee_id / referee_name):
--     1. players who've just lost, in the order they lost (ref_queue)
--     2. players who had a first-round bye and haven't refereed yet
--     3. anyone else entered who isn't playing or refereeing, at random
--   It runs inside the database whenever a match starts, finishes, or is
--   called or uncalled, and whenever the boards change, so it doesn't
--   depend on anyone having the admin page open.
--
-- Safe to run more than once.

-- ================================================================== chat

create table if not exists public.match_chat (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.matches on delete cascade,
  user_id    uuid not null default auth.uid(),
  author     text not null check (length(btrim(author)) between 1 and 30),
  body       text not null check (length(btrim(body)) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists match_chat_match on public.match_chat (match_id, id);
create index if not exists match_chat_user on public.match_chat (user_id, created_at);

alter table public.match_chat enable row level security;
drop policy if exists "chat readable" on public.match_chat;
create policy "chat readable" on public.match_chat for select using (true);
grant select on public.match_chat to anon, authenticated;
-- No insert/update/delete policies: writes go through the functions below.

do $$ begin
  alter publication supabase_realtime add table public.match_chat;
exception when duplicate_object then null; end $$;

create or replace function public.post_chat(p_match uuid, p_name text, p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  n text := btrim(coalesce(p_name, ''));
  b text := btrim(coalesce(p_body, ''));
  new_id bigint;
begin
  if auth.uid() is null then raise exception 'You need to be signed in to chat'; end if;
  if n = '' then raise exception 'Pick a name first'; end if;
  if length(n) > 30 then raise exception 'Names can be up to 30 characters'; end if;
  if b = '' then raise exception 'Type a message'; end if;
  if length(b) > 280 then raise exception 'Messages can be up to 280 characters'; end if;
  if not exists (select 1 from matches where id = p_match) then raise exception 'Match not found'; end if;

  if exists (select 1 from match_chat where user_id = auth.uid() and created_at > now() - interval '2 seconds') then
    raise exception 'Slow down a little';
  end if;
  if (select count(*) from match_chat where user_id = auth.uid() and created_at > now() - interval '1 minute') >= 15 then
    raise exception 'That''s a lot of messages. Give it a minute';
  end if;

  insert into match_chat (match_id, user_id, author, body) values (p_match, auth.uid(), n, b)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.admin_delete_chat(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from match_chat where id = p_id;
end $$;

revoke execute on function public.post_chat(uuid, text, text)  from public, anon;
revoke execute on function public.admin_delete_chat(bigint)     from public, anon;
grant  execute on function public.post_chat(uuid, text, text)  to authenticated;
grant  execute on function public.admin_delete_chat(bigint)     to authenticated;

-- ================================================================== boards and referees

alter table public.tournaments add column if not exists boards text[] not null default '{}';
alter table public.tournaments add column if not exists auto_boards boolean not null default false;
alter table public.matches add column if not exists referee_id uuid references public.players on delete set null;
alter table public.matches add column if not exists referee_name text;

-- Players waiting to referee, in the order they lost.
create table if not exists public.ref_queue (
  tournament_id uuid not null references public.tournaments on delete cascade,
  player_id     uuid not null references public.players on delete cascade,
  queued_at     timestamptz not null default clock_timestamp(),
  primary key (tournament_id, player_id)
);
alter table public.ref_queue enable row level security;
-- No policies: only the functions below touch it.

-- A player is busy if they're playing or refereeing a match that's live or
-- called to a board.
create or replace function public.player_busy(p_tournament uuid, p_player uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from matches
     where tournament_id = p_tournament
       and (status = 'live' or (status = 'pending' and called_at is not null))
       and p_player in (player1_id, player2_id, referee_id)
  );
$$;

create or replace function public.pick_referee(p_tournament uuid, p_match uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  pick uuid;
begin
  select * into m from matches where id = p_match;

  -- 1. Whoever lost longest ago and is free.
  select q.player_id into pick
    from ref_queue q
   where q.tournament_id = p_tournament
     and q.player_id not in (coalesce(m.player1_id, '00000000-0000-0000-0000-000000000000'),
                             coalesce(m.player2_id, '00000000-0000-0000-0000-000000000000'))
     and not player_busy(p_tournament, q.player_id)
   order by q.queued_at
   limit 1;
  if pick is not null then
    delete from ref_queue where tournament_id = p_tournament and player_id = pick;
    return pick;
  end if;

  -- 2. A first-round bye who hasn't refereed in this tournament yet.
  select coalesce(b.player1_id, b.player2_id) into pick
    from matches b
   where b.tournament_id = p_tournament and b.stage = 'knockout' and b.round = 1
     and (b.player1_id is null) <> (b.player2_id is null)
     and coalesce(b.player1_id, b.player2_id) not in (coalesce(m.player1_id, '00000000-0000-0000-0000-000000000000'),
                                                     coalesce(m.player2_id, '00000000-0000-0000-0000-000000000000'))
     and not player_busy(p_tournament, coalesce(b.player1_id, b.player2_id))
     and not exists (select 1 from matches r where r.tournament_id = p_tournament
                        and r.referee_id = coalesce(b.player1_id, b.player2_id))
   order by random()
   limit 1;
  if pick is not null then return pick; end if;

  -- 3. Anyone entered who's free, at random. People with a match of their
  --    own ready to go are picked last, so a referee doesn't hold up a board.
  select tp.player_id into pick
    from tournament_players tp
   where tp.tournament_id = p_tournament
     and tp.player_id not in (coalesce(m.player1_id, '00000000-0000-0000-0000-000000000000'),
                              coalesce(m.player2_id, '00000000-0000-0000-0000-000000000000'))
     and not player_busy(p_tournament, tp.player_id)
   order by exists (
              select 1 from matches y
               where y.tournament_id = p_tournament and y.status = 'pending' and y.id <> p_match
                 and y.player1_id is not null and y.player2_id is not null
                 and tp.player_id in (y.player1_id, y.player2_id)),
            random()
   limit 1;
  return pick;   -- may be null if everyone is busy
end $$;

-- Fill free boards and give every called match a referee.
create or replace function public.auto_board_calls(p_tournament uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t tournaments;
  b text;
  c matches;
  ref uuid;
begin
  select * into t from tournaments where id = p_tournament;
  if not found or not t.auto_boards or t.status <> 'live' or t.is_friendly then return; end if;
  -- One run at a time per tournament, so two results at once can't double-book a board.
  perform pg_advisory_xact_lock(hashtext('boards:' || p_tournament::text));

  foreach b in array t.boards loop
    continue when exists (
      select 1 from matches
       where tournament_id = p_tournament and board = b
         and (status = 'live' or (status = 'pending' and called_at is not null))
    );
    -- The earliest ready match whose players are both free.
    select * into c from matches x
     where x.tournament_id = p_tournament and x.status = 'pending' and x.called_at is null
       and x.player1_id is not null and x.player2_id is not null
       and not player_busy(p_tournament, x.player1_id)
       and not player_busy(p_tournament, x.player2_id)
     order by case x.stage when 'group' then 0 else 1 end, x.round, x.slot
     limit 1;
    exit when not found;
    update matches set board = b, called_at = now() where id = c.id;
  end loop;

  -- Referees for anything called without one, best board first.
  for c in
    select x.* from matches x
     where x.tournament_id = p_tournament and x.status in ('pending', 'live')
       and x.called_at is not null and x.referee_id is null
     order by coalesce(array_position(t.boards, x.board), 999), x.called_at
  loop
    ref := pick_referee(p_tournament, c.id);
    exit when ref is null;
    update matches
       set referee_id = ref, referee_name = (select name from players where id = ref)
     where id = c.id;
  end loop;
end $$;

-- Matches: queue the loser to referee, then refill the boards.
create or replace function public.matches_boards_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The calls made here update matches too; don't react to those.
  if pg_trigger_depth() > 1 then return null; end if;

  if new.status = 'complete' and old.status is distinct from 'complete'
     and new.player1_id is not null and new.player2_id is not null and new.winner_id is not null then
    insert into ref_queue (tournament_id, player_id)
    values (new.tournament_id, case when new.winner_id = new.player1_id then new.player2_id else new.player1_id end)
    on conflict do nothing;
  end if;

  perform auto_board_calls(new.tournament_id);
  return null;
end $$;

-- Named zz_ so it runs after advance_winner has put the winner into the next round.
drop trigger if exists zz_matches_boards on public.matches;
create trigger zz_matches_boards
after update of status, player1_id, player2_id, board, called_at on public.matches
for each row execute function public.matches_boards_changed();

create or replace function public.tournaments_boards_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if new.status = 'live' then perform auto_board_calls(new.id); end if;
  return null;
end $$;

drop trigger if exists zz_tournaments_boards on public.tournaments;
create trigger zz_tournaments_boards
after update of status, boards, auto_boards on public.tournaments
for each row execute function public.tournaments_boards_changed();

-- Admins can swap a referee by hand (or clear one).
create or replace function public.admin_set_referee(p_match uuid, p_player uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update matches
     set referee_id = p_player,
         referee_name = (select name from players where id = p_player)
   where id = p_match;
end $$;

revoke execute on function public.player_busy(uuid, uuid)       from public, anon, authenticated;
revoke execute on function public.pick_referee(uuid, uuid)      from public, anon, authenticated;
revoke execute on function public.auto_board_calls(uuid)        from public, anon, authenticated;
revoke execute on function public.matches_boards_changed()      from public, anon, authenticated;
revoke execute on function public.tournaments_boards_changed()  from public, anon, authenticated;
revoke execute on function public.admin_set_referee(uuid, uuid) from public, anon;
grant  execute on function public.admin_set_referee(uuid, uuid) to authenticated;
