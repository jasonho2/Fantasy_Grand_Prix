"""
SQLite schema + loader for the fantasy football pipeline. Multi-league,
multi-platform: one physical database can hold any number of leagues, each
pulled from ESPN or Sleeper (Yahoo may be added later), keyed by an internal
league_id so the same manager/team names in two unrelated leagues never
collide.

Design: normalized so a frontend can run flexible queries (points by
position, head-to-head history, season trends, etc.) without re-parsing
platform payloads. Loads are upserts, so re-running the pipeline for a
league/season you've already loaded updates rows in place instead of
duplicating them.

Backends
--------
Two interchangeable backends, same schema and same calling code:
  - Local SQLite file (default) -- good for local dev.
  - Turso (hosted libSQL, i.e. "SQLite over the network") -- what the
    deployed web frontend reads from, so it can show fresh data without
    a redeploy.

Which one you get is controlled by environment variables:
  TURSO_DATABASE_URL   e.g. libsql://your-db-name.turso.io
  TURSO_AUTH_TOKEN     token from the Turso dashboard/CLI

If TURSO_DATABASE_URL is set, connect() uses Turso (requires `pip install
libsql`). Otherwise it falls back to a local SQLite file. Nothing else in
this file, or in the platform pullers, needs to change to switch backends.

Schema
------
leagues                 one row per registered league (platform + credentials
                         + a URL-friendly slug). This is the "tenant" --
                         everything else hangs off league_id.
                         last_pulled_at is touched once per pipeline run
                         that processes this league (see
                         touch_last_pulled_at()), regardless of whether
                         anything actually changed -- it's what powers the
                         "Data as of [time]" indicator in the UI, not a
                         signal about data changing.
league_seasons          one row per (league, season): that season's
                         platform-side id (ESPN's league id repeats every
                         season; Sleeper's changes every season and is
                         chained via previous_league_id), display name,
                         regular_season_weeks (drives the standings/playoff
                         split -- see below), and scoring_config (that
                         season's Grand Prix placement->points scoring --
                         deliberately per-season, not per-league, since a
                         league's point system can change year to year and
                         each season's leaderboard must keep reflecting
                         whatever was configured for that specific year).
managers                one row per real person within a league (identified
                         by platform display name), scoped by league_id so
                         the same name in two different leagues doesn't merge.
teams                   one row per (league, season, platform team id) --
                         links a team to its manager.
players                 one row per NFL player, deduped by (platform,
                         platform_player_id) when available.
weekly_player_points    one row per starting-lineup player per week.
matchups                one row per matchup per week (home vs away, with both
                         scores), scoped by league_id since two leagues can
                         both use matchup id "1" in the same season.
platform_sync_state     small key/value cache table, currently used to avoid
                         re-fetching Sleeper's ~5MB player dump on every run
                         (Sleeper asks integrators to pull it at most once a
                         day).

weekly_manager_points   VIEW: sums `weekly_player_points` per (season, week,
                        team_id) to get the manager's weekly total, so it
                        isn't stored twice. Deliberately NOT derived from
                        matchups.home_points/away_points -- a platform's
                        season-level schedule can be missing a matchup entry
                        for a given week (seen with ESPN consolation-bracket
                        games during playoff weeks), which would silently
                        drop that team for that week. See the comment above
                        the view's SQL for details.
contest_windows         one row per side-contest window (e.g. weeks 1-4,
                        5-8, 9-12, 13-17) for a league/season. Not hardcoded
                        -- windows vary by league/commissioner, so they're
                        configured per league and loaded via
                        set_contest_windows(). A manager's score in a contest
                        is just the sum of weekly_manager_points over that
                        window's weeks (computed at query time, not stored).
live_matchups           one row per team for whichever single week is
                        currently being played (if any), scoped by
                        league_id + season same as matchups. Deliberately
                        NOT a history table -- load_season() replaces this
                        league/season's rows wholesale (delete then
                        insert) every pipeline run, so it only ever holds
                        "whatever's live right now," never anything from a
                        week that's since been decided. Once ESPN marks
                        that week final, platforms/espn.py stops returning
                        it as live and the next run's replace naturally
                        empties this table for that league/season -- real
                        matchup data then flows through the normal
                        `matchups` table/pipeline as always. Read by
                        api/matchups/route.js (merged into the schedule
                        response with is_live: true), by
                        api/contests/route.js (folded straight into the
                        same Solo/Double Dash ranking pipeline as decided
                        weeks, so cup point totals move live), and by
                        api/standings/route.js's `weekly`/gpWeekly series
                        (the Weekly/Grand-Prix Points Trend charts) -- but
                        NOT by its `weeklyRecords` (the Season Leaderboard
                        table's W-L/points-for/against): a W-L record can't
                        be known until a matchup is actually decided the
                        way a point total reasonably can be shown
                        provisionally. Points here come from a fresh
                        boxscore pull (starter stat lines), same
                        bonus-free source as every decided week and every
                        bye week -- never ESPN's live totalPoints directly.
live_player_points      one row per starting-lineup player for whichever
                        single week is currently being played (if any) --
                        the same live pull as live_matchups, just at
                        per-player granularity instead of summed per team,
                        since Players & Positions needs individual player
                        stats rather than a team total. Same
                        wholesale-replace-every-run convention as
                        live_matchups (see above) -- never a history
                        table, never more than one week's worth of rows.
                        Read by api/players/route.js, unioned with decided
                        `weekly_player_points` rows so the Player Totals
                        table and Points-by-Position chart both include
                        the in-progress week's provisional stats.
projected_matchups      one row per team for every week AFTER whichever one
                        is currently live (if any) -- through
                        MAX_PROJECTED_WEEK -- that a platform still has on
                        its schedule, scoped by league_id + season same as
                        matchups/live_matchups. Same wholesale-replace-
                        every-run convention as live_matchups (delete then
                        insert every pipeline run), just covering several
                        weeks at once instead of one: as each of those weeks
                        gets decided (or goes live), the next run's real
                        matchup_records/live_matchup_records take over for
                        it and it drops out of this table's replace set.
                        home_points/away_points here are PROJECTED, not
                        actual -- a platform's own projection for that
                        player/week (ESPN: statSourceId=1 in the same
                        boxscore call used for actuals; Sleeper: a separate
                        undocumented projections endpoint), summed per team
                        the same bonus-free way as everywhere else. Read
                        only by api/contests/route.js, to extend a cup's
                        leaderboard past its last played week for the
                        "Projected Finish" sort option -- never by
                        standings or matchups, where a hypothetical future
                        score has no business appearing next to real
                        results.
"""

import os
import sqlite3
import sys

try:
    import libsql  # Turso's Python SDK -- only needed if TURSO_DATABASE_URL is set
except ImportError:
    libsql = None

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS leagues (
    league_id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,              -- 'espn' | 'sleeper'
    slug TEXT NOT NULL UNIQUE,           -- URL-friendly identifier used in routes/links
    display_name TEXT,                   -- shown in the UI, falls back to the platform's own league name
    espn_league_id INTEGER,              -- ESPN only
    espn_s2 TEXT,                        -- ESPN only, private leagues (encrypted at rest by the caller)
    espn_swid TEXT,                      -- ESPN only, private leagues
    sleeper_league_id TEXT,              -- Sleeper only -- that league's CURRENT/most recent season id,
                                          -- earlier seasons are resolved by walking previous_league_id
                                          -- and cached per-season in league_seasons.external_id
    pull_years TEXT,                     -- JSON array of years, e.g. "[2024,2025]". Only meaningful for
                                          -- ESPN leagues registered through the self-service web form --
                                          -- ESPN has no season-chain to auto-walk the way Sleeper does, so
                                          -- self-service ESPN leagues need an explicit year list from
                                          -- somewhere; config.json-defined leagues ignore this column
                                          -- entirely and use their own "years" list instead.
    cup_weeks INTEGER,                    -- SUPERSEDED by league_seasons.cup_weeks below -- cup length
                                          -- used to be one league-wide setting, which turned out wrong
                                          -- for the same reason leagues.scoring_config was retired (see
                                          -- its comment just below): a commissioner changing it for one
                                          -- season silently changed every other season's Contests page
                                          -- too. Left in place harmlessly for any old row that still has
                                          -- a value, but no application code reads or writes it anymore.
    scoring_config TEXT,                 -- SUPERSEDED by league_seasons.scoring_config below -- scoring is
                                          -- now configured per season, not once for the whole league (a
                                          -- league's point system can change year to year, and this
                                          -- column had no way to represent that: editing it always
                                          -- retroactively changed every season's leaderboard, including
                                          -- past ones). Left in place harmlessly for any old row that
                                          -- still has a value, but no application code reads or writes it
                                          -- anymore -- see league_seasons.scoring_config instead.
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS league_seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    external_id TEXT,                    -- that season's platform-side league id (TEXT: Sleeper's ids are
                                          -- ~18 digits and overflow JS's safe integer range as a Number)
    league_name TEXT,
    -- Length of the regular season in weeks. Drives the Season Leaderboard
    -- (standings + regular-season points trend are scoped to weeks
    -- 1..regular_season_weeks) and the separate playoff points trend
    -- (regular_season_weeks+1..latest played week). Neither platform
    -- exposes this reliably enough to auto-detect, so it's configured
    -- per league/season.
    regular_season_weeks INTEGER,
    scoring_config TEXT,                 -- JSON -- THIS season's configured default placement->points
                                          -- scoring per cup (see web/lib/scoring.js). NULL means "plain
                                          -- Solo, no overrides, for every cup" -- this season was never
                                          -- explicitly configured (or predates this column). Deliberately
                                          -- scoped per (league_id, season) rather than living on leagues,
                                          -- since a league's scoring can legitimately change year to year
                                          -- and each season's leaderboard must keep reflecting whatever
                                          -- was configured for that specific year.
    cup_weeks INTEGER,                   -- 15 or 16 -- THIS season's configured Grand Prix cup length
                                          -- (see api/contests/route.js's CUP_WEEK_SETS). NULL means "16,
                                          -- never explicitly configured for this season." Supersedes
                                          -- leagues.cup_weeks (see that column's comment) for exactly the
                                          -- same reason scoring_config was moved here: cup length can
                                          -- legitimately change year to year (e.g. a league switching from
                                          -- the original 15-week split to the newer 16-week one starting a
                                          -- given season), and a single league-wide value meant editing it
                                          -- for one season silently changed every other season too.
    UNIQUE(league_id, season)
);
CREATE INDEX IF NOT EXISTS idx_league_seasons_league ON league_seasons(league_id);

CREATE TABLE IF NOT EXISTS managers (
    manager_id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    manager_name TEXT NOT NULL,
    UNIQUE(league_id, manager_name)
);

CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    platform_team_id TEXT NOT NULL,      -- ESPN's numeric team id, or Sleeper's roster_id, as text
    team_name TEXT,
    manager_id INTEGER NOT NULL REFERENCES managers(manager_id),
    UNIQUE(league_id, season, platform_team_id)
);
CREATE INDEX IF NOT EXISTS idx_teams_league_season ON teams(league_id, season);

CREATE TABLE IF NOT EXISTS players (
    player_id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    platform_player_id TEXT,
    player_name TEXT NOT NULL,
    position TEXT,
    UNIQUE(platform, platform_player_id)
);

CREATE TABLE IF NOT EXISTS weekly_player_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team_id INTEGER NOT NULL REFERENCES teams(team_id),
    player_id INTEGER NOT NULL REFERENCES players(player_id),
    points REAL,
    UNIQUE(season, week, team_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_wpp_season_week ON weekly_player_points(season, week);
CREATE INDEX IF NOT EXISTS idx_wpp_team ON weekly_player_points(team_id);
CREATE INDEX IF NOT EXISTS idx_wpp_player ON weekly_player_points(player_id);

CREATE TABLE IF NOT EXISTS matchups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    platform_matchup_id TEXT,
    home_team_id INTEGER NOT NULL REFERENCES teams(team_id),
    away_team_id INTEGER REFERENCES teams(team_id),
    home_points REAL,
    away_points REAL,
    winner TEXT,
    is_bye INTEGER NOT NULL DEFAULT 0,
    UNIQUE(league_id, season, platform_matchup_id)
);
CREATE INDEX IF NOT EXISTS idx_matchups_league_season_week ON matchups(league_id, season, week);

-- Derived from weekly_player_points (sum of that team's starters), NOT from
-- matchups.home_points/away_points. Discovered via real league data: a
-- platform's season-level schedule can be missing a matchup entry for a
-- given week (seen with ESPN consolation-bracket games during playoff
-- weeks), which would silently drop that team from this view for that week
-- if it were built from matchups instead. weekly_player_points is populated
-- from each team's boxscore directly and stays complete even when that
-- happens, so every team appears every week it fielded a lineup, regardless
-- of whether the platform's schedule listing shows a matchup for it.
DROP VIEW IF EXISTS weekly_manager_points;
CREATE VIEW weekly_manager_points AS
    SELECT season, week, team_id, ROUND(SUM(points), 2) AS points
    FROM weekly_player_points
    GROUP BY season, week, team_id;

-- Wholesale-replaced every pipeline run (see the docstring's live_matchups
-- entry above for why) -- no platform_matchup_id / upsert-by-id needed
-- since there's never more than one snapshot in flight per league/season.
CREATE TABLE IF NOT EXISTS live_matchups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    home_team_id INTEGER NOT NULL REFERENCES teams(team_id),
    away_team_id INTEGER REFERENCES teams(team_id),
    home_points REAL,
    away_points REAL,
    is_bye INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_live_matchups_league_season ON live_matchups(league_id, season);

-- Same wholesale-replace-every-run convention as live_matchups above, just
-- at per-player granularity (see the docstring's live_player_points entry)
-- so Players & Positions can show the in-progress week's provisional
-- per-player stats, not just a team total.
CREATE TABLE IF NOT EXISTS live_player_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team_id INTEGER NOT NULL REFERENCES teams(team_id),
    player_id INTEGER NOT NULL REFERENCES players(player_id),
    points REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_live_player_points_league_season ON live_player_points(league_id, season);

-- Same wholesale-replace-every-run convention as live_matchups above, just
-- covering every week after the live one (if any) through
-- MAX_PROJECTED_WEEK instead of a single week -- see the docstring's
-- projected_matchups entry above. home_points/away_points here are a
-- platform's own projection for that team, not an actual result.
CREATE TABLE IF NOT EXISTS projected_matchups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    home_team_id INTEGER NOT NULL REFERENCES teams(team_id),
    away_team_id INTEGER REFERENCES teams(team_id),
    home_points REAL,
    away_points REAL,
    is_bye INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projected_matchups_league_season ON projected_matchups(league_id, season);

CREATE TABLE IF NOT EXISTS contest_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(league_id),
    season INTEGER NOT NULL,
    contest_name TEXT NOT NULL,
    start_week INTEGER NOT NULL,
    end_week INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    UNIQUE(league_id, season, contest_name)
);
CREATE INDEX IF NOT EXISTS idx_contest_windows_league_season ON contest_windows(league_id, season);

-- Small cache of "when did we last do X" markers. Currently used to respect
-- Sleeper's guidance to pull their ~5MB full-player-list endpoint at most
-- once a day, even though the pipeline itself may run every 5 minutes on
-- game days.
CREATE TABLE IF NOT EXISTS platform_sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _split_statements(sql):
    """Split a script into individual statements. Only sqlite3 supports
    conn.executescript(); libsql's execute() runs one statement at a time,
    so we split and loop -- this works identically on both backends.

    Strips `-- ...` line comments before splitting on ";", so a semicolon
    that shows up inside a comment (e.g. "-- shown in the UI; falls back
    to...") doesn't get mistaken for a statement boundary. Safe for this
    schema since none of the SQL itself uses string literals containing
    "--" or ";"."""
    without_comments = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    return [s.strip() for s in without_comments.split(";") if s.strip()]


def _migrate_legacy_single_league_schema(conn):
    """Databases created before multi-league support had a single implicit
    league: `leagues` was keyed by season (season INTEGER PRIMARY KEY) and
    no table had a league_id column. Detect that shape and rebuild the data
    tables fresh under the new schema, rather than writing a cell-by-cell
    ALTER TABLE migration -- every row in every one of these tables is fully
    re-derivable by rerunning the pipeline (all upserts, sourced live from
    the platform's API), so there's no user-authored data at risk.

    After this runs once against a given database, rerun the pipeline (or
    just wait for the next scheduled GitHub Actions run) to repopulate it."""
    tables = {
        row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    if "leagues" not in tables:
        return  # brand-new database, nothing to migrate
    columns = {row[1] for row in conn.execute("PRAGMA table_info(leagues)").fetchall()}
    if "league_id" in columns:
        return  # already on the new schema
    print(
        "db.py: detected a pre-multi-league database -- rebuilding tables "
        "under the new schema. Data is fully re-derived from the next "
        "pipeline run.",
        file=sys.stderr,
    )
    for table in [
        "weekly_player_points",
        "matchups",
        "contest_windows",
        "teams",
        "players",
        "managers",
        "leagues",
    ]:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.execute("DROP VIEW IF EXISTS weekly_manager_points")
    conn.commit()


# Columns added to a table after it first shipped under the current
# (multi-league) schema. "CREATE TABLE IF NOT EXISTS" is a no-op once the
# table already exists, so adding a column to SCHEMA_SQL alone does nothing
# for databases created before that change -- this list is the migration
# path for those. Safe to run every connect(): each entry is only applied
# if the column is actually missing.
COLUMN_MIGRATIONS = [
    ("leagues", "pull_years", "TEXT"),
    ("leagues", "last_pulled_at", "TEXT"),
    # URL of the team's profile picture/logo, as reported by the platform
    # (ESPN's mTeam view; Sleeper has no per-team logo concept today, so
    # this stays NULL for Sleeper-sourced teams). Populated in
    # get_or_create_team(); NULL until the next pipeline run touches a
    # league sourced before this column existed.
    ("teams", "logo_url", "TEXT"),
    # SUPERSEDED -- see the SCHEMA_SQL comment on leagues.cup_weeks and the
    # league_seasons.cup_weeks entry just below. Kept here (rather than
    # deleted) purely so a database that predates BOTH this column and the
    # per-season one still gets leagues.cup_weeks added on connect, matching
    # what SCHEMA_SQL declares -- no application code reads or writes it
    # going forward.
    ("leagues", "cup_weeks", "INTEGER"),
    # SUPERSEDED -- see the SCHEMA_SQL comment on leagues.scoring_config and
    # the league_seasons.scoring_config entry just below. Kept here (rather
    # than deleted) purely so a database that predates BOTH this column and
    # the per-season one still gets leagues.scoring_config added on connect,
    # matching what SCHEMA_SQL declares -- no application code reads or
    # writes it going forward.
    ("leagues", "scoring_config", "TEXT"),
    # Per-season Grand Prix scoring (see the SCHEMA_SQL comment on
    # league_seasons.scoring_config above). Replaces leagues.scoring_config,
    # which applied one point system to every season a league has ever
    # played -- wrong as soon as a league's scoring changes year to year,
    # since editing it would silently rewrite past seasons' leaderboards
    # too. NULL for any season never explicitly configured; api/contests/
    # route.js treats that the same as "plain Solo, no point overrides."
    ("league_seasons", "scoring_config", "TEXT"),
    # Per-season Grand Prix cup length (see the SCHEMA_SQL comment on
    # league_seasons.cup_weeks above). Replaces leagues.cup_weeks for the
    # same reason scoring_config moved here -- one league-wide value meant
    # changing it for one season silently changed every other season's
    # Contests page too. NULL for any season never explicitly configured;
    # api/contests/route.js treats that the same as "16 weeks."
    ("league_seasons", "cup_weeks", "INTEGER"),
]


def _apply_column_migrations(conn):
    for table, column, coltype in COLUMN_MIGRATIONS:
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


def connect(db_path):
    """Connect to Turso if TURSO_DATABASE_URL is set in the environment,
    otherwise to a local SQLite file at db_path. Same schema, same API
    either way -- callers don't need to know which backend they got."""
    # Deliberately distinguishes "the env var isn't set at all" (use local
    # SQLite -- the normal local-dev case) from "the env var is set but
    # empty" (fail loudly). The latter most commonly means a GitHub Actions
    # secret that was never added -- ${{ secrets.X }} substitutes to an
    # empty string, not a missing variable, so os.environ.get() alone can't
    # tell those two cases apart, and silently falling back to a local
    # SQLite file inside an ephemeral CI runner looks exactly like success
    # (no error, exit code 0) while never actually touching Turso.
    if "TURSO_DATABASE_URL" in os.environ and not os.environ["TURSO_DATABASE_URL"]:
        raise RuntimeError(
            "TURSO_DATABASE_URL is set but empty. If you don't want to use Turso, unset the "
            "environment variable entirely instead of setting it to an empty string -- an empty "
            "value most commonly means a GitHub Actions (or similar) secret that was never added."
        )
    turso_url = os.environ.get("TURSO_DATABASE_URL")

    if turso_url:
        if libsql is None:
            raise RuntimeError(
                "TURSO_DATABASE_URL is set but the 'libsql' package isn't installed. "
                "Run: pip install libsql"
            )
        conn = libsql.connect(database=turso_url, auth_token=os.environ.get("TURSO_AUTH_TOKEN"))
    else:
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON")
        # IMPORTANT: if this file ever ends up in a cloud-synced folder
        # (OneDrive/Dropbox/Google Drive) again, SQLite's default
        # rollback-journal gets corrupted/blocked by that sync client's own
        # file locking, raising "disk I/O error" on write. journal_mode=MEMORY
        # keeps the journal in RAM instead of a second on-disk file, avoiding
        # that conflict. Tradeoff: a crash mid-write could corrupt the DB (no
        # crash-safety from the journal) -- fine for a periodically-rerun
        # batch load like this, not something you'd want for a live
        # production DB under heavier write concurrency.
        conn.execute("PRAGMA journal_mode = MEMORY")

    _migrate_legacy_single_league_schema(conn)
    for statement in _split_statements(SCHEMA_SQL):
        conn.execute(statement)
    _apply_column_migrations(conn)
    return conn


# ---------------------------------------------------------------------------
# Leagues
# ---------------------------------------------------------------------------

def get_or_create_league(
    conn,
    platform,
    slug,
    display_name=None,
    espn_league_id=None,
    espn_s2=None,
    espn_swid=None,
    sleeper_league_id=None,
):
    """slug is the stable identifier callers pass in (derived from config, or
    typed by a user in the "add a league" form) -- everything else here is
    updated in place on repeat calls, so editing credentials/display name and
    rerunning is all it takes to change them."""
    row = conn.execute("SELECT league_id FROM leagues WHERE slug = ?", (slug,)).fetchone()
    if row:
        league_id = row[0]
        conn.execute(
            """UPDATE leagues SET
                    platform = ?,
                    display_name = COALESCE(?, display_name),
                    espn_league_id = COALESCE(?, espn_league_id),
                    espn_s2 = COALESCE(?, espn_s2),
                    espn_swid = COALESCE(?, espn_swid),
                    sleeper_league_id = COALESCE(?, sleeper_league_id)
               WHERE league_id = ?""",
            (platform, display_name, espn_league_id, espn_s2, espn_swid, sleeper_league_id, league_id),
        )
    else:
        row = conn.execute(
            """INSERT INTO leagues
                    (platform, slug, display_name, espn_league_id, espn_s2, espn_swid, sleeper_league_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING league_id""",
            (platform, slug, display_name, espn_league_id, espn_s2, espn_swid, sleeper_league_id),
        ).fetchone()
        league_id = row[0]
    conn.commit()
    return league_id


def touch_last_pulled_at(conn, league_id):
    """Stamps leagues.last_pulled_at with the current time -- called once per
    league per pipeline run (see pipeline.py), regardless of whether any
    individual season's pull succeeded or failed, since even a partial run
    freshens whatever did load. Purely a "when did we last check" marker
    for the UI's "Data as of [time]" display, not a signal that anything
    actually changed."""
    conn.execute("UPDATE leagues SET last_pulled_at = datetime('now') WHERE league_id = ?", (league_id,))
    conn.commit()


def list_leagues(conn):
    rows = conn.execute(
        "SELECT league_id, platform, slug, display_name, espn_league_id, sleeper_league_id FROM leagues ORDER BY slug"
    ).fetchall()
    cols = ["league_id", "platform", "slug", "display_name", "espn_league_id", "sleeper_league_id"]
    return [dict(zip(cols, r)) for r in rows]


def set_league_season_info(conn, league_id, season, external_id, league_name, regular_season_weeks=None):
    """regular_season_weeks: pass None to leave an existing value alone
    (e.g. if a later call only knows the league name) -- COALESCE keeps
    whatever was already stored instead of clobbering it with NULL."""
    conn.execute(
        """INSERT INTO league_seasons (league_id, season, external_id, league_name, regular_season_weeks)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(league_id, season) DO UPDATE SET
                external_id = excluded.external_id,
                league_name = excluded.league_name,
                regular_season_weeks = COALESCE(excluded.regular_season_weeks, league_seasons.regular_season_weeks)""",
        (league_id, season, str(external_id) if external_id is not None else None, league_name, regular_season_weeks),
    )
    conn.commit()


def set_contest_windows(conn, league_id, season, windows):
    """
    windows: list of {"name": str, "start_week": int, "end_week": int}, in
    the order they should be displayed.

    Replaces the whole set for the league/season (delete then re-insert)
    rather than upserting by name. An upsert keyed on contest_name can't
    handle renaming a window (e.g. "Contest 1" -> "Mushroom Cup") -- since
    the name changed, it wouldn't match the old row and would just add a
    second one instead of replacing it. Full replace is simple and correct
    for a small, fully-config-driven list like this.
    """
    conn.execute("DELETE FROM contest_windows WHERE league_id = ? AND season = ?", (league_id, season))
    for i, w in enumerate(windows):
        conn.execute(
            """INSERT INTO contest_windows (league_id, season, contest_name, start_week, end_week, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (league_id, season, w["name"], w["start_week"], w["end_week"], i),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Sync state cache (e.g. Sleeper's full player list)
# ---------------------------------------------------------------------------

def get_sync_state(conn, key):
    row = conn.execute("SELECT value, updated_at FROM platform_sync_state WHERE key = ?", (key,)).fetchone()
    return (row[0], row[1]) if row else (None, None)


def set_sync_state(conn, key, value):
    conn.execute(
        """INSERT INTO platform_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
        (key, value),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Managers / teams / players
# ---------------------------------------------------------------------------

def get_or_create_manager(conn, league_id, name):
    row = conn.execute(
        "SELECT manager_id FROM managers WHERE league_id = ? AND manager_name = ?", (league_id, name)
    ).fetchone()
    if row:
        return row[0]
    row = conn.execute(
        "INSERT INTO managers (league_id, manager_name) VALUES (?, ?) RETURNING manager_id",
        (league_id, name),
    ).fetchone()
    return row[0]


def get_or_create_team(conn, league_id, season, platform_team_id, team_name, manager_id, logo_url=None):
    platform_team_id = str(platform_team_id)
    row = conn.execute(
        "SELECT team_id FROM teams WHERE league_id = ? AND season = ? AND platform_team_id = ?",
        (league_id, season, platform_team_id),
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE teams SET team_name = ?, manager_id = ?, logo_url = ? WHERE team_id = ?",
            (team_name, manager_id, logo_url, row[0]),
        )
        return row[0]
    row = conn.execute(
        """INSERT INTO teams (league_id, season, platform_team_id, team_name, manager_id, logo_url)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING team_id""",
        (league_id, season, platform_team_id, team_name, manager_id, logo_url),
    ).fetchone()
    return row[0]


def get_or_create_player(conn, platform, platform_player_id, name, position):
    if platform_player_id is not None:
        platform_player_id = str(platform_player_id)
        row = conn.execute(
            "SELECT player_id FROM players WHERE platform = ? AND platform_player_id = ?",
            (platform, platform_player_id),
        ).fetchone()
        if row:
            return row[0]
        row = conn.execute(
            """INSERT INTO players (platform, platform_player_id, player_name, position)
               VALUES (?, ?, ?, ?) RETURNING player_id""",
            (platform, platform_player_id, name, position),
        ).fetchone()
        return row[0]

    # No platform player id available -- fall back to matching on name + position
    # (within the same platform, so a same-named player on a different
    # platform's leagues doesn't collide).
    row = conn.execute(
        """SELECT player_id FROM players
           WHERE platform = ? AND player_name = ? AND position = ? AND platform_player_id IS NULL""",
        (platform, name, position),
    ).fetchone()
    if row:
        return row[0]
    row = conn.execute(
        """INSERT INTO players (platform, platform_player_id, player_name, position)
           VALUES (?, NULL, ?, ?) RETURNING player_id""",
        (platform, name, position),
    ).fetchone()
    return row[0]


def load_season(
    conn,
    league_id,
    platform,
    year,
    team_manager,
    team_name,
    player_rows,
    matchup_records,
    live_matchup_records=None,
    live_player_records=None,
    team_logo=None,
    projected_matchup_records=None,
):
    """
    league_id: internal leagues.league_id (see get_or_create_league)
    platform: 'espn' | 'sleeper' -- used to scope player dedup
    team_manager: {platform_team_id: manager_name}
    team_name: {platform_team_id: team_name}
    team_logo: {platform_team_id: logo_url}, optional -- ESPN's mTeam view
               reports one per team; Sleeper has none, so callers that don't
               have this concept can omit it (or pass {}) and every team's
               logo_url stays NULL, same as before this column existed.
    player_rows: list of dicts (must include platform_team_id and platform_player_id)
    matchup_records: list of dicts with home_platform_team_id/away_platform_team_id
                      (raw platform team ids, not names)
    live_matchup_records: same shape as matchup_records, but for the single
                      week currently in progress (if any) -- see the
                      live_matchups table's schema comment up top. Always
                      fully replaces this league/season's live_matchups rows
                      (delete then insert), including clearing them to
                      empty when this is None/[] (e.g. Sleeper pulls, which
                      don't have a live-week concept, or an ESPN pull where
                      every week is currently decided) -- so a week that WAS
                      live in a previous run and has since been decided
                      doesn't leave a stale row behind.
    live_player_records: same shape as player_rows, but for the single
                      week currently in progress (if any) -- see the
                      live_player_points table's schema comment up top.
                      Always fully replaces this league/season's
                      live_player_points rows, same convention (and same
                      reasoning) as live_matchup_records above.
    projected_matchup_records: same shape as matchup_records, but for every
                      week AFTER whichever one is live (if any) that the
                      platform still has projections for -- see the
                      projected_matchups table's schema comment up top.
                      Always fully replaces this league/season's
                      projected_matchups rows, same full-replace convention
                      (and same reasoning) as live_matchup_records above --
                      a week that WAS in this set and has since gone live or
                      been decided should stop appearing here on the very
                      next run, not linger as a stale projection alongside
                      the real data that's since taken over for it.
    """
    team_logo = team_logo or {}
    team_id_map = {}  # platform_team_id (as given) -> internal teams.team_id
    for platform_team_id, manager_name in team_manager.items():
        manager_id = get_or_create_manager(conn, league_id, manager_name)
        team_id_map[platform_team_id] = get_or_create_team(
            conn,
            league_id,
            year,
            platform_team_id,
            team_name.get(platform_team_id),
            manager_id,
            logo_url=team_logo.get(platform_team_id),
        )

    for row in player_rows:
        player_id = get_or_create_player(
            conn, platform, row.get("platform_player_id"), row["player"], row["position"]
        )
        team_id = team_id_map.get(row["platform_team_id"])
        if team_id is None:
            continue
        # The WHERE guard on the DO UPDATE makes this a true no-op (no row
        # actually rewritten) when a player's score hasn't changed since the
        # last pull -- every pipeline run recomputes every decided week's
        # player stats from scratch (see build_player_points_rows), so
        # without this guard every single row would get rewritten on every
        # run regardless of whether anything actually changed. `IS NOT`
        # (not `!=`) is required here so this behaves correctly even when
        # points is NULL on either side -- `!=` against a NULL is neither
        # true nor false in SQL, which would silently skip the update
        # forever once a row went NULL, or never stop rewriting a row that
        # was always NULL.
        conn.execute(
            """INSERT INTO weekly_player_points (season, week, team_id, player_id, points)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(season, week, team_id, player_id) DO UPDATE SET points = excluded.points
               WHERE weekly_player_points.points IS NOT excluded.points""",
            (row["season"], row["week"], team_id, player_id, row["points"]),
        )

    for m in matchup_records:
        home_team_id = team_id_map.get(m["home_platform_team_id"])
        away_team_id = (
            team_id_map.get(m["away_platform_team_id"]) if m["away_platform_team_id"] is not None else None
        )
        if home_team_id is None:
            continue
        conn.execute(
            """INSERT INTO matchups (league_id, season, week, platform_matchup_id, home_team_id, away_team_id,
                                      home_points, away_points, winner, is_bye)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(league_id, season, platform_matchup_id) DO UPDATE SET
                    home_points = excluded.home_points,
                    away_points = excluded.away_points,
                    winner = excluded.winner,
                    is_bye = excluded.is_bye""",
            (
                league_id,
                year,
                m["week"],
                str(m["matchup_id"]) if m["matchup_id"] is not None else None,
                home_team_id,
                away_team_id,
                m["home_points"],
                m["away_points"],
                m["winner"],
                int(m["is_bye"]),
            ),
        )

    # Always a full replace, never an upsert -- this table only ever holds
    # a snapshot of whatever's live *right now* for this league/season (or
    # nothing), not accumulated history. Running this on every load_season()
    # call (even when live_matchup_records is empty) is what clears a
    # previously-live week's row once it's been decided and moved over to
    # the real `matchups` table above.
    conn.execute("DELETE FROM live_matchups WHERE league_id = ? AND season = ?", (league_id, year))
    for m in live_matchup_records or []:
        home_team_id = team_id_map.get(m["home_platform_team_id"])
        away_team_id = (
            team_id_map.get(m["away_platform_team_id"]) if m.get("away_platform_team_id") is not None else None
        )
        if home_team_id is None:
            continue
        conn.execute(
            """INSERT INTO live_matchups (league_id, season, week, home_team_id, away_team_id,
                                            home_points, away_points, is_bye, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (
                league_id,
                year,
                m["week"],
                home_team_id,
                away_team_id,
                m["home_points"],
                m["away_points"],
                int(m["is_bye"]),
            ),
        )

    # Same full-replace convention as live_matchups above, just at
    # per-player granularity -- see live_player_points' schema comment.
    # Player/team lookups reuse team_id_map (already built above) and
    # get_or_create_player, same as the decided player_rows loop, so a
    # player who's only ever appeared in a live (not-yet-decided) week
    # still gets created normally.
    conn.execute("DELETE FROM live_player_points WHERE league_id = ? AND season = ?", (league_id, year))
    for row in live_player_records or []:
        player_id = get_or_create_player(
            conn, platform, row.get("platform_player_id"), row["player"], row["position"]
        )
        team_id = team_id_map.get(row["platform_team_id"])
        if team_id is None:
            continue
        conn.execute(
            """INSERT INTO live_player_points (league_id, season, week, team_id, player_id, points, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))""",
            (league_id, row["season"], row["week"], team_id, player_id, row["points"]),
        )

    # Same full-replace convention as live_matchups above, just spanning
    # every remaining week the platform still has projections for instead
    # of a single live one -- see projected_matchups' schema comment. Runs
    # on every call (even when projected_matchup_records is empty) so a
    # week that's since gone live or been decided doesn't linger here.
    conn.execute("DELETE FROM projected_matchups WHERE league_id = ? AND season = ?", (league_id, year))
    for m in projected_matchup_records or []:
        home_team_id = team_id_map.get(m["home_platform_team_id"])
        away_team_id = (
            team_id_map.get(m["away_platform_team_id"]) if m.get("away_platform_team_id") is not None else None
        )
        if home_team_id is None:
            continue
        conn.execute(
            """INSERT INTO projected_matchups (league_id, season, week, home_team_id, away_team_id,
                                                 home_points, away_points, is_bye, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (
                league_id,
                year,
                m["week"],
                home_team_id,
                away_team_id,
                m["home_points"],
                m["away_points"],
                int(m["is_bye"]),
            ),
        )

    conn.commit()
