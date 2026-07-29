# Fantasy Football Dashboard

Pulls data from fantasy football leagues -- ESPN and Sleeper today, Yahoo
possibly later -- into a database, and serves it through a Next.js
dashboard (standings & trends, player/position breakdown, head-to-head &
schedule, Grand Prix contests). Multi-league: the database can hold any
number of leagues at once, each on its own platform.

## How it fits together

```
pipeline.py  --writes-->  SQLite file (local dev)  or  Turso (production)
     ^                              ^
     |                              |  reads via @libsql/client
platforms/espn.py                web/  (Next.js app, deployed on Vercel)
platforms/sleeper.py
```

`pipeline.py` loops over every league in `config.json`'s `"leagues"` list,
hands each one to the matching module in `platforms/` (pure API-fetching
code, one module per platform) to pull, then loads the normalized result
through `db.py`'s shared schema/loader. The same schema and the same
Next.js query code work against either database backend -- which one
you're pointed at is just an environment variable.

## 1. Pull data (Python)

```bash
pip install -r requirements.txt
python pipeline.py --config config.json
```

Copy `config.example.json` to `config.json` if you're setting this up
fresh (`config.json` holds real credentials and is gitignored on purpose).
`config.json`'s `"leagues"` is a list -- one entry per league:

```json
{
  "sqlite": "fantasy_grand_prix.db",
  "leagues": [
    {
      "slug": "el-tri-ffl",
      "platform": "espn",
      "espn_league_id": 1083280,
      "espn_s2": "...",
      "espn_swid": "...",
      "years": [2024, 2025, 2026],
      "regular_season_weeks": { "2025": 14 },
      "contests": { "2025": [ { "name": "Mushroom Cup", "start_week": 1, "end_week": 3 } ] }
    },
    {
      "slug": "some-sleeper-league",
      "platform": "sleeper",
      "sleeper_league_id": "<current season's Sleeper league id>",
      "years": [2025, 2026],
      "regular_season_weeks": { "2025": 14 },
      "contests": {}
    }
  ]
}
```

Sleeper leagues need no credentials at all -- its API is public read-only,
so `sleeper_league_id` (the *current* season's id; earlier seasons are
found automatically via Sleeper's `previous_league_id` chain) is the only
platform-specific field. Add or remove leagues by editing this list and
rerunning; each league/season load is an independent upsert, so adding a
new league never touches existing ones.

`espn_pipeline.py` still works standalone (single ESPN league, optional
`.xlsx` export) if you just want a quick local export -- `pipeline.py` is
the multi-league, DB-only entrypoint used for everything else in this doc.

## 2. Run the dashboard locally

```bash
cd web
npm install
cp .env.local.example .env.local
npm run dev
```

`.env.local` points `DATABASE_URL` at the local `fantasy_grand_prix.db` file
from step 1 (the `"sqlite"` path in `config.json`), so you can see real data
without setting up Turso yet. Open http://localhost:3000.

## 3. Go live: Turso (hosted database)

Local SQLite files aren't reachable from a deployed site, so production
reads from Turso (hosted, SQLite-compatible) instead.

```bash
# install the CLI
curl -sSfL https://get.tur.so/install.sh | bash     # or: brew install tursodatabase/tap/turso

turso auth signup          # opens your browser, free account
turso db create espnff     # creates the database
turso db show espnff       # gives you the database URL (libsql://...)
turso db tokens create espnff   # gives you an auth token
```

Set those two values as environment variables and re-run the pipeline to
load your data into Turso instead of (or in addition to) the local file:

```bash
export TURSO_DATABASE_URL="libsql://espnff-<your-org>.turso.io"
export TURSO_AUTH_TOKEN="<token from above>"
pip install libsql
python pipeline.py --config config.json
```

Whenever you want the live site to reflect new scores, rerun that command
(loads are upserts, so it's safe to rerun anytime -- e.g. weekly during the
season).

## 4. Deploy the frontend

1. Push this repo to GitHub (`git remote add origin <your repo url>`, `git push -u origin main`).
2. Go to [vercel.com](https://vercel.com), import the GitHub repo, and set the **root directory** to `web/` (the Next.js app lives in a subfolder, not the repo root).
3. Add environment variables in the Vercel project settings:
   - `DATABASE_URL` = your `libsql://...` URL from `turso db show`
   - `DATABASE_AUTH_TOKEN` = your token from `turso db tokens create`
   - `ADD_LEAGUE_PASSPHRASE` (optional) = a passphrase of your choosing.
     Enables the ESPN path on the site's "Add a League" form, gated behind
     this passphrase (see "Adding leagues" below). Leave unset to disable
     ESPN self-service entirely -- Sleeper self-service works either way,
     it doesn't use this.
4. Deploy. Vercel rebuilds automatically on every push to `main`.

Because the site queries Turso live on each request, you do **not** need to
redeploy to see new data -- just rerun the pipeline against Turso (step 3
above) whenever you want to refresh scores.

## 5. Automate it: GitHub Actions

Steps 3 and 4 make the site *able* to show fresh data without a redeploy,
but someone still has to rerun the pipeline. `.github/workflows/pull-data.yml`
does that automatically on a schedule, so nobody has to run anything by
hand -- for every league in `config.example.json`, ESPN or Sleeper alike --
including picking up stat corrections, since every run re-fetches each
configured league/season from scratch and upserts (there's no separate
"corrections" step; a normal rerun a day or two later just overwrites the
box scores with whatever the platform now says is official).

Add four repo secrets at **GitHub repo -> Settings -> Secrets and variables
-> Actions -> New repository secret**:

| Secret | Value |
| --- | --- |
| `ESPN_S2` | your `espn_s2` cookie value (same one in `config.json`) |
| `ESPN_SWID` | your `SWID` cookie value, including the curly braces |
| `TURSO_DATABASE_URL` | from `turso db show espnff` |
| `TURSO_AUTH_TOKEN` | from `turso db tokens create espnff` |

Only ESPN leagues need the first two -- Sleeper's API is public read-only,
so a Sleeper league entry in `config.example.json` needs nothing beyond its
`sleeper_league_id`. The workflow builds a `config.json` at runtime from
the non-secret `config.example.json` (every league's platform, ids, years,
regular season weeks, contest windows) plus those ESPN secrets injected
into any `"platform": "espn"` entries, then runs `pipeline.py` pointed at
Turso via the other two secrets. Nothing sensitive is ever committed to
the repo.

It's scheduled for every 30 minutes on Thursday/Sunday/Monday (the NFL's
primary game days) to avoid burning Actions minutes the rest of the week --
edit the `cron:` line in the workflow file to change that. You can also
trigger a pull on demand any time from the repo's **Actions** tab ->
"Pull fantasy data" -> **Run workflow**, no terminal needed.

If a league or a season within it isn't available (e.g. next year's ESPN
league hasn't been rolled over yet, or a Sleeper league id is wrong), that
one league/season is skipped with a warning in the run's log instead of
failing the whole job -- every other league/season still gets pulled and
committed.

## Adding leagues

Both platforms can be self-serviced through **+ Add League** in the nav,
but ESPN is gated -- this site has no login, and the two platforms have
very different risk profiles when it comes to accepting them from an
anonymous form submission.

**Sleeper** -- fully open, no repo access or passphrase needed. Paste in a
Sleeper league id and submit. That just registers the league (writes one
row to the database); the next scheduled pipeline run (or a manually
triggered one, see "5. Automate it") picks it up automatically and pulls
its *entire* history -- every season back to when the league started,
discovered via Sleeper's own season-chain metadata, no need to specify
which years. The regular-season length is similarly auto-detected from
Sleeper's own playoff-start setting. This is safe to leave fully open
because Sleeper's API needs no credentials at all -- there's nothing
sensitive in that form.

**ESPN** -- needs real `espn_s2`/`SWID` cookies, which *is* sensitive, so
the form's ESPN tab is gated behind the `ADD_LEAGUE_PASSPHRASE` env var
(see "4. Deploy the frontend"). If that env var isn't set, the ESPN tab is
disabled entirely rather than silently accepting any passphrase. With the
right passphrase, the form validates the league id/cookies against ESPN's
real API before storing anything, then registers it the same way Sleeper
does -- except years have to be given explicitly (e.g. `2024-2026`,
defaults to the current year if left blank), since ESPN has no
season-chain to auto-walk the way Sleeper does. You can still add ESPN
leagues the old way too -- editing `config.json` directly and rerunning
the pipeline (or adding it to the automated workflow's secrets) -- which
skips the passphrase and gets you `years`/`regular_season_weeks`/contest
window config all in one place. See "1. Pull data" above for that shape.

Either self-service path: Grand Prix contest windows aren't
auto-detectable, so a self-service league won't have any until you add a
`"contests"` entry for it in `config.json`.

## Project layout

- `pipeline.py` -- multi-league entrypoint: loops `config.json`'s `"leagues"`
  list, dispatches each to the matching module in `platforms/`, loads the
  result through `db.py`.
- `platforms/espn.py`, `platforms/sleeper.py` -- one puller per platform,
  pure API-fetching code normalized to a common shape (see
  `platforms/__init__.py` for the interface both implement).
- `espn_pipeline.py` -- the original single-ESPN-league CLI (kept for quick
  local `.xlsx` exports; not used by the automated workflow anymore).
- `db.py` -- multi-league schema + upsert loader, works against local
  SQLite or Turso. A database created before multi-league support was
  added is auto-migrated on first connect (see the comment on
  `_migrate_legacy_single_league_schema` in `db.py`) -- since every row is
  re-derived from the platform APIs, that migration rebuilds the data
  tables fresh rather than attempting a cell-by-cell schema change, so
  rerun the pipeline (or wait for the next scheduled run) right after
  upgrading an existing database.
- `config.json` -- your leagues (platform, ids, credentials, years, contest
  windows), gitignored.
- `config.example.json` -- same shape as `config.json` minus real
  credentials; what the GitHub Actions workflow uses as a template.
- `.github/workflows/pull-data.yml` -- scheduled job that reruns the
  pipeline against Turso automatically for every configured league (see
  "5. Automate it" above).
- `web/` -- Next.js dashboard.
  - `app/standings/`, `app/players/`, `app/matchups/`, `app/contests/` -- the four pages.
  - `app/leagues/new/` -- self-service "Add a League" form (Sleeper only --
    see "Adding leagues through the web UI" below).
  - `app/api/*/route.js` -- API routes that query the database, all scoped
    by a `?league=<slug>` param alongside `season`.
  - `app/api/leagues/route.js` -- handles the "Add a League" form
    submission (registers a Sleeper league; doesn't pull any data itself).
  - `app/components/LeagueSelect.js` -- the league-switcher dropdown, hidden
    whenever fewer than two leagues are registered.
  - `lib/db.js` -- shared database client.

## Point-total contests (Contests page)

Separate from the season-long win/loss standings, this league also runs
side-contests within specific week windows (currently weeks 1-3, 4-7, 8-11,
12-15 for 2025 -- contest scoring stops at week 15 even though the season
runs through week 17).

Scoring within a window is Mario-Kart-style placement points, not raw
fantasy points: every week, all managers are ranked by that week's fantasy
score (highest first) and earn placement points -- 1st: 12, 2nd: 10, 3rd: 9,
4th: 8, 5th: 7, 6th: 6, 7th: 5, 8th: 4, 9th: 3, 10th: 2, 11th: 1, 12th: 0.
These placement points accumulate across a window's weeks and determine the
leaderboard ranking; a manager's raw fantasy-point total for the window is
still shown, but only as a reference column, not the sort key.

Windows aren't hardcoded, since they can change by league, season, or
commissioner choice. Define them per league in `config.json`:

```json
"contests": {
  "2025": [
    { "name": "Contest 1", "start_week": 1, "end_week": 3 },
    { "name": "Contest 2", "start_week": 4, "end_week": 7 },
    { "name": "Contest 3", "start_week": 8, "end_week": 11 },
    { "name": "Contest 4", "start_week": 12, "end_week": 15 }
  ]
}
```

Rerunning `python pipeline.py --config config.json` loads/updates these
windows (upsert, safe to rerun -- editing a window's weeks and rerunning
updates it in place). The Contests page computes each manager's weekly rank
and placement points at query time from `weekly_manager_points` -- nothing
about a window's totals is stored directly, so editing the config
and rerunning is all it takes to change a window's boundaries.

## Notes / known limitations

- There's still no login on this site -- anyone with the URL can view every
  registered league and use the self-service "Add a League" form. Sleeper's
  side of that form is fully open (nothing sensitive to protect); ESPN's
  side is passphrase-gated (see "Adding leagues" above), which is a
  deliberately lightweight speed bump, not real auth -- if this ever needs
  to be locked down further (e.g. before sharing the URL widely), that's an
  auth layer to add on top, not a rework of what's here.
- Each pipeline run merges two sources of leagues: `config.json`'s list and
  any leagues already registered in the database that config.json doesn't
  already cover (i.e. added through the web form, either platform). A
  league present in both is only pulled once, via its config.json entry.
- Sleeper's per-player weekly points are an approximation (closest of
  standard/half-PPR/full-PPR to the league's actual reception scoring --
  see the comment at the top of `platforms/sleeper.py`), since Sleeper's
  stats endpoint doesn't expose a fully custom-scoring-settings-aware
  total. Team-level weekly totals (standings, wins/losses, points-for) are
  exact either way -- they come straight from Sleeper's own computed score,
  not from summing the approximated player-level numbers.
- ESPN's `espn_s2`/`SWID` cookies expire periodically -- if the pipeline
  starts returning 401s, re-grab them from your browser (see chat history /
  ask again for the steps). Sleeper leagues need no credentials at all.
- The player/position breakdown and head-to-head records are computed in
  the browser from the full season's rows (a season is a couple thousand
  rows at most), so there's no pagination or server-side filtering to worry
  about at this scale.
- `db.py` uses `journal_mode = MEMORY` for the local SQLite backend. That's
  deliberate (see the comment in `connect()`) -- it avoids a "disk I/O
  error" that happens if this file is ever placed in a cloud-synced folder
  (OneDrive/Dropbox/etc.), at the cost of crash-safety that doesn't matter
  for a periodically-rerun batch load.
- If the GitHub repo is **private**, scheduled Actions runs count against a
  monthly free-tier minutes cap (public repos don't have this limit). Each
  run of `pull-data.yml` is quick, but if you widen the cron schedule (more
  often, more days) and start seeing runs skipped/queued, that's why --
  either make the repo public or trim the schedule.
