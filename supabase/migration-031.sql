-- 031: provisional averages for players with little or no record
--
-- A hand-entered average used by GuinnessBet and the win probability for
-- players who haven't thrown many darts on the site. The site blends it out
-- as real darts come in (see careerOf in static/js/winprob.js), so it stops
-- counting once a player has a full record. Not shown on any page.
--
-- Run after migration-030.sql. Safe to run more than once.

alter table public.players add column if not exists provisional_avg numeric(5,2)
  check (provisional_avg is null or provisional_avg between 10 and 120);

-- match_preview gains p1_prov and p2_prov, which also puts them in each
-- match's model snapshot.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.match_preview(uuid)'::regprocedure);
  if position('p1_prov' in def) = 0 then
    def := replace(def, $r$'p1_form',$r$,
      $r$'p1_prov', (select provisional_avg from players where id = m.player1_id),
    'p2_prov', (select provisional_avg from players where id = m.player2_id),
    'p1_form',$r$);
    if position('p1_prov' in def) = 0 then raise exception 'match_preview has changed shape'; end if;
    execute def;
  end if;
end $$;

-- First set, 19 Nov 2026.
update public.players p set provisional_avg = v.a
  from (values ('Luke Egan', 60), ('Matt Watts', 55), ('Darsh Johar', 49), ('Luke Davies', 55),
               ('Joel Keaney', 58), ('Adam Butcher', 46), ('Lewis Forrest', 60), ('Matt Duke', 54),
               ('Oli Graham', 61)) as v(n, a)
 where p.name = v.n;
