-- The results rating stays a hidden backend figure, so the rating_history
-- function added for a profile chart is removed again. (Profiles chart
-- order of merit points instead, from player_profile.)
drop function if exists public.rating_history(uuid, date);
