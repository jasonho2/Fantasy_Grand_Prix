"""
ESPN puller. See platforms/__init__.py for the interface contract
(resolve_years / pull_season) this module implements.

Ported from the original single-league espn_pipeline.py, with field names
generalized (espn_team_id -> platform_team_id, espn_player_id ->
platform_player_id) so the loader code in db.py doesn't need to know which
platform a row came from.
"""

import sys

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

# How far out (in absolute week number) to keep asking ESPN for projected
# scores when building the "Projected Finish" Contests view -- deliberately
# tied to this app's own Grand Prix bounds (the longest supported cup
# structure ends at week 16, see web/lib/scoring.js's DEFAULT_CUP_WEEKS/
# CUP_WEEK_SETS) rather than the NFL's actual season length (which runs
# further, into playoff weeks this app's scoring never looks at). ESPN
# itself won't have real projections populated that far ahead early in the
# season anyway -- see the "skip a week with no real projections yet"
# comment in pull_season -- so this is a ceiling, not a promise every week
# up to it will actually have usable data.
MAX_PROJECTED_WEEK = 16


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


def _player_week_points(player, week, stat_source_id=0):
    """Pull a player's point total for a given scoring period from their
    stats list. statSourceId 0 (the default) is the actual applied total;
    1 is the platform's own projection for that same player/week -- same
    stats array either way, just a different entry in it. Returns None if
    that scoring period/source combination isn't present at all (e.g. a
    future week ESPN hasn't computed a projection for yet)."""
    for stat in player.get("stats", []):
        if stat.get("scoringPeriodId") == week and stat.get("statSourceId") == stat_source_id:
            return stat.get("appliedTotal")
    return None


def _blended_player_week_points(player, week):
    """A player's actual score if their game has already been played (or
    started) this week -- i.e. a statSourceId=0 entry exists for this
    scoringPeriodId, even if its value is 0 (a played game that scored
    nothing is still "played", not "hasn't happened yet") -- otherwise
    their statSourceId=1 projection for the same week. Used ONLY to fill in
    the live week's own contribution to "Projected Finish" (see
    pull_season): "points already earned, plus this platform's own
    projection for anyone who hasn't played yet" is exactly what a viewer
    means by a live week's projected total, and it's also what ESPN's own
    site shows as your team's "current" score during a live week -- a
    blend, not pure actual. The real leaderboard's live-week totals
    (live_matchup_records/live_player_rows in pull_season) deliberately
    keep using plain actual points instead (via extract_player_rows'
    default stat_source_id=0, no blending) -- only Projected Finish, via
    projected_matchups, ever sees this blended number.

    (An earlier version of this fix instead let extract_player_rows fall
    back to a player's appliedStatTotal for a pure statSourceId=1 read on
    FUTURE weeks, on the theory that many players were missing a dedicated
    projection entry there. Comparing real numbers against ESPN's own
    displayed projections showed that theory was wrong -- future-week
    projections were already accurate -- and that fallback measurably
    made a couple of players' numbers worse, so it's been reverted below.
    The entire gap a user reported turned out to be the live week's
    actual-vs-blended difference, which this function fixes instead.)
    """
    actual = _player_week_points(player, week, stat_source_id=0)
    if actual is not None:
        return actual
    return _player_week_points(player, week, stat_source_id=1)


def extract_player_rows(week_raw, year, week, team_manager, team_name, stat_source_id=0, points_fn=None):
    """Parse a single week's boxscore payload into one row per starting-lineup
    player (bench/IR excluded). `stat_source_id` selects actual (0, default)
    vs. projected (1) points -- see _player_week_points. `points_fn`, if
    given, overrides stat_source_id entirely and is called as
    points_fn(player, week) instead -- used for a blended actual-or-
    projected read (see _blended_player_week_points) where a single
    statSourceId can't express "prefer actual, fall back to projected."
    """
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
                if points_fn is not None:
                    points = points_fn(player, week)
                else:
                    points = _player_week_points(player, week, stat_source_id)
                if points is None and stat_source_id == 0 and points_fn is None:
                    # Fallback only applies to a plain actual (not
                    # projected, not blended) read -- appliedStatTotal
                    # reflects whatever ESPN currently treats as "the"
                    # total for this roster entry, which is only a safe
                    # stand-in for the real statSourceId=0 lookup above,
                    # not necessarily a specific projection.
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
    """Map team_id -> manager display name, team_id -> team name, and
    team_id -> logo URL.

    The logo comes straight from ESPN's mTeam view (t["logo"]) -- a CDN URL
    to either the manager's uploaded team image or ESPN's default avatar.
    ESPN always sends *something* here (falls back to a generic default
    avatar image if the manager never set a custom one), so this is treated
    as present-or-absent per team rather than validated further; the
    frontend still needs its own fallback for teams pulled before this
    field existed (logo_url NULL in the DB) or any future response shape
    that omits it.
    """
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
    team_logo = {}
    for t in raw.get("teams", []):
        tid = t["id"]
        owner_guids = t.get("owners") or ([t["primaryOwner"]] if t.get("primaryOwner") else [])
        managers = [member_name(g) for g in owner_guids] or ["Unknown"]
        team_manager[tid] = " / ".join(managers)
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
        team_name[tid] = name or f"Team {tid}"
        team_logo[tid] = t.get("logo")

    return team_manager, team_name, team_logo


def build_matchup_records(raw, year, team_manager):
    """Returns (matchup_records, played_weeks, live_week, live_pairings,
    future_pairings_by_week).

    matchup_records/played_weeks: unchanged behavior from before -- only
    matchups ESPN has fully decided (winner != "UNDECIDED") are included,
    scored from ESPN's own totalPoints for that (finished) week.

    live_week: the single earliest not-yet-decided matchupPeriodId, if any.
    Every week before it is already decided (the schedule is processed in
    order and a week is only marked decided once it's actually over), and
    every week after it hasn't started yet -- so this is "the week
    currently being played" during the season, and None the rest of the
    time (preseason, or once every week is final). This is a schema-shape-
    agnostic way to find the live week: it only relies on winner ==
    "UNDECIDED", the same field this function already reads, rather than
    guessing at some other ESPN status field.

    live_pairings: that live week's home/away team pairings only (matchup
    id, both team ids, whether it's a bye) -- deliberately NOT points.
    ESPN's own totalPoints for an in-progress week is usable, but the
    caller (pull_season) instead re-derives live points from a fresh
    boxscore pull, the same starter-sum source used for every decided
    week and for bye weeks (see api/matchups/route.js's bonus-exclusion
    comment) -- so a live score is never a moving target that later turns
    out to have included some correction that decided weeks don't get
    until the week is actually final.

    future_pairings_by_week: {week: [pairings]} for every OTHER undecided
    week (i.e. everything after live_week) up through MAX_PROJECTED_WEEK,
    same pairing shape as live_pairings. ESPN publishes a league's whole
    schedule up front, so these future pairings are already sitting in
    raw["schedule"] the same way live_week's are -- this just collects them
    instead of discarding them. Used by pull_season to build
    projected_matchup_records for the "Projected Finish" Contests view.
    """
    matchup_records = []
    weeks = set()
    undecided_weeks = set()
    for m in raw.get("schedule", []):
        if m.get("winner") == "UNDECIDED":
            undecided_weeks.add(m.get("matchupPeriodId"))

    live_week = min(undecided_weeks) if undecided_weeks else None
    live_pairings = []
    future_pairings_by_week = {}

    for m in raw.get("schedule", []):
        week = m.get("matchupPeriodId")
        winner = m.get("winner")

        if winner == "UNDECIDED":
            home = m.get("home") or {}
            away = m.get("away") or {}
            home_id = home.get("teamId")
            away_id = away.get("teamId")
            pairing = {
                "week": week,
                "matchup_id": m.get("id"),
                "home_platform_team_id": home_id,
                "away_platform_team_id": away_id,
                "is_bye": away_id is None,
            }
            if week == live_week:
                live_pairings.append(pairing)
            elif week is not None and week <= MAX_PROJECTED_WEEK:
                future_pairings_by_week.setdefault(week, []).append(pairing)
            continue  # not decided -- either the live week, a future week (both handled above), or beyond MAX_PROJECTED_WEEK

        home = m.get("home") or {}
        away = m.get("away") or {}
        home_id = home.get("teamId")
        away_id = away.get("teamId")
        home_pts = home.get("totalPoints")
        away_pts = away.get("totalPoints")
        is_bye = away_id is None

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
    return matchup_records, sorted(weeks), live_week, live_pairings, future_pairings_by_week


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
    team_manager, team_name, team_logo = build_manager_map(raw)
    matchup_records, played_weeks, live_week, live_pairings, future_pairings_by_week = build_matchup_records(
        raw, year, team_manager
    )
    player_rows = build_player_points_rows(
        external_season_id, year, played_weeks, team_manager, team_name, espn_s2, swid
    )

    # If a week is currently being played, pull its boxscore too (a second,
    # separate fetch -- not part of played_weeks/player_rows above, which
    # stays scoped to fully decided weeks exactly like before) and turn it
    # into provisional live_matchup_records for that one week. Wrapped in
    # its own try/except: a live pull is a nice-to-have on top of the
    # decided-week data this function already reliably returns, so a
    # transient hiccup fetching the in-progress boxscore (e.g. ESPN briefly
    # erroring mid-game) should never take down the whole season's pull --
    # it just means this run doesn't have a live update, and the next
    # scheduled run (5 minutes later on a game day) tries again.
    live_matchup_records = []
    # Per-player rows for the live week, same shape as player_rows -- kept
    # around (not just aggregated into live_points_by_team below) so
    # load_season can also write them into live_player_points at per-player
    # granularity, for Players & Positions. Initialized empty here so a
    # failed/skipped live pull always returns a valid (empty) list rather
    # than leaving this undefined.
    live_player_rows = []
    if live_week is not None and live_pairings:
        try:
            live_player_rows = build_player_points_rows(
                external_season_id, year, [live_week], team_manager, team_name, espn_s2, swid
            )
            live_points_by_team = {}
            for row in live_player_rows:
                tid = row["platform_team_id"]
                live_points_by_team[tid] = round(
                    live_points_by_team.get(tid, 0.0) + (row["points"] or 0.0), 2
                )

            for pairing in live_pairings:
                home_id = pairing["home_platform_team_id"]
                away_id = pairing["away_platform_team_id"]
                live_matchup_records.append(
                    {
                        "week": pairing["week"],
                        "matchup_id": pairing["matchup_id"],
                        "home_platform_team_id": home_id,
                        "away_platform_team_id": away_id,
                        "home_points": live_points_by_team.get(home_id, 0.0),
                        "away_points": live_points_by_team.get(away_id) if away_id is not None else None,
                        "is_bye": pairing["is_bye"],
                    }
                )
        except Exception as exc:  # noqa: BLE001 -- see comment above
            print(f"    Could not pull live week {live_week}: {exc}", file=sys.stderr)
            live_matchup_records = []
            live_player_rows = []

    # The live week's own contribution to "Projected Finish": points already
    # earned by anyone who's already played this week, PLUS this platform's
    # own projection for anyone who hasn't played yet -- see
    # _blended_player_week_points for exactly why that's not the same as
    # live_matchup_records above (which stays pure-actual, for the real
    # leaderboard). Reuses live_pairings (same live week, same pairings) but
    # re-fetches the boxscore and re-extracts with the blended point
    # function instead of reusing live_player_rows, since those were built
    # with a plain actual-only read. A user reported Projected Finish
    # reading far lower than ESPN's own displayed projected total; this
    # turned out to be the entire gap -- the live week was previously
    # missing from projected_matchups altogether, so Projected Finish fell
    # back to the real (pure-actual, "points scored so far only") live
    # total for it instead of blending in projections for anyone who hasn't
    # played yet. Wrapped in its own try/except for the same reason as the
    # live block above: a hiccup here just means this run's Projected
    # Finish doesn't have a live-week number yet, not that the whole pull
    # should fail.
    projected_matchup_records = []
    if live_week is not None and live_pairings:
        try:
            live_week_raw = fetch_week_boxscore(external_season_id, year, live_week, espn_s2, swid)
            blended_rows = extract_player_rows(
                live_week_raw, year, live_week, team_manager, team_name,
                points_fn=_blended_player_week_points,
            )
            blended_points_by_team = {}
            for row in blended_rows:
                tid = row["platform_team_id"]
                blended_points_by_team[tid] = round(
                    blended_points_by_team.get(tid, 0.0) + (row["points"] or 0.0), 2
                )

            for pairing in live_pairings:
                home_id = pairing["home_platform_team_id"]
                away_id = pairing["away_platform_team_id"]
                projected_matchup_records.append(
                    {
                        "week": pairing["week"],
                        "matchup_id": pairing["matchup_id"],
                        "home_platform_team_id": home_id,
                        "away_platform_team_id": away_id,
                        "home_points": blended_points_by_team.get(home_id, 0.0),
                        "away_points": blended_points_by_team.get(away_id) if away_id is not None else None,
                        "is_bye": pairing["is_bye"],
                    }
                )
        except Exception as exc:  # noqa: BLE001 -- see comment above
            print(f"    Could not build blended live-week projection for week {live_week}: {exc}", file=sys.stderr)

    # Beyond the live week (if any), pull PROJECTED per-player points
    # (statSourceId=1, see extract_player_rows) for every other week ESPN's
    # schedule already knows about, through MAX_PROJECTED_WEEK -- same
    # provisional-matchup shape as live_matchup_records above, just spanning
    # however many future weeks future_pairings_by_week has instead of one.
    # Appends to the same projected_matchup_records list as the blended
    # live-week block above. Wrapped in its own try/except for the same
    # reason as the live block: a hiccup here is a nice-to-have miss, not
    # worth failing the pull over.
    if future_pairings_by_week:
        # Accumulated separately from projected_matchup_records and only
        # merged in on success -- an error partway through this loop should
        # discard just these (possibly-partial) future weeks, the same
        # all-or-nothing behavior as before, without also wiping out the
        # live week's blended entry already appended above.
        future_records = []
        try:
            for week in sorted(future_pairings_by_week):
                week_raw = fetch_week_boxscore(external_season_id, year, week, espn_s2, swid)
                week_player_rows = extract_player_rows(
                    week_raw, year, week, team_manager, team_name, stat_source_id=1
                )
                # ESPN only populates real projections once a week gets
                # close -- a week far enough out comes back with every
                # player's points as None (no statSourceId=1 entry exists
                # yet). Skip such a week entirely rather than recording a
                # misleading 0-0 "projection" for it; it picks up real
                # numbers automatically on a later run once ESPN turns
                # projections on for it.
                if not any(row["points"] is not None for row in week_player_rows):
                    continue

                points_by_team = {}
                for row in week_player_rows:
                    tid = row["platform_team_id"]
                    points_by_team[tid] = round(points_by_team.get(tid, 0.0) + (row["points"] or 0.0), 2)

                for pairing in future_pairings_by_week[week]:
                    home_id = pairing["home_platform_team_id"]
                    away_id = pairing["away_platform_team_id"]
                    future_records.append(
                        {
                            "week": pairing["week"],
                            "matchup_id": pairing["matchup_id"],
                            "home_platform_team_id": home_id,
                            "away_platform_team_id": away_id,
                            "home_points": points_by_team.get(home_id, 0.0),
                            "away_points": points_by_team.get(away_id) if away_id is not None else None,
                            "is_bye": pairing["is_bye"],
                        }
                    )
            projected_matchup_records.extend(future_records)
        except Exception as exc:  # noqa: BLE001 -- see comment above
            print(
                f"    Could not pull projected weeks {sorted(future_pairings_by_week)}: {exc}",
                file=sys.stderr,
            )

    return {
        "platform": PLATFORM,
        "external_id": external_season_id,
        "league_name": league_name,
        "team_manager": team_manager,
        "team_name": team_name,
        "team_logo": team_logo,
        "player_rows": player_rows,
        "matchup_records": matchup_records,
        "live_week": live_week,
        "live_matchup_records": live_matchup_records,
        "live_player_rows": live_player_rows,
        "projected_matchup_records": projected_matchup_records,
    }
