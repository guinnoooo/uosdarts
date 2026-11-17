-- 022: who throws first in set play
--
-- Within a set the throw alternates every leg. Each new set is started by
-- the other player from the one who started the previous set, however many
-- legs that set took: if A threw first in set 1, B throws first in set 2,
-- A in set 3, and so on. Legs-only matches are unchanged (alternate every leg).
--
-- Safe to run more than once.

create or replace function public.after_leg_won(p_match uuid, p_leg_no int, p_starter int) returns void
language plpgsql security definer set search_path = public as $$
declare
  m matches;
  first_starter int;
  nxt int := 3 - p_starter;
begin
  if recount_match(p_match) then return; end if;   -- that was the match

  select * into m from matches where id = p_match;
  -- A set has just finished when the current set's legs are back to 0-0.
  if m.sets_to_win is not null and m.p1_legs = 0 and m.p2_legs = 0 then
    select starter into first_starter from legs where match_id = p_match and leg_no = 1;
    -- Sets 1, 3, 5... start with whoever threw first in the match; 2, 4, 6... with the other.
    nxt := case when (m.p1_sets + m.p2_sets) % 2 = 0 then first_starter else 3 - first_starter end;
  end if;

  insert into legs (match_id, leg_no, starter) values (p_match, p_leg_no + 1, nxt);
end $$;

revoke execute on function public.after_leg_won(uuid, int, int) from public, anon, authenticated;
