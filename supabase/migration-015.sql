-- 015: board calls
-- Admins can call upcoming matches to a board. A called match shows in its own
-- "Board calls" section on the tournament page, between Live and Up next.
-- Admins already have write access to matches, so this is just the column.

alter table public.matches add column if not exists called_at timestamptz;
