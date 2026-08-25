# UOS Darts — Order of Merit

A black-and-gold Hugo site showing the society darts team's weekly ranking,
sourced straight from a CSV file. Update the CSV, push to GitHub, and the
site rebuilds and redeploys itself automatically.

## Updating the rankings (weekly)

1. Open `assets/data/rankings.csv` in Excel (or any spreadsheet app).
2. Edit it as normal — add rows, change scores, add extra columns, whatever
   you like. The site only cares about two things:
   - a column with the players' names
   - a column named **`total_points`** with their current points
3. Save it back as `rankings.csv` in the same place (CSV format, not `.xlsx`).
4. Commit and push the change to GitHub. The site will rebuild and go live
   automatically within a minute or two.

If your name column is ever called something other than `player_name`,
update the `nameColumn` value in `hugo.toml` to match — nothing else needs
to change.

## Running it locally

You'll need the [Hugo "extended"](https://gohugo.io/installation/) binary
installed (v0.150+).

```
hugo server
```

Then open http://localhost:1313/uosdarts/ in your browser. The page
rebuilds live as you edit files or the CSV.

## Publishing to GitHub Pages

This repo includes a GitHub Actions workflow
(`.github/workflows/hugo.yml`) that builds the site with Hugo and deploys
it to GitHub Pages on every push to `main`. One-time setup after your
first push:

1. On GitHub, go to your repo's **Settings → Pages**.
2. Under "Build and deployment", set **Source** to **GitHub Actions**.
3. Push to `main` (or re-run the workflow from the **Actions** tab).
4. Your site will be live at `https://guinnoooo.github.io/uosdarts/`.

If you rename the repo, also update `baseURL` in `hugo.toml` to match.

## Project structure

```
hugo.toml                    site config — title, colours-agnostic params, CSV column names
assets/data/rankings.csv     the file you edit every week
static/css/main.css          all styling (black background, gold trim)
layouts/index.html           reads the CSV, sorts by total_points, renders the table
layouts/_default/baseof.html page skeleton (head, header, footer)
layouts/partials/            header and footer
.github/workflows/hugo.yml   builds + deploys to GitHub Pages on push
```

## Next steps / ideas

- Add a society logo in place of the dart emoji in the header.
- Add individual player pages or a week-by-week history view.
- Add a "Played" or "Average" column to the table if you want more than
  just rank and points on show.
