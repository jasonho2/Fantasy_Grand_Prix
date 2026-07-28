# ESPN Fantasy Football Dashboard

Pulls data from ESPN Fantasy Football into a database, and serves it through
a Next.js dashboard (standings & trends, player/position breakdown,
head-to-head & schedule).

## How it fits together

```
espn_pipeline.py  --writes-->  SQLite file (local dev)  or  Turso (production)
                                          ^
                                          |  reads via @libsql/client
                                     web/  (Next.js app, deployed on Vercel)
```

The same `db.py` schema and the same Next.js query code work against either
backend -- which one you're pointed at is just an environment variable.

## 1. Pull data (Python)

```bash
pip install -r requirements.txt
python espn_pipeline.py --config config.json
```

This writes `espn_ff_1083280.xlsx` and `espn_ff_1083280.db` (see `config.json`
for the league ID / years / output paths -- copy `config.example.json` if
you're setting this up fresh; `config.json` holds your ESPN cookies and is
gitignored on purpose).

## 2. Run the dashboard locally

```bash
cd web
npm install
cp .env.local.example .env.local
npm run dev
```

`.env.local` points `DATABASE_URL` at the local `espn_ff_1083280.db` file
from step 1, so you can see real data without setting up Turso yet. Open
http://localhost:3000.

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
python espn_pipeline.py --config config.json --output ""   # skip xlsx, just load the DB
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
4. Deploy. Vercel rebuilds automatically on every push to `main`.

Because the site queries Turso live on each request, you do **not** need to
redeploy to see new data -- just rerun the pipeline against Turso (step 3
above) whenever you want to refresh scores.

## Project layout

- `espn_pipeline.py` -- pulls from ESPN's API, writes Excel and/or DB.
- `db.py` -- schema + upsert loader, works against local SQLite or Turso.
- `config.json` -- your league ID, years, ESPN cookies (gitignored).
- `web/` -- Next.js dashboard.
  - `app/standings/`, `app/players/`, `app/matchups/` -- the three pages.
  - `app/api/*/route.js` -- API routes that query the database.
  - `lib/db.js` -- shared database client.

## Notes / known limitations

- ESPN's `espn_s2`/`SWID` cookies expire periodically -- if the pipeline
  starts returning 401s, re-grab them from your browser (see chat history /
  ask again for the steps).
- The player/position breakdown and head-to-head records are computed in
  the browser from the full season's rows (a season is a couple thousand
  rows at most), so there's no pagination or server-side filtering to worry
  about at this scale.
- `db.py` uses `journal_mode = MEMORY` for the local SQLite backend. That's
  deliberate (see the comment in `connect()`) -- it avoids a "disk I/O
  error" that happens if this file is ever placed in a cloud-synced folder
  (OneDrive/Dropbox/etc.), at the cost of crash-safety that doesn't matter
  for a periodically-rerun batch load.
