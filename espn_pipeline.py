"""
ESPN Fantasy Football data pipeline.

Pulls, for one or more seasons of a given league:
  1. Weekly points-for by player (starting lineup only) -- includes manager,
     team, player name, and position, so you can filter/pivot by player or
     position to see where each manager's points came from
  1b. Weekly points-for by manager (starting lineup total, one row per
      manager per week) -- kept as a convenience summary
  2. Schedule / matchup pairings (home manager vs away manager)
  3. Weekly points-for by manager, broken out per matchup

...and writes everything to (a) a single .xlsx workbook (one set of sheets per
season, plus "All Seasons" combined sheets if more than one season is pulled)
and/or (b) a normalized SQLite database (see db.py for schema) meant to back
a web frontend. Both outputs run off the same fetch -- pick one, or get both.

Usage
-----
1. Fill in config.json (league_id, espn_s2, swid, years, output, sqlite).
2. Run:  python espn_pipeline.py
   or override config from the command line, e.g.:
   python espn_pipeline.py --league-id 1083280 --years 2024 2025 --config config.json
   python espn_pipeline.py --config config.json --output "" --sqlite espn_ff.db   # DB only, skip Excel
   python espn_pipeline.py --config config.json --sqlite ""                       # Excel only, skip DB

Notes
-----
- espn_s2 / swid are only required for private leagues. Leave them blank ("")
  for a public league.
- "Points for (starting lineup only)" comes directly from ESPN's own weekly
  team score (home.totalPoints / away.totalPoints in the mMatchupScore view),
  which is the sum of the starting lineup only -- bench/IR points are never
  included in that number. Player-level points exclude anyone parked in a
  BE (bench) or IR slot that week.
- Only weeks that have actually been played (winner != "UNDECIDED") are
  included in the output.
- Player-level detail requires one extra API call per played week (to pull
  that week's boxscore/roster snapshot), so pulling several seasons can take
  a little while.
- DB loads are upserts, so re-running the pipeline for a season you've
  already loaded updates rows in place instead of duplicating them.
- If this folder is synced via a cloud drive (OneDrive/Dropbox/Google Drive),
  see the comment in db.py's connect() -- the default SQLite journal mode
  conflicts with those sync clients and raises "disk I/O error", so we use
  journal_mode=MEMORY here.
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
import requests

CURRENT_API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{league_id}"
HISTORY_API = "https://fantasy.espn.com/apis/v3/games/ffl/leagueHistory/{league_id}"

VIEWS = ["mTeam", "mMatchupScore", "mSettings", "mRoster"]
BOXSCORE_VIEWS = ["mBoxscore", "mMatchupScore", "mTeam"]

# ESPN lineup slot IDs that mean "did not count toward the team's score" this week.
BENCH_SLOT_IDS = {20, 21}  # 20 = BE (bench), 21 = IR

# ESPN player defaultPositionId -> human-readable position.
PRO_POSITION_MAP = {
    1: "QB",
    2: "RB",
    3: "WR",
    4: "TE",
    5: "K",
    9: "DE",
    10: "LB",
    11: "DL",
    12: "CB",
    13: "S",
    14: "DB",
    16: "D/ST",
}


def fetch_league_json(league_id, year, espn_s2="", swid=""):
    """Fetch raw league JSON for a given season. Tries the current-season
    endpoint first (works for 2018+), falls back to the leagueHistory
    endpoint for older seasons."""
    cookies = {}
    if espn_s2:
        cookies["espn_s2"] = espn_s2
    if swid:
        cookies["SWID"] = swid
    headers = {"User-Agent": "Mozilla/5.0"}

    url = CURRENT_API.format(year=year, league_id=league_id)
    resp = requests.get(url, params={"view": VIEWS}, cookies=cookies, headers=headers, timeout=30)

    if resp.status_code == 200:
        return resp.json()

    # Fallback: historical endpoint (needed for pre-2018 seasons, and
    # occasionally for completed older seasons on the current host).
    url = HISTORY_API.format(league_id=league_id)
    resp = requests.get(
        url, params={"seasonId": year, "view": VIEWS}, cookies=cookies, headers=headers, timeout=30
    )
    if resp.status_code == 200:
        data = resp.json()
        # leagueHistory returns a list of season snapshots
        return data[0] if isinstance(data, list) else data

    raise RuntimeError(
        f"ESPN API request failed for league {league_id}, year {year} "
        f"(status {resp.status_code}). Check league ID, year, and that "
        f"espn_s2/SWID are current (they expire periodically) if private."
    )


def fetch_week_boxscore(league_id, year, week, espn_s2="", swid=""):
    """Fetch the roster/boxscore snapshot for a single scoring period (week).
    ESPN only returns individual-player detail for the specific week you ask
    for, so this has to be called once per played week."""
    cookies = {}
    if espn_s2:
        cookies["espn_s2"] = espn_s2
    if swid:
        cookies["SWID"] = swid
    headers = {"User-Agent": "Mozilla/5.0"}

    url = CURRENT_API.format(year=year, league_id=league_id)
    params = {"view": BOXSCORE_VIEWS, "scoringPeriodId": week}
    resp = requests.get(url, params=params, cookies=cookies, headers=headers, timeout=30)

    if resp.status_code != 200:
        # Fallback for older seasons served off the leagueHistory endpoint.
        url = HISTORY_API.format(league_id=league_id)
        params = {"seasonId": year, "view": BOXSCORE_VIEWS, "scoringPeriodId": week}
        resp = requests.get(url, params=params, cookies=cookies, headers=headers, timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(f"Boxscore request failed for {year} week {week} (status {resp.status_code}).")
        data = resp.json()
        return data[0] if isinstance(data, list) else data

    return resp.json()


def _player_week_points(player, week):
    """Pull the actual (not projected) applied point total for a player in a
    given scoring period from their stats list."""
    for stat in player.get("stats", []):
        if stat.get("scoringPeriodId") == week and stat.get("statSourceId") == 0:
            return stat.get("appliedTotal")
    return None


def extract_player_rows(week_raw, year, week, team_manager, team_name):
    """Parse a single week's boxscore payload into one row per starting-lineup
    player (bench/IR excluded)."""
    rows = []
    for m in week_raw.get("schedule", []):
        if m.get("matchupPeriodId") != week:
            continue
        for side in ("home", "away"):
            team_data = m.get(side)
            if not team_data:
                continue
            team_id = team_data.get("teamId")
            roster = team_data.get("rosterForCurrentScoringPeriod") or {}
            for entry in roster.get("entries", []):
                slot_id = entry.get("lineupSlotId")
                if slot_id in BENCH_SLOT_IDS:
                    continue  # not part of the starting lineup this week

                player = entry.get("playerPoolEntry", {}).get("player", {})
                points = _player_week_points(player, week)
                if points is None:
                    points = entry.get("playerPoolEntry", {}).get("appliedStatTotal")

                rows.append(
                    {
                        "season": year,
                        "week": week,
                        "manager": team_manager.get(team_id, "Unknown"),
                        "team": team_name.get(team_id),
                        "player": player.get("fullName", "Unknown"),
                        "position": PRO_POSITION_MAP.get(player.get("defaultPositionId"), "UNK"),
                        "points": round(points, 2) if points is not None else None,
                        # kept for DB loading (not shown in the Excel sheet)
                        "espn_team_id": team_id,
                        "espn_player_id": player.get("id") or entry.get("playerId"),
                    }
                )
    return rows


def build_manager_map(raw):
    """Map team_id -> manager display name, and team_id -> team name."""
    members = {m["id"]: m for m in raw.get("members", [])}

    def member_name(guid):
        m = members.get(guid)
        if not m:
            return "Unknown"
        name = m.get("displayName")
        if name:
            return name
        full = f"{m.get('firstName', '')} {m.get('lastName', '')}".strip()
        return full or "Unknown"

    team_manager = {}
    team_name = {}
    for t in raw.get("teams", []):
        tid = t["id"]
        owner_guids = t.get("owners") or ([t["primaryOwner"]] if t.get("primaryOwner") else [])
        managers = [member_name(g) for g in owner_guids] or ["Unknown"]
        team_manager[tid] = " / ".join(managers)
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
        team_name[tid] = name or f"Team {tid}"

    return team_manager, team_name


def build_dataframes(raw, year, team_manager, team_name):
    weekly_by_manager_rows = []
    schedule_rows = []
    matchup_points_rows = []
    matchup_records = []  # raw form (ESPN team ids, not names) -- used for DB loading

    for m in raw.get("schedule", []):
        if m.get("winner") == "UNDECIDED":
            continue  # not played yet

        week = m.get("matchupPeriodId")
        home = m.get("home") or {}
        away = m.get("away") or {}
        home_id = home.get("teamId")
        away_id = away.get("teamId")
        home_pts = home.get("totalPoints")
        away_pts = away.get("totalPoints")
        is_bye = away_id is None

        home_mgr = team_manager.get(home_id, "Unknown")
        away_mgr = team_manager.get(away_id, "BYE") if not is_bye else "BYE"
        matchup_id = m.get("id")

        # 1) weekly points by manager (team total, starting lineup only)
        weekly_by_manager_rows.append(
            {"season": year, "week": week, "manager": home_mgr, "team": team_name.get(home_id), "points": home_pts}
        )
        if not is_bye:
            weekly_by_manager_rows.append(
                {"season": year, "week": week, "manager": away_mgr, "team": team_name.get(away_id), "points": away_pts}
            )

        # 2) schedule (home vs away)
        schedule_rows.append(
            {
                "season": year,
                "week": week,
                "matchup_id": matchup_id,
                "home_manager": home_mgr,
                "away_manager": away_mgr,
                "home_team": team_name.get(home_id),
                "away_team": team_name.get(away_id) if not is_bye else "BYE",
                "is_bye": is_bye,
            }
        )

        # 3) points by manager, per matchup
        winner = m.get("winner")
        matchup_points_rows.append(
            {
                "season": year,
                "week": week,
                "matchup_id": matchup_id,
                "home_manager": home_mgr,
                "home_points": home_pts,
                "away_manager": away_mgr,
                "away_points": away_pts if not is_bye else None,
                "winner": "HOME" if winner == "HOME" else ("AWAY" if winner == "AWAY" else ("TIE" if winner == "TIE" else "BYE")),
            }
        )

        matchup_records.append(
            {
                "week": week,
                "matchup_id": matchup_id,
                "home_espn_team_id": home_id,
                "away_espn_team_id": away_id,
                "home_points": home_pts,
                "away_points": away_pts if not is_bye else None,
                "winner": "HOME" if winner == "HOME" else ("AWAY" if winner == "AWAY" else ("TIE" if winner == "TIE" else "BYE")),
                "is_bye": is_bye,
            }
        )

    weekly_by_manager_df = pd.DataFrame(weekly_by_manager_rows).sort_values(["week", "manager"]).reset_index(drop=True)
    schedule_df = pd.DataFrame(schedule_rows).sort_values(["week", "matchup_id"]).reset_index(drop=True)
    matchup_points_df = pd.DataFrame(matchup_points_rows).sort_values(["week", "matchup_id"]).reset_index(drop=True)

    return weekly_by_manager_df, schedule_df, matchup_points_df, matchup_records


def build_player_points_rows(league_id, year, weeks, team_manager, team_name, espn_s2, swid):
    """Fetch every played week's boxscore and return one row per starting
    player per week. Includes espn_team_id/espn_player_id (used for DB
    loading) in addition to the display fields used in the Excel sheet."""
    rows = []
    for week in weeks:
        week_raw = fetch_week_boxscore(league_id, year, week, espn_s2, swid)
        rows.extend(extract_player_rows(week_raw, year, week, team_manager, team_name))
    rows.sort(key=lambda r: (r["week"], r["manager"], r["position"], r["player"]))
    return rows


PLAYER_DISPLAY_COLUMNS = ["season", "week", "manager", "team", "player", "position", "points"]


def player_rows_to_df(rows):
    if not rows:
        return pd.DataFrame(columns=PLAYER_DISPLAY_COLUMNS)
    return pd.DataFrame(rows)[PLAYER_DISPLAY_COLUMNS]


def run_pipeline(
    league_id,
    years,
    espn_s2,
    swid,
    output_path=None,
    sqlite_path=None,
    contests_config=None,
    regular_season_weeks_config=None,
):
    if not output_path and not sqlite_path:
        raise ValueError("Need at least one of output_path (xlsx) or sqlite_path (db) to write to.")

    all_player, all_weekly_by_mgr, all_schedule, all_matchup = [], [], [], []
    per_season = {}

    conn = None
    if sqlite_path:
        import db as db_module

        conn = db_module.connect(sqlite_path)

    for year in years:
        print(f"Fetching {year} season...")
        raw = fetch_league_json(league_id, year, espn_s2, swid)
        league_name = raw.get("settings", {}).get("name")
        team_manager, team_name = build_manager_map(raw)
        weekly_by_manager_df, schedule_df, matchup_points_df, matchup_records = build_dataframes(
            raw, year, team_manager, team_name
        )

        played_weeks = sorted(schedule_df["week"].unique().tolist()) if not schedule_df.empty else []
        print(f"  Fetching player-level boxscores for {len(played_weeks)} played week(s)...")
        player_rows = build_player_points_rows(league_id, year, played_weeks, team_manager, team_name, espn_s2, swid)
        player_df = player_rows_to_df(player_rows)

        per_season[year] = (player_df, weekly_by_manager_df, schedule_df, matchup_points_df)
        all_player.append(player_df)
        all_weekly_by_mgr.append(weekly_by_manager_df)
        all_schedule.append(schedule_df)
        all_matchup.append(matchup_points_df)
        print(
            f"  {len(player_df)} player-week rows, {len(weekly_by_manager_df)} weekly-by-manager rows, "
            f"{len(schedule_df)} schedule rows, {len(matchup_points_df)} matchup rows"
        )

        if conn is not None:
            db_module.load_season(conn, year, team_manager, team_name, player_rows, matchup_records)
            reg_season_weeks = (regular_season_weeks_config or {}).get(year) or (
                regular_season_weeks_config or {}
            ).get(str(year))
            db_module.set_league_info(conn, year, league_id, league_name, reg_season_weeks)
            print(f"  Loaded {year} into {sqlite_path}")

            windows = (contests_config or {}).get(year) or (contests_config or {}).get(str(year))
            if windows:
                db_module.set_contest_windows(conn, year, windows)
                print(f"  Set {len(windows)} contest window(s) for {year}")

    if conn is not None:
        conn.close()

    if output_path:
        with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
            if len(years) > 1:
                pd.concat(all_player, ignore_index=True).to_excel(writer, sheet_name="Weekly Points (All)", index=False)
                pd.concat(all_weekly_by_mgr, ignore_index=True).to_excel(
                    writer, sheet_name="Weekly Pts by Mgr (All)"[:31], index=False
                )
                pd.concat(all_schedule, ignore_index=True).to_excel(writer, sheet_name="Schedule (All)", index=False)
                pd.concat(all_matchup, ignore_index=True).to_excel(writer, sheet_name="Matchup Points (All)", index=False)

            for year, (player_df, weekly_by_manager_df, schedule_df, matchup_points_df) in per_season.items():
                suffix = f" {year}" if len(years) > 1 else ""
                player_df.to_excel(writer, sheet_name=f"Weekly Points{suffix}"[:31], index=False)
                weekly_by_manager_df.to_excel(writer, sheet_name=f"Weekly Pts by Mgr{suffix}"[:31], index=False)
                schedule_df.to_excel(writer, sheet_name=f"Schedule{suffix}"[:31], index=False)
                matchup_points_df.to_excel(writer, sheet_name=f"Matchup Points{suffix}"[:31], index=False)

        print(f"Wrote {output_path}")


def load_config(path):
    if not Path(path).exists():
        return {}
    with open(path) as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description="Pull ESPN Fantasy Football data to an Excel workbook.")
    parser.add_argument("--config", default="config.json", help="Path to config JSON file")
    parser.add_argument("--league-id", type=int, help="ESPN league ID")
    parser.add_argument("--years", type=int, nargs="+", help="Season year(s) to pull, e.g. --years 2023 2024 2025")
    parser.add_argument("--espn-s2", help="espn_s2 cookie value (private leagues only)")
    parser.add_argument("--swid", help="SWID cookie value (private leagues only)")
    parser.add_argument("--output", help="Output .xlsx path (pass an empty string to skip the Excel export)")
    parser.add_argument("--sqlite", help="Output SQLite .db path (pass an empty string to skip the DB load)")
    args = parser.parse_args()

    cfg = load_config(args.config)

    league_id = args.league_id or cfg.get("league_id")
    years = args.years or cfg.get("years")
    espn_s2 = args.espn_s2 or cfg.get("espn_s2", "")
    swid = args.swid or cfg.get("swid", "")
    output = args.output if args.output is not None else cfg.get("output", f"espn_ff_{league_id}.xlsx")
    sqlite_path = args.sqlite if args.sqlite is not None else cfg.get("sqlite", f"espn_ff_{league_id}.db")
    contests_config = cfg.get("contests", {})
    regular_season_weeks_config = cfg.get("regular_season_weeks", {})

    if not league_id or not years:
        print("league_id and years are required (via config.json or CLI flags).", file=sys.stderr)
        sys.exit(1)

    run_pipeline(
        league_id,
        years,
        espn_s2,
        swid,
        output or None,
        sqlite_path or None,
        contests_config,
        regular_season_weeks_config,
    )


if __name__ == "__main__":
    main()
