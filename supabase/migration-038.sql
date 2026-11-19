-- 038: remote friendlies, pick which player you're rejoining as
--
-- claim_match takes an optional seat (1 or 2). The match page offers a Join
-- button for each free seat, so whoever rejoins first doesn't end up as
-- player 1 by default.
--
-- Run after migration-037.sql. Safe to run more than once.

drop function if exists public.claim_match(uuid, text);
create or replace function public.claim_match(p_match uuid, p_password text default null, p_seat int default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  m matches;
  h text;
  t tournaments;
begin
  if auth.uid() is null then raise exception 'You need to be signed in to score'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if m.status = 'complete' then raise exception 'This match has already finished'; end if;
  if (m.player1_id is null and m.p1_name is null) or (m.player2_id is null and m.p2_name is null) then
    raise exception 'Both players are not decided yet';
  end if;
  select * into t from tournaments where id = m.tournament_id;

  if t.is_remote then
    if auth.uid() in (m.scorer_id, m.scorer2_id) then return; end if;
    select pw_hash into h from tournament_passwords where tournament_id = t.id;
    if p_password is null or h is null or crypt(btrim(p_password), h) <> h then
      raise exception 'Wrong password for this match';
    end if;
    -- The seat asked for, or failing that whichever is free.
    if p_seat = 1 and m.scorer_id is not null then
      raise exception '% is already in this match', m.p1_name;
    elsif p_seat = 2 and m.scorer2_id is not null then
      raise exception '% is already in this match', m.p2_name;
    elsif p_seat = 1 or (p_seat is null and m.scorer_id is null) then
      update matches set scorer_id = auth.uid() where id = p_match;
    elsif p_seat = 2 or (p_seat is null and m.scorer2_id is null) then
      update matches set scorer2_id = auth.uid() where id = p_match;
    else
      raise exception 'Both players are already scoring this match';
    end if;
    perform refresh_match_state(m.id);
    return;
  end if;

  if m.scorer_id is not null and m.scorer_id <> auth.uid() then
    raise exception 'Someone is already scoring this match';
  end if;
  if m.scorer_id is distinct from auth.uid() then
    if t.is_friendly then
      if not friendly_pw_ok(p_password) then raise exception 'Wrong scoring password'; end if;
    elsif t.kind is not null then
      if not fixture_pw_ok(t.id, p_password) then raise exception 'Wrong scoring password'; end if;
    else
      select pw_hash into h from tournament_passwords where tournament_id = m.tournament_id;
      if h is not null then
        if p_password is null or btrim(p_password) = '' then
          raise exception 'This tournament needs a scoring password';
        end if;
        if crypt(btrim(p_password), h) <> h then
          raise exception 'Wrong scoring password';
        end if;
      end if;
    end if;
  end if;

  update matches set scorer_id = auth.uid() where id = p_match;
  perform refresh_match_state(m.id);
end $$;

revoke execute on function public.claim_match(uuid, text, int) from public, anon;
grant  execute on function public.claim_match(uuid, text, int) to authenticated;
