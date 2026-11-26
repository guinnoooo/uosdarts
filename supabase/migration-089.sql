-- Longest price allowed for a player in a tournament's winner market.
-- The odds model is untouched: this only shortens the price shown and paid
-- when the model's would be longer. `event` is matched against the
-- tournament's name (case ignored), so a row for 'Ham Cup' covers any
-- tournament with Ham Cup in its name.
create table if not exists outright_caps (
  event     text not null,
  player_id uuid not null references players(id) on delete cascade,
  max_price text not null check (max_price ~ '^[0-9]+/[0-9]+$'),
  primary key (event, player_id)
);
alter table outright_caps enable row level security;
revoke all on outright_caps from anon, authenticated;

insert into outright_caps (event, player_id, max_price)
select 'Ham Cup', p.id, v.cap
  from (values ('Ben O''Callaghan', '75/1'), ('Dan Campbell', '50/1'), ('Aidan Garratt', '75/1'),
               ('Darsh Johar', '100/1'), ('James Lauer', '100/1')) v(name, cap)
  join players p on p.name = v.name
on conflict (event, player_id) do update set max_price = excluded.max_price;

create or replace function public.tournament_odds_data(p_tournament uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare ids uuid[]; tname text;
begin
  select array_agg(player_id) into ids from tournament_players where tournament_id = p_tournament;
  if ids is null then return '[]'::jsonb; end if;
  select name into tname from tournaments where id = p_tournament;
  return (
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'prov', p.provisional_avg,
             'career', c.career, 'form', c.form, 'played', coalesce(c.played, 0), 'won', coalesce(c.won, 0),
             'rating', c.rating, 'rd', c.rd, 'sd', c.sd,
             'cap', (select oc.max_price from outright_caps oc
                      where oc.player_id = p.id and tname ilike '%' || oc.event || '%'
                      order by split_part(oc.max_price, '/', 1)::numeric / split_part(oc.max_price, '/', 2)::numeric
                      limit 1)))
      from players p left join model_now(ids) c on c.player_id = p.id
     where p.id = any (ids));
end $function$;
