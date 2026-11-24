-- Migration 074: indexes the database advisor flagged on the new tables.
-- They make deleting or merging a player quick, which otherwise scans every
-- bet, fantasy pick and futures selection.
create index if not exists bets_player_idx on public.bets (player_id);
create index if not exists fantasy_picks_player_idx on public.fantasy_picks (player_id);
create index if not exists futures_selections_player_idx on public.futures_selections (player_id);
