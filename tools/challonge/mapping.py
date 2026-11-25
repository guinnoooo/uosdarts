import json, collections
B=json.load(open('brackets.json'))
SURE = {
 'Aflie Mortimer':'Alfie Mortimer','Alfie Mortimer':'Alfie Mortimer','Alby':'Alb Jarman','Alby Jarman':'Alb Jarman',
 'Barney':'Barney Chaudhry','Ben Brown':'Ben Browne','Ben Browne':'Ben Browne','Ben Clarke':'Ben Clarke','Bocal':"Ben O'Callaghan",
 'Cian':'Cian Hughes','Cian Hughes':'Cian Hughes','Cosmo':'Cosmo Kay','DC':'Dan Campbell','Dan Buckley':'Dan Buckley',
 'Danny Harltand':'Danny Hartland','Danny Hartland':'Danny Hartland','Darsh':'Darsh Johar','Darsh Johar':'Darsh Johar',
 'Ed Brown':'Ed Browne','Ed Browne':'Ed Browne','Egan':'Luke Egan','Luke Egan':'Luke Egan','Ethan Warren':'Ethan Warren',
 'Evan Buxton':'Evan Buxton','Felix Whittaker':'Felix Whittaker','Fin Bowden':'Finley Bowden','Finlay Bowden':'Finley Bowden',
 'Finley Bowden':'Finley Bowden','Finlay Jackson':'Finley Jackson','Finley Jackson':'Finley Jackson','Freddie Taylor':'Freddie Taylor',
 'George Barrow':'George Barrow','George Burton':'George Burton','George Vincennt':'George Vincent','George Vincent':'George Vincent',
 'Vincent':'George Vincent','Gog':'Aidan Garratt','Halder':'Max Halder','Max Halder':'Max Halder','Harvey Simpson':'Harvey Simpson',
 'Hawkins':'Matt Hawkins','Matt Hawkins':'Matt Hawkins','Hawley':'Jack Hawley','Jack Hawley':'Jack Hawley','Hendo':'James Henderson',
 'Henry Gascgoine':'Henry Gascoigne','moaty':'Henry Gascoigne','Henry Lupton':'Henry Lupton','Henry Lutpon':'Henry Lupton',
 'Iwan James':'Iwan James','Jack Redfern':'Jack Redfern','Jack Vicars':'Jack Vicars','James Lauer':'James Lauer','James Payne':'James Payne',
 'James Phillip':'James Phillips','James Phillips':'James Phillips','Jono':'Jono Blatch','Jono Blatch':'Jono Blatch','Jude Cockin':'Jude Cockin',
 'Leila Mitchell':'Leila Mitchell','Lewis Collet':'Lewis Collet','Lewis Collett':'Lewis Collet','Liam English':'Liam English',
 'Luke Davies':'Luke Davies','Luke Lavery':'Luke Lavery','Makin':'Oli Makin','Oli Makin':'Oli Makin','Matthew Watts':'Matt Watts',
 'Max Brown':'Max Browne','Max Browne':'Max Browne','Max Cutler':'Max Cutler','Michael Davy':'Michael Davy','Mike Britlamnd':'Mike Britland',
 'Mike Britland':'Mike Britland','Mikey':'Mikey Guinness','nathan barrow':'Nathan Barrow','Nathan Barrow':'Nathan Barrow',
 'Nathan Miller':'Nathan Miller','Oddy':'Sam Oddy','Sam Oddy':'Sam Oddy','Oliver Pratt':'Oliver Pratt','pratt':'Oliver Pratt','Pratt':'Oliver Pratt',
 'Oliver Shaw':'Oliver Shaw','Ollie Preace':'Ollie Preece','Ollie Preece':'Ollie Preece','Rory':'Rory Peach','Rory Peach':'Rory Peach',
 'Ruben':'Ruben Parker','Ruben Parker':'Ruben Parker','Sibbo':'Tom Sibley','Tom Ainger':'Tom Ainger','tom ainger':'Tom Ainger',
 'tom batho':'Thomas Batho','Tom Batho':'Thomas Batho','Tookey':'Sam Tookey','Wells':'Dan Wells','Zak Mills':'Zak Mills',
}
GUESS = {'Jack Redford':'Jack Redfern?','Danny':'Danny Hartland?','fin':'Finley Bowden or Finley Jackson?','Jimbo':'a James? (Lauer, Payne, Phillips, Beer)',
         'Shay':'same as Shay Raithatha?','Elliot':'same as Elliot Finch?','Alex':'Alex Burke, Alex Fall or Alex Vienna?',
         'Custard':'?','Pummer':'?','Rashi':'?','oli moore':'same as Ollie Moore?','Ollie Moore':'(not on the site)'}
seen=collections.defaultdict(list)
for t in B:
    for n in sorted({p['name'] for m in t['matches'] for p in m['players']}):
        seen[n].append(t['title'].replace('Player Championships','PC').replace('Players Championship','PC').replace('Player Champs 02- Europa League','Europa 02').replace('Europa League','Europa'))
json.dump({'sure':SURE,'guess':GUESS}, open('mapping.json','w'), indent=1)
unk=[n for n in seen if n not in SURE]
print('UNSURE/NEW:')
for n in sorted(unk, key=str.lower): print(f"  {n:22} {GUESS.get(n,'(not on the site)'):38} {', '.join(seen[n])}")
print(len(SURE), 'sure;', len(unk), 'unsure')
