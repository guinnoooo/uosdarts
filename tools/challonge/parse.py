import re, json, glob, html, sys
out = []
for f in sorted(glob.glob('/mnt/user-data/uploads/*.svg')):
    s = open(f, encoding='utf-8').read()
    title = html.unescape(re.search(r'class="title"[^>]*>(.*?)</text>', s, re.S).group(1).strip()) if 'class="title"' in s else None
    if not title:
        title = html.unescape(re.findall(r'<text[^>]*>(.*?)</text>', s, re.S)[0])
    rounds = [html.unescape(x) for x in re.findall(r'class="round-label[^"]*"[^>]*>(.*?)</text>', s)] or []
    matches = []
    for m in re.finditer(r'<g transform="translate\(([\d.]+) ([\d.]+)\)" class="match ([^"]*)" data-identifier="(\d+)" data-match-id="(\d+)">(.*?)</g></g>', s, re.S):
        x, y, cls, ident, mid, body = m.groups()
        players = []
        for p in re.finditer(r'<svg x="0" y="(\d+)" class="match--player" data-participant-id="(\d*)"><title>(.*?)</title>(.*?)</svg>', body, re.S):
            py, pid, name, pb = p.groups()
            seed = re.search(r'class="match--seed">(.*?)</text>', pb)
            score = re.search(r'class="match--player-score[^"]*">(.*?)</text>', pb)
            win = 'match--player-name  -winner' in pb or re.search(r'match--player-name[^"]*-winner', pb) is not None
            players.append({'pid': pid, 'name': html.unescape(name).strip(), 'seed': seed.group(1) if seed else None,
                            'score': score.group(1) if score else None, 'won': bool(win)})
        matches.append({'id': int(ident), 'match_id': mid, 'x': float(x), 'y': float(y), 'state': cls.strip(), 'players': players})
    xs = sorted({m['x'] for m in matches})
    for m in matches: m['round'] = xs.index(m['x']) + 1
    out.append({'file': f.split('/')[-1], 'title': title, 'n_rounds': len(xs), 'matches': sorted(matches, key=lambda m: m['id'])})
json.dump(out, open('/home/claude/challonge/brackets.json', 'w'), indent=1)
for t in out:
    ms = t['matches']
    played = [m for m in ms if len(m['players']) == 2 and all(p['score'] not in (None, '') for p in m['players']) and any(p['won'] for p in m['players'])]
    names = {p['name'] for m in ms for p in m['players']}
    print(f"{t['title']:<35} {t['file']:<28} matches {len(ms):3} played {len(played):3} players {len(names)}")
