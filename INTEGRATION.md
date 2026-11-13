# Merging the tournament site into uosdarts.com

Everything here goes into your existing Hugo repo at `hugo/uosdarts`.
Nothing in `data/`, `.github/` or `static/images/` changes.

## 1. Copy the files in

| From this folder | Into your repo | Note |
|---|---|---|
| `hugo.toml` | `hugo.toml` | replaces |
| `layouts/index.html` | `layouts/index.html` | replaces: home is now the tournaments page |
| `layouts/_default/*.html` | `layouts/_default/` | replaces baseof and pc-oom, adds four |
| `layouts/partials/header.html` | `layouts/partials/` | replaces: new nav |
| `layouts/partials/ranking-table.html` | `layouts/partials/` | replaces |
| `content/*.md` | `content/` | replaces `_index.md` and `pc-oom.md`, adds four |
| `static/css/main.css` | `static/css/` | replaces: modal badges renamed to avoid a clash |
| `static/css/app.css` | `static/css/` | new |
| `static/js/**` | `static/js/` | new |
| `assets/data/pc-rankings.csv` | `assets/data/` | new, the PC fallback |

`layouts/partials/build-ranking.html` and `footer.html` are unchanged; they are
included only so the folder is complete.

## 2. Put your Supabase keys in

Edit `static/js/config.js` and paste in the same two values you already use.

## 3. Build and check

```
hugo server
```

- `/` tournaments
- `/order-of-merit/` main table, every tournament
- `/pc-oom/` PC table, weekly PCs only
- `/tournament/?id=…`, `/match/?id=…`, `/admin/`

## 4. Push

The existing GitHub Actions workflow deploys on push to `main`. The CNAME is
untouched, so uosdarts.com serves the whole thing.

## How the order of merit pages work now

Points come from Supabase, live, on every visit. The table Hugo renders from
`assets/data/rankings.csv` at build time is what shows first, and what stays if
Supabase cannot be reached (with a quiet note under the table).

To refresh that published fallback, use the two buttons in the admin page under
**Published fallback**, drop the files into `assets/data/` and push. Doing it
once a term is plenty; it only matters when the site is offline.

## What changed in your files, and why

- **`main.css`**: the player modal's `.badge`, `.badge-gold`, `.badge-purple`
  and `.badge-star` became `.award`, `.award-gold`, `.award-purple`,
  `.award-star`. The tournament side uses `.badge` for live and ready markers,
  and the two would have fought. `ranking-table.html` is updated to match.
- **`app.css`**: uses your palette (`#0d0d0d`, `#c9a961`, `#151515`, `#2b2b2b`)
  and Inter, so both halves of the site match. Its own header styles are gone;
  the Hugo header is used everywhere.
- **`ranking-table.html`**: rows carry an id so the live data can replace them,
  and profile modals are now rendered for every player in `data/players`, not
  only those in the CSV. A player who only exists in the live table still opens.
