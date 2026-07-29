"""
Unified multi-league, multi-platform pipeline entrypoint (ESPN + Sleeper;
Yahoo may be added later -- see platforms/__init__.py for the puller
interface each platform module implements).

Two sources of leagues to pull, merged on every run:

1. config.json's "leagues" list -- the trusted source, since it's the only
   one that can carry ESPN credentials (there's no login on this site, so
   accepting ESPN cookies through an open web form would let anyone who
   finds the URL submit credentials that get stored and used by the
   automated pipeline; config.json is only editable by whoever has repo
   access). See config.example.json for the shape.
2. Self-service leagues registered through the web UI's "Add a League"
   form (web/app/api/leagues/route.js), stored directly in the `leagues`
   table. Restricted to Sleeper only, for the reason above -- Sleeper's API
   is public read-only and needs no credentials at all, so there's nothing
   sensitive being accepted from an anonymous visitor. These leagues have
   no config.json entry, so their years and regular-season length are
   auto-discovered (platforms.sleeper.resolve_years walks the whole
   previous_league_id chain when given no explicit years; regular season
   length comes from Sleeper's own playoff_week_start setting) and they get
   no Grand Prix contest windows (nothing to auto-detect there -- add them
   later by giving the league a config.json entry if wanted).

For each league (whichever source it came from):
  1. Registers/updates it in the `leagues` table (db.get_or_create_league)
     -- creates it on first run, updates credentials/display name in place
     on repeat runs.
  2. Resolves which years actually exist on that platform
     (platforms.<platform>.resolve_years).
  3. Pulls and loads each of those seasons (platforms.<platform>.pull_season
     + db.load_season), plus the league's display name, regular-season
     length, and Grand Prix contest windows for that season.

One league or season failing doesn't abort the run -- every other
league/season, including ones already loaded earlier in the same run, is
unaffected (each load_season() call commits independently). This matters
for an unattended scheduled run (GitHub Actions): a single league's API
being temporarily unavailable, or a self-service league with a typo'd id,
shouldn't stop every other league's stat corrections from landing.

Usage
-----
    python pipeline.py --config config.json
    python pipeline.py --config config.json --sqlite my_local.db
"""

import argparse
import json
import sys
from pathlib import Path

import db as db_module
from platforms import espn as espn_platform
from platforms import sleeper as sleeper_platform

PLATFORM_MODULES = {
    "espn": espn_platform,
    "sleeper": sleeper_platform,
}


def load_config(path):
    if not Path(path).exists():
        return {}
    with open(path) as f:
        return json.load(f)


def _pull_one_league(conn, league_cfg):
    """Register/update one league and pull+load every year it resolves to.
    Returns nothing -- all state changes land directly in the database.
    Catches its own per-season errors so one bad season doesn't stop the
    rest of this league's years, or any other league, from loading."""
    slug = league_cfg.get("slug")
    platform = league_cfg.get("platform")
    module = PLATFORM_MODULES.get(platform)
    if not slug or module is None:
        print(
            f"Skipping league config with slug={slug!r} platform={platform!r}: "
            f"slug is required and platform must be one of {sorted(PLATFORM_MODULES)}.",
            file=sys.stderr,
        )
        return

    print(f"=== {slug} ({platform}) ===")
    league_id = db_module.get_or_create_league(
        conn,
        platform=platform,
        slug=slug,
        display_name=league_cfg.get("display_name"),
        espn_league_id=league_cfg.get("espn_league_id"),
        espn_s2=league_cfg.get("espn_s2"),
        espn_swid=league_cfg.get("espn_swid"),
        sleeper_league_id=league_cfg.get("sleeper_league_id"),
    )

    # An empty/missing "years" means "discover everything this platform
    # knows about" -- true for every self-service Sleeper league (see
    # module docstring), and also usable for a config.json entry that
    # deliberately omits "years" for the same reason.
    years = league_cfg.get("years") or []
    regular_season_weeks_config = league_cfg.get("regular_season_weeks", {})
    contests_config = league_cfg.get("contests", {})

    try:
        season_ids = module.resolve_years(conn, league_cfg, years)
    except Exception as exc:  # noqa: BLE001 -- one bad league shouldn't abort the run
        print(f"  Could not resolve seasons for {slug}: {exc}", file=sys.stderr)
        return

    pull_years = years or sorted(season_ids.keys())
    for year in pull_years:
        external_season_id = season_ids.get(year)
        if external_season_id is None:
            print(f"  Skipping {year}: not available on {platform} for this league.", file=sys.stderr)
            continue
        try:
            print(f"  Fetching {year}...")
            data = module.pull_season(conn, league_cfg, year, external_season_id)

            db_module.load_season(
                conn,
                league_id,
                platform,
                year,
                data["team_manager"],
                data["team_name"],
                data["player_rows"],
                data["matchup_records"],
            )
            reg_weeks = (
                regular_season_weeks_config.get(year)
                or regular_season_weeks_config.get(str(year))
                or data.get("regular_season_weeks")
            )
            db_module.set_league_season_info(
                conn, league_id, year, data["external_id"], data["league_name"], reg_weeks
            )
            print(
                f"    {len(data['player_rows'])} player-week rows, "
                f"{len(data['matchup_records'])} matchup rows -- loaded."
            )

            windows = contests_config.get(year) or contests_config.get(str(year))
            if windows:
                db_module.set_contest_windows(conn, league_id, year, windows)
                print(f"    Set {len(windows)} contest window(s) for {year}")
        except Exception as exc:  # noqa: BLE001 -- one bad season shouldn't abort the run
            print(f"  Skipping {slug} {year}: {exc}", file=sys.stderr)
            continue


def run_pipeline(leagues_config, sqlite_path):
    if not sqlite_path:
        raise ValueError("sqlite_path is required (ignored in favor of Turso if TURSO_DATABASE_URL is set).")

    conn = db_module.connect(sqlite_path)

    processed_slugs = set()
    for league_cfg in leagues_config:
        _pull_one_league(conn, league_cfg)
        if league_cfg.get("slug"):
            processed_slugs.add(league_cfg["slug"])

    # Self-service leagues added through the web UI's "Add a League" form
    # (Sleeper only -- see module docstring). Anything already covered by
    # config.json is skipped here to avoid pulling it twice.
    try:
        rows = conn.execute(
            "SELECT slug, sleeper_league_id FROM leagues WHERE platform = 'sleeper'"
        ).fetchall()
    except Exception as exc:  # noqa: BLE001 -- don't let a query hiccup abort config-driven leagues above
        print(f"Could not list self-service Sleeper leagues: {exc}", file=sys.stderr)
        rows = []

    for slug, sleeper_league_id in rows:
        if slug in processed_slugs or not sleeper_league_id:
            continue
        _pull_one_league(
            conn,
            {"slug": slug, "platform": "sleeper", "sleeper_league_id": sleeper_league_id},
        )

    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Pull fantasy football data (ESPN + Sleeper) into the database.")
    parser.add_argument("--config", default="config.json", help="Path to config JSON file")
    parser.add_argument("--sqlite", help="Local SQLite .db path (ignored if TURSO_DATABASE_URL is set)")
    args = parser.parse_args()

    cfg = load_config(args.config)
    leagues_config = cfg.get("leagues") or []
    sqlite_path = args.sqlite if args.sqlite is not None else cfg.get("sqlite", "fantasy_grand_prix.db")

    run_pipeline(leagues_config, sqlite_path or None)


if __name__ == "__main__":
    main()
