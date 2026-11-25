import json, re
from mapping import SURE
B = json.load(open('brackets.json'))
SURE = dict(SURE)
SURE.update({'Custard': "Joseph D'Ambrosio", 'Pummer': 'Aidan Wood', 'pummer': 'Aidan Wood', 'Danny': 'Danny Hartland',
             'Jack Redford': 'Jack Redfern'})
NEW = {'Alex Burke':'Alex Burke','Alex Fall':'Alex Fall','Archie Hall':'Archie Hall','Ben Blume':'Ben Blume','Cam Douglas':'Cam Douglas',
       'Easton McGillard':'Easton McGilliard','Easton McGilliard':'Easton McGilliard','Easton Mcgilliard':'Easton McGilliard',
       'Eli Manzer':'Eli Manzur','eli manzur':'Eli Manzur','Elliot Finch':'Elliot Finch','Ewan Abbott':'Ewan Abbott','Ewan Clarke':'Ewan Clarke',
       'Ewan Welsh':'Ewan Welsh','George Miller':'George Miller','Harrison Orme':'Harrison Orme','Harry James':'Harry James','Henry Carr':'Henry Carr',
       'Jacob Bradford':'Jacob Bradford','Jamie Goga':'Jamie Goga','Max Greenwood':'Max Greenwood','Ollie Moore':'Ollie Moore','Oscar Hills':'Oscar Hills',
       'Shay Raithatha':'Shay Raithatha','Stan Nelson':'Stan Nelson','Zach Nick':'Zach Nick'}
NAME = {**SURE, **NEW}
EVENTS = {  # file title -> (event name, date, seq offset)
 'Player Championships 02': ('PC 2','2026-10-05',0), 'Player Champs 02- Europa League': ('Europa 2','2026-10-05',300),
 'Player Championships 3': ('PC 3','2026-10-12',0), 'Europa League 3': ('Europa 3','2026-10-12',300),
 'Player Championships 04': ('PC 4','2026-10-19',0), 'Europa League 04': ('Europa 4','2026-10-19',300),
 'Players Championship 05': ('PC 5','2026-10-26',0), 'Europa League': ('Europa 5','2026-10-26',300),
 'Player Championships 06': ('PC 6','2026-11-02',0), 'Europa League 06': ('Europa 6','2026-11-02',300),
 'Player Championships 07': ('PC 7','2026-11-09',0), 'Europa League 07': ('Europa 7','2026-11-09',300),
}
q = lambda s: "'" + s.replace("'", "''") + "'"
rows = []  # (event, date, seq, round, best_of, a, b, la, lb, a_known, b_known)
skipped = []
for t in B:
    ev, day, off = EVENTS[t['title']]
    ms = sorted(t['matches'], key=lambda m: (m['round'], m['id']))
    final_round = max(m['round'] for m in ms)
    for i, m in enumerate(ms):
        ps = m['players']
        if len(ps) != 2 or any(p.get('score') in (None, '') for p in ps) or 'complete' not in (m.get('state') or ''):
            skipped.append((ev, m['id'], 'not finished', [p.get('name') for p in ps])); continue
        (a, b) = ps
        la, lb = int(a['score']), int(b['score'])
        if la == lb or la < 0 or lb < 0:
            skipped.append((ev, m['id'], 'bad score', [a['name'], b['name'], la, lb])); continue
        if ev == 'PC 2' and {a['name'], b['name']} & {'Ben Browne', 'Tookey'}:
            skipped.append((ev, m['id'], 'PC2 Browne/Tookey', [a['name'], b['name'], la, lb])); continue
        if ev == 'PC 5' and m['round'] == final_round:
            # Mikey: Wells beat Egan 5-2 (Challonge has it the other way round)
            assert {a['name'], b['name']} == {'Wells', 'Egan'}, (a['name'], b['name'])
            if a['name'] == 'Wells': la, lb = 5, 2
            else: la, lb = 2, 5
        na, nb = NAME.get(a['name']), NAME.get(b['name'])
        if na is None and nb is None:
            skipped.append((ev, m['id'], 'both unknown', [a['name'], b['name']])); continue
        best_of = 2 * max(la, lb) - 1
        rows.append((ev, day, off + i, m['round'], best_of, na, nb, la, lb, a['name'], b['name']))
# SQL: values list; the server side looks up ids by name
nz = lambda x: q(x) if x else 'null'
vals = ',\n'.join(f"({q(r[0])},{r[2]},{r[3]},{r[4]},{nz(r[5])},{nz(r[6])},{r[7]},{r[8]},{'null' if r[5] else q(r[9])},{'null' if r[6] else q(r[10])})" for r in rows)
days = ', '.join(f"({q(e)},{q(d)}::date)" for e, d, _ in EVENTS.values())
sql = f"""-- Challonge results for PC 2-7 and Europa 2-7, imported as external results.
create temp table ch0(event text, seq int, round int, best_of int, a text, b text, la int, lb int, a_raw text, b_raw text);
insert into ch0 values
{vals};
create temp table ch as select c.event, d.played_on, c.seq, c.round, c.best_of, c.a, c.b, c.la, c.lb, c.a_raw, c.b_raw
  from ch0 c join (values {days}) d(event, played_on) on d.event = c.event;
insert into players(name, slug, year)
select n, regexp_replace(lower(n), '[^a-z0-9]+', '-', 'g'), 'Student'
  from unnest(array[{', '.join(q(n) for n in sorted(set(NEW.values())))}]) n
 where not exists (select 1 from players p where p.name = n);
do $$ begin
  if exists (select 1 from ch where (a is not null and not exists (select 1 from players where name = ch.a))
                                 or (b is not null and not exists (select 1 from players where name = ch.b))) then
    raise exception 'unknown player name in import';
  end if;
end $$;
-- one row per match per known side
create temp table side as
select c.event, c.played_on, c.seq, c.round, c.best_of, pa.id player_id, pb.id opp_id, coalesce(c.b, c.b_raw) opp_name, c.la lf, c.lb la
  from ch c join players pa on pa.name = c.a left join players pb on pb.name = c.b
union all
select c.event, c.played_on, c.seq, c.round, c.best_of, pb.id, pa.id, coalesce(c.a, c.a_raw), c.lb, c.la
  from ch c join players pb on pb.name = c.b left join players pa on pa.name = c.a;
insert into external_events(player_id, event, source, played_on, avg, legs_won, legs_lost, serious)
select player_id, event, 'Challonge', played_on, null, sum(lf), sum(la), true from side group by player_id, event, played_on;
insert into external_results(event_id, player_id, round, seq, best_of, opponent, opponent_player_id, legs_for, legs_against)
select e.id, s.player_id, s.round::text, s.seq, s.best_of, s.opp_name, s.opp_id, s.lf, s.la
  from side s join external_events e on e.player_id = s.player_id and e.event = s.event and e.played_on = s.played_on and e.source = 'Challonge';
drop table ch0; drop table ch; drop table side;
select count(*) events, (select count(*) from external_results r join external_events e on e.id = r.event_id where e.source = 'Challonge') results
  from external_events where source = 'Challonge';
"""
open('import.sql', 'w').write(sql)
print(len(rows), 'matches;', sum(1 for r in rows if r[5] and r[6]), 'between two known players')
for s in skipped: print('skip', s)
print(sorted({r[9] for r in rows if not r[5]} | {r[10] for r in rows if not r[6]}))
