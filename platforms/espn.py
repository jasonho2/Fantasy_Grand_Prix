"""
ESPN puller. See platforms/__init__.py for the interface contract
(resolve_years / pull_season) this module implements.

Ported from the original single-league espn_pipeline.py, with field names
generalized (espn_team_id -> platform_team_id, espn_player_id ->
platform_player_id) so the loader code in db.py doesn't need to know which
platform a row came from.
"""

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

PLATFORM = "espn"


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
                        "platform_team_id": team_id,
                        "platform_player_id": player.get("id") or entry.get("playerId"),
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


def build_matchup_records(raw, year, team_manager):
    """Returns (matchup_records, played_weeks). Only weeks that have
    actually been played (winner != "UNDECIDED") are included."""
    matchup_records = []
    weeks = set()
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
        winner = m.get("winner")

        weeks.add(week)
        matchup_records.append(
            {
                "week": week,
                "matchup_id": m.get("id"),
                "home_platform_team_id": home_id,
                "away_platform_team_id": away_id if not is_bye else None,
                "home_points": home_pts,
                "away_points": away_pts if not is_bye else None,
                "winner": "HOME" if winner == "HOME" else ("AWAY" if winner == "AWAY" else ("TIE" if winner == "TIE" else "BYE")),
                "is_bye": is_bye,
            }
        )
    return matchup_records, sorted(weeks)


def build_player_points_rows(league_id, year, weeks, team_manager, team_name, espn_s2, swid):
    """Fetch every played week's boxscore and return one row per starting
    player per week."""
    rows = []
    for week in weeks:
        week_raw = fetch_week_boxscore(league_id, year, week, espn_s2, swid)
        rows.extend(extract_player_rows(week_raw, year, week, team_manager, team_name))
    rows.sort(key=lambda r: (r["week"], r["manager"], r["position"], r["player"]))
    return rows


def resolve_years(conn, league_config, years):
    """ESPN reuses the same league id every season, so every requested year
    maps to it -- there's no lookup to do. `conn` is accepted for interface
    parity with other platforms but unused here."""
    league_id = league_config["espn_league_id"]
    return {year: league_id for year in years}


def pull_season(conn, league_config, year, external_season_id):
    """`conn` is accepted for interface parity with platforms/sleeper.py but
    unused here -- ESPN doesn't need any database-backed caching."""
    espn_s2 = league_config.get("espn_s2", "") or ""
    swid = league_config.get("espn_swid", "") or ""

    raw = fetch_league_json(external_season_id, year, espn_s2, swid)
    league_name = raw.get("settings", {}).get("name")
    team_manager, team_name = build_manager_map(raw)
    matchup_records, played_weeks = build_matchup_records(raw, year, team_manager)
    player_rows = build_player_points_rows(
        external_season_id, year, played_weeks, team_manager, team_name, espn_s2, swid
    )

    return {
        "platform": PLATFORM,
        "external_id": external_season_id,
        "league_name": league_name,
        "team_manager": team_manager,
        "team_name": team_name,
        "player_rows": player_rows,
        "matchup_records": matchup_records,
    }
