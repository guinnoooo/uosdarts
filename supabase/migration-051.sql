-- Migration 051: cancelling bets, chat names, and 😆 reactions.
--
-- 1. A bet can be cancelled for a full refund until betting on it closes
--    (the match starts, or for an outright, the tournament's first match).
-- 2. Chat names are typed again, so people can call themselves what they
--    like, but every message is still tied to an account. Anyone in the chat
--    can tap a name to see the account's real name.
-- 3. Messages can be reacted to with 😆, once per account; the count shows.

-- ---------------------------------------------------------------- cancelling

alter table public.bets drop constraint if exists bets_status_check;
alter table public.bets add constraint bets_status_check
  check (status in ('open', 'won', 'lost', 'void', 'cancelled'));

create or replace function public.cancel_bet(p_bet bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  b bets;
  why text;
begin
  select * into b from bets where id = p_bet and user_id = auth.uid() for update;
  if not found then raise exception 'Bet not found'; end if;
  if b.status <> 'open' then raise exception 'That bet has already been settled'; end if;
  why := case when b.match_id is not null then match_bet_block(b.match_id) else outright_bet_block(b.tournament_id) end;
  if why is not null then raise exception 'Too late to cancel: %', lower(left(why, 1)) || substr(why, 2); end if;
  update bets set status = 'cancelled', settled_at = now() where id = b.id;
  update accounts set tokens = tokens + b.stake where user_id = b.user_id;
  return (select tokens from accounts where user_id = b.user_id);
end $$;
revoke execute on function public.cancel_bet(bigint) from public, anon;
grant execute on function public.cancel_bet(bigint) to authenticated;

-- my_bets says which open bets can still be cancelled.
create or replace function public.my_bets(p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.tournament_id, b.match_id, b.side, b.player_id, b.selection, b.market, b.price, b.stake, b.status, b.payout,
           floor(b.stake * b.decimal_odds)::int as returns, b.placed_at, b.settled_at, t.name as tournament,
           b.status = 'open' and (case when b.match_id is not null then match_bet_block(b.match_id)
                                       else outright_bet_block(b.tournament_id) end) is null as can_cancel
      from bets b join tournaments t on t.id = b.tournament_id
     where b.user_id = auth.uid()
     order by b.placed_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
$$;

-- The signed-in user's bets on one match or tournament (for those pages).
create or replace function public.my_bets_on(p_match uuid, p_tournament uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.placed_at desc), '[]'::jsonb) from (
    select b.id, b.selection, b.price, b.stake, b.status, b.payout, floor(b.stake * b.decimal_odds)::int as returns, b.placed_at,
           b.status = 'open' and (case when b.match_id is not null then match_bet_block(b.match_id)
                                       else outright_bet_block(b.tournament_id) end) is null as can_cancel
      from bets b
     where b.user_id = auth.uid()
       and ((p_match is not null and b.match_id = p_match)
         or (p_match is null and b.tournament_id = p_tournament and b.match_id is null))
       and b.status <> 'cancelled') x;
$$;

-- Cancelled bets don't count on the leaderboard (void ones already didn't).
create or replace function public.leaderboard() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform apply_topups(null);
  return coalesce((
    select jsonb_agg(x order by x.total desc, x.name)
      from (
        select a.display_name as name, a.tokens,
               coalesce(o.in_play, 0) as in_play, a.tokens + coalesce(o.in_play, 0) as total,
               coalesce(s.placed, 0) as placed, coalesce(s.won, 0) as won,
               a.user_id = auth.uid() as me
          from accounts a
          left join (select user_id, sum(stake) as in_play from bets where status = 'open' group by user_id) o on o.user_id = a.user_id
          left join (select user_id, count(*) as placed, count(*) filter (where status = 'won') as won
                       from bets where status not in ('void', 'cancelled') group by user_id) s on s.user_id = a.user_id
         where not a.banned
      ) x), '[]'::jsonb);
end $$;

create or replace function public.match_bet_totals(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bets', count(*),
    'side1', coalesce(sum(stake) filter (where side = 1), 0),
    'side2', coalesce(sum(stake) filter (where side = 2), 0))
    from bets where match_id = p_match and status not in ('void', 'cancelled');
$$;

-- ---------------------------------------------------------------- chat names

create or replace function public.post_chat(p_match uuid, p_name text, p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  a accounts;
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  b text := btrim(coalesce(p_body, ''));
  new_id bigint;
begin
  select * into a from accounts where user_id = auth.uid();
  if not found then raise exception 'Log in to chat'; end if;
  if a.banned then raise exception 'Your account can''t post in the chat'; end if;
  if n = '' then n := a.display_name; end if;
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

-- Who really sent a message: the account's name. Anyone with an account can ask.
create or replace function public.chat_real_name(p_message bigint) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_account() then raise exception 'Log in to see who that is'; end if;
  return (select a.display_name from match_chat c join accounts a on a.user_id = c.user_id where c.id = p_message);
end $$;
revoke execute on function public.chat_real_name(bigint) from public, anon;
grant execute on function public.chat_real_name(bigint) to authenticated;

-- ---------------------------------------------------------------- reactions

create table if not exists public.chat_reactions (
  message_id bigint not null references public.match_chat(id) on delete cascade,
  user_id uuid not null references public.accounts(user_id) on delete cascade,
  match_id uuid not null,
  emoji text not null default '😆',
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists chat_reactions_match_idx on public.chat_reactions (match_id);
alter table public.chat_reactions enable row level security;
drop policy if exists "reactions readable" on public.chat_reactions;
create policy "reactions readable" on public.chat_reactions for select using ((select has_account()));
do $$ begin
  alter publication supabase_realtime add table public.chat_reactions;
exception when duplicate_object then null;
end $$;

-- Adds the signed-in user's 😆 to a message, or takes it off. Returns true if it's now on.
create or replace function public.toggle_reaction(p_message bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  a accounts;
  m uuid;
begin
  select * into a from accounts where user_id = auth.uid();
  if not found then raise exception 'Log in to react'; end if;
  if a.banned then raise exception 'Your account can''t react in the chat'; end if;
  select match_id into m from match_chat where id = p_message;
  if m is null then raise exception 'Message not found'; end if;
  delete from chat_reactions where message_id = p_message and user_id = a.user_id;
  if found then return false; end if;
  insert into chat_reactions (message_id, user_id, match_id) values (p_message, a.user_id, m);
  return true;
end $$;
revoke execute on function public.toggle_reaction(bigint) from public, anon;
grant execute on function public.toggle_reaction(bigint) to authenticated;

-- Reaction counts for a match's chat, and which the signed-in user has added.
create or replace function public.chat_reaction_counts(p_match uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(message_id, jsonb_build_object('n', n, 'mine', mine)), '{}'::jsonb)
    from (select message_id, count(*) as n, bool_or(user_id = auth.uid()) as mine
            from chat_reactions where match_id = p_match group by message_id) x
   where has_account();
$$;
