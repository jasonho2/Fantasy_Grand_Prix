"""
SQLite schema + loader for ESPN Fantasy Football data.

Design: normalized so a frontend can run flexible queries (points by
position, head-to-head history, season trends, etc.) without re-parsing
Excel. Loads are upserts, so re-running the pipeline for a season you've
already loaded updates rows in place instead of duplicating them.

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
this file, or in espn_pipeline.py, needs to change to switch backends.

Schema
------
managers                one row per real person (identified by ESPN display name)
teams                   one row per (season, ESPN team id) -- links a team to its manager
players                 one row per NFL player (deduped by ESPN player id when available)
weekly_player_points    one row per starting-lineup player per week
matchups                one row per matchup per week (home vs away, with both scores)

weekly_manager_points   VIEW: sums `weekly_player_points` per (season, week,
                        team_id) to get the manager's weekly total, so it
                        isn't stored twice. Deliberately NOT derived from
                        matchups.home_points/away_points -- ESPN's
                        season-level schedule can be missing a matchup entry
                        for a given week (seen with consolation-bracket
                        games during playoff weeks), which would silently
                        drop that team for that week. See the comment above
                        the view's SQL for details.
leagues                 one row per season -- ESPN's league display name
                        (e.g. for the "<league name> Grand Prix" page title).
contest_windows         one row per side-contest window (e.g. weeks 1-4,
                        5-8, 9-12, 13-17) for a season. Not hardcoded --
                        windows vary by season/commissioner, so they're
                        defined in config.json's "contests" section and
                        loaded via set_contest_windows(). A manager's score
                        in a contest is just the sum of weekly_manager_points
                        over that window's weeks (computed at query time,
                        not stored).
"""

import os
import sqlite3

try:
    import libsql  # Turso's Python SDK -- only needed if TURSO_DATABASE_URL is set
except ImportError:
    libsql = None

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS managers (
    manager_id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    espn_team_id INTEGER NOT NULL,
    team_name TEXT,
    manager_id INTEGER NOT NULL REFERENCES managers(manager_id),
    UNIQUE(season, espn_team_id)
);

CREATE TABLE IF NOT EXISTS players (
    player_id INTEGER PRIMARY KEY AUTOINCREMENT,
    espn_player_id INTEGER UNIQUE,
    player_name TEXT NOT NULL,
    position TEXT
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
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    espn_matchup_id INTEGER,
    home_team_id INTEGER NOT NULL REFERENCES teams(team_id),
    away_team_id INTEGER REFERENCES teams(team_id),
    home_points REAL,
    away_points REAL,
    winner TEXT,
    is_bye INTEGER NOT NULL DEFAULT 0,
    UNIQUE(season, espn_matchup_id)
);
CREATE INDEX IF NOT EXISTS idx_matchups_season_week ON matchups(season, week);

-- Derived from weekly_player_points (sum of that team's starters), NOT from
-- matchups.home_points/away_points. Discovered via real league data: ESPN's
-- season-level schedule can be missing a matchup entry for a given week
-- (seen with consolation-bracket games during playoff weeks), which would
-- silently drop that team from this view for that week if it were built
-- from matchups instead. weekly_player_points is populated from each team's
-- boxscore directly and stays complete even when that happens, so every
-- team appears every week it fielded a lineup, regardless of whether ESPN's
-- schedule listing shows a matchup for it.
DROP VIEW IF EXISTS weekly_manager_points;
CREATE VIEW weekly_manager_points AS
    SELECT season, week, team_id, ROUND(SUM(points), 2) AS points
    FROM weekly_player_points
    GROUP BY season, week, team_id;

CREATE TABLE IF NOT EXISTS leagues (
    season INTEGER PRIMARY KEY,
    espn_league_id INTEGER NOT NULL,
    league_name TEXT,
    -- Length of the regular season in weeks. Drives the Season Leaderboard
    -- (standings + regular-season points trend are scoped to weeks
    -- 1..regular_season_weeks) and the separate playoff points trend
    -- (regular_season_weeks+1..latest played week). Configured per season
    -- in config.json, same reasoning as contest_windows -- this varies by
    -- season/league setup and ESPN doesn't expose it in a field reliable
    -- enough to trust auto-detecting.
    regular_season_weeks INTEGER
);

CREATE TABLE IF NOT EXISTS contest_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    contest_name TEXT NOT NULL,
    start_week INTEGER NOT NULL,
    end_week INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    UNIQUE(season, contest_name)
);
CREATE INDEX IF NOT EXISTS idx_contest_windows_season ON contest_windows(season);
"""


def _split_statements(sql):
    """Split a script into individual statements. Only sqlite3 supports
    conn.executescript(); libsql's execute() runs one statement at a time,
    so we split and loop -- this works identically on both backends."""
    return [s.strip() for s in sql.split(";") if s.strip()]


# Columns added to existing tables after they first shipped. "CREATE TABLE
# IF NOT EXISTS" is a no-op once the table already exists, so adding a
# column to SCHEMA_SQL alone does nothing for databases created before that
# change -- this list is the migration path for those. Safe to run every
# connect(): each entry is only applied if the column is actually missing.
COLUMN_MIGRATIONS = [
    ("leagues", "regular_season_weeks", "INTEGER"),
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

    for statement in _split_statements(SCHEMA_SQL):
        conn.execute(statement)
    _apply_column_migrations(conn)
    return conn


def get_or_create_manager(conn, name):
    row = conn.execute("SELECT manager_id FROM managers WHERE manager_name = ?", (name,)).fetchone()
    if row:
        return row[0]
    row = conn.execute(
        "INSERT INTO managers (manager_name) VALUES (?) RETURNING manager_id", (name,)
    ).fetchone()
    return row[0]


def get_or_create_team(conn, season, espn_team_id, team_name, manager_id):
    row = conn.execute(
        "SELECT team_id FROM teams WHERE season = ? AND espn_team_id = ?", (season, espn_team_id)
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE teams SET team_name = ?, manager_id = ? WHERE team_id = ?", (team_name, manager_id, row[0])
        )
        return row[0]
    row = conn.execute(
        """INSERT INTO teams (season, espn_team_id, team_name, manager_id)
           VALUES (?, ?, ?, ?) RETURNING team_id""",
        (season, espn_team_id, team_name, manager_id),
    ).fetchone()
    return row[0]


def get_or_create_player(conn, espn_player_id, name, position):
    if espn_player_id is not None:
        row = conn.execute("SELECT player_id FROM players WHERE espn_player_id = ?", (espn_player_id,)).fetchone()
        if row:
            return row[0]
        row = conn.execute(
            """INSERT INTO players (espn_player_id, player_name, position)
               VALUES (?, ?, ?) RETURNING player_id""",
            (espn_player_id, name, position),
        ).fetchone()
        return row[0]

    # No ESPN player id available -- fall back to matching on name + position.
    row = conn.execute(
        "SELECT player_id FROM players WHERE player_name = ? AND position = ? AND espn_player_id IS NULL",
        (name, position),
    ).fetchone()
    if row:
        return row[0]
    row = conn.execute(
        """INSERT INTO players (espn_player_id, player_name, position)
           VALUES (NULL, ?, ?) RETURNING player_id""",
        (name, position),
    ).fetchone()
    return row[0]


def set_league_info(conn, season, espn_league_id, league_name, regular_season_weeks=None):
    """regular_season_weeks: pass None to leave an existing value alone
    (e.g. if a later call only knows the league name) -- COALESCE keeps
    whatever was already stored instead of clobbering it with NULL."""
    conn.execute(
        """INSERT INTO leagues (season, espn_league_id, league_name, regular_season_weeks)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(season) DO UPDATE SET
                espn_league_id = excluded.espn_league_id,
                league_name = excluded.league_name,
                regular_season_weeks = COALESCE(excluded.regular_season_weeks, leagues.regular_season_weeks)""",
        (season, espn_league_id, league_name, regular_season_weeks),
    )
    conn.commit()


def set_contest_windows(conn, season, windows):
    """
    windows: list of {"name": str, "start_week": int, "end_week": int}, in
    the order they should be displayed. Upserts, so editing config.json and
    rerunning updates the windows in place rather than duplicating them.
    Windows removed from config.json are NOT auto-deleted here (safer
    default) -- delete stale rows manually if a season's contest plan changes.
    """
    for i, w in enumerate(windows):
        conn.execute(
            """INSERT INTO contest_windows (season, contest_name, start_week, end_week, sort_order)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(season, contest_name) DO UPDATE SET
                    start_week = excluded.start_week,
                    end_week = excluded.end_week,
                    sort_order = excluded.sort_order""",
            (season, w["name"], w["start_week"], w["end_week"], i),
        )
    conn.commit()


def load_season(conn, year, team_manager, team_name, player_rows, matchup_records):
    """
    team_manager: {espn_team_id: manager_name}
    team_name: {espn_team_id: team_name}
    player_rows: list of dicts from espn_pipeline.build_player_points_rows
                 (must include espn_team_id and espn_player_id)
    matchup_records: list of dicts from espn_pipeline.build_dataframes'
                      4th return value (raw ESPN team ids, not names)
    """
    team_id_map = {}  # espn_team_id -> internal teams.team_id
    for espn_team_id, manager_name in team_manager.items():
        manager_id = get_or_create_manager(conn, manager_name)
        team_id_map[espn_team_id] = get_or_create_team(
            conn, year, espn_team_id, team_name.get(espn_team_id), manager_id
        )

    for row in player_rows:
        player_id = get_or_create_player(conn, row.get("espn_player_id"), row["player"], row["position"])
        team_id = team_id_map.get(row["espn_team_id"])
        if team_id is None:
            continue
        conn.execute(
            """INSERT INTO weekly_player_points (season, week, team_id, player_id, points)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(season, week, team_id, player_id) DO UPDATE SET points = excluded.points""",
            (row["season"], row["week"], team_id, player_id, row["points"]),
        )

    for m in matchup_records:
        home_team_id = team_id_map.get(m["home_espn_team_id"])
        away_team_id = (
            team_id_map.get(m["away_espn_team_id"]) if m["away_espn_team_id"] is not None else None
        )
        if home_team_id is None:
            continue
        conn.execute(
            """INSERT INTO matchups (season, week, espn_matchup_id, home_team_id, away_team_id,
                                      home_points, away_points, winner, is_bye)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(season, espn_matchup_id) DO UPDATE SET
                    home_points = excluded.home_points,
                    away_points = excluded.away_points,
                    winner = excluded.winner,
                    is_bye = excluded.is_bye""",
            (
                year,
                m["week"],
                m["matchup_id"],
                home_team_id,
                away_team_id,
                m["home_points"],
                m["away_points"],
                m["winner"],
                int(m["is_bye"]),
            ),
        )

    conn.commit()
