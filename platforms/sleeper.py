"""
Sleeper puller. See platforms/__init__.py for the interface contract
(resolve_years / pull_season) this module implements.

Sleeper's API is fully public and read-only -- no league id / credentials
needed beyond the league id itself (no equivalent of ESPN's espn_s2/SWID).
Docs: https://docs.sleeper.com/

Two things make this module shaped differently than platforms/espn.py:

1. Season chaining. ESPN reuses one league id across every season of a
   league. Sleeper does the opposite -- each season gets its OWN league id,
   linked back to the previous season via `previous_league_id`. So
   resolve_years() has to actually walk that chain instead of just echoing
   the configured id back for every year.

2. Player-list caching needs the database. Sleeper's full player dump
   (id -> name/position, ~5MB) is requested to be pulled "at most once a
   day". A GitHub Actions run gets a fresh checkout every time (no local
   disk cache survives between runs), so the only place that can durably
   remember "we already synced recently" is the database itself -- hence
   pull_season() here takes `conn` and actually uses it (platforms/espn.py
   accepts `conn` too, for interface parity, but ignores it).

Per-player weekly points are an approximation, not exact. Sleeper's own
per-roster weekly `points` (used for standings, wins/losses, points-for) IS
exact -- it's computed by Sleeper itself from the league's real scoring
settings. But the *player-level* breakdown used for the Players & Positions
page comes from Sleeper's stats endpoint, which only exposes precomputed
totals for standard/half-PPR/full-PPR scoring (pts_std/pts_half_ppr/
pts_ppr) -- not a fully custom-scoring-settings-aware total. This module
picks whichever of the three is closest to the league's actual reception
scoring. For leagues with heavily customized scoring (bonus thresholds, TE
premium, etc.) the player-level numbers may not add up to precisely the
team's real weekly total; the team-level total itself is still exact.
"""

import sys
from datetime import datetime, timedelta

import requests

import db as db_module

BASE = "https://api.sleeper.app/v1"
PLATFORM = "sleeper"

# Sleeper's own undocumented weekly projections endpoint -- a different host
# path than everything else in this module (no /v1, and shaped differently:
# a flat list of {player_id, stats: {...}} objects rather than a dict keyed
# straight by player_id the way /stats/nfl/regular/<year>/<week> is -- see
# _fetch_projected_stats). Not part of Sleeper's documented API, so treated
# defensively throughout: a failure here should mean "no projection this
# week," never a broken pipeline run.
PROJECTIONS_BASE = "https://api.sleeper.app/projections/nfl"

# Positions actually eligible to start in a standard fantasy lineup --
# passed as repeated position[] query params so the projections endpoint
# doesn't have to hand back every IDP/return-specialist entry it tracks,
# just the ones a roster's `starters` list could actually contain.
PROJECTION_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"]

# How far out (in absolute week number) to keep asking Sleeper for
# projected scores when building the "Projected Finish" Contests view --
# deliberately tied to this app's own Grand Prix bounds (the longest
# supported cup structure ends at week 16, see web/lib/scoring.js's
# DEFAULT_CUP_WEEKS/CUP_WEEK_SETS) rather than the NFL's actual season
# length. Same constant/reasoning as platforms/espn.py's MAX_PROJECTED_WEEK.
MAX_PROJECTED_WEEK = 16

# How long we trust a previous full-player-list sync before pulling it
# again, per Sleeper's "at most once a day" guidance. Kept a bit under 24h
# so a daily cron doesn't drift past the boundary and skip a day entirely.
PLAYER_SYNC_MAX_AGE = timedelta(hours=20)


def _get(path, params=None):
    resp = requests.get(f"{BASE}{path}", params=params, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"Sleeper API request failed for {path} (status {resp.status_code}).")
    return resp.json()


def fetch_league(league_id):
    return _get(f"/league/{league_id}")


def resolve_years(conn, league_config, years):
    """Walk the previous_league_id chain starting from the league's current
    (most recent) season id, and return {year: that season's league_id}.

    If `years` is empty (e.g. a self-service league added through the web
    UI, which only ever collects a single "current" league id and doesn't
    ask the person to type out which years to pull), every season found in
    the chain is returned -- there's nothing to filter against, and walking
    the whole chain is exactly how you'd discover a league's full history
    from just its current id. Otherwise, only the requested years are kept;
    a requested year with no matching season in the chain (e.g. before the
    league existed) is simply omitted -- pipeline.py treats a missing year
    as "skip"."""
    start_id = league_config["sleeper_league_id"]
    wanted = set(years) if years else None
    found = {}

    league_id = start_id
    seen_ids = set()
    while league_id and league_id not in seen_ids:
        if wanted is not None and wanted.issubset(found.keys()):
            break
        seen_ids.add(league_id)
        data = fetch_league(league_id)
        season = data.get("season")
        if season:
            season = int(season)
            if wanted is None or season in wanted:
                found[season] = league_id
        league_id = data.get("previous_league_id")

    return found


def _build_team_maps(rosters, users):
    user_names = {u["user_id"]: (u.get("display_name") or "Unknown") for u in users}
    user_team_names = {u["user_id"]: (u.get("metadata") or {}).get("team_name") for u in users}

    team_manager = {}
    team_name = {}
    for r in rosters:
        roster_id = str(r["roster_id"])
        owner_id = r.get("owner_id")
        owner_ids = ([owner_id] if owner_id else []) + list(r.get("co_owners") or [])
        names = [user_names.get(o, "Unknown") for o in owner_ids] or ["Unknown"]
        team_manager[roster_id] = " / ".join(names)

        custom_name = user_team_names.get(owner_id) if owner_id else None
        team_name[roster_id] = custom_name or f"{names[0]}'s Team"

    return team_manager, team_name


def _fetch_played_weeks(external_season_id, max_week=18):
    """Sleeper doesn't expose an explicit "has this week been played" flag
    the way ESPN's winner=UNDECIDED does. Heuristic: a week counts as played
    once at least one roster has recorded nonzero points for it; the first
    week where every roster is still at 0 (or the endpoint returns nothing)
    is treated as "not reached yet" and stops the scan."""
    weeks = {}
    for week in range(1, max_week + 1):
        try:
            data = _get(f"/league/{external_season_id}/matchups/{week}")
        except RuntimeError:
            break
        if not data or not any((m.get("points") or 0) > 0 for m in data):
            break
        weeks[week] = data
    return weeks


def _fetch_future_weeks(external_season_id, start_week, max_week=MAX_PROJECTED_WEEK):
    """Matchup pairings for every week from start_week through max_week --
    unlike _fetch_played_weeks above, this doesn't require nonzero points,
    since a future week's pairing is exactly what's wanted while its real
    points are still zero/unset. Sleeper generates and exposes a league's
    full season schedule up front, so a future week's roster_id/matchup_id
    pairing is already available this way. Stops at the first week with no
    data at all (the schedule doesn't extend that far)."""
    weeks = {}
    for week in range(start_week, max_week + 1):
        try:
            data = _get(f"/league/{external_season_id}/matchups/{week}")
        except RuntimeError:
            break
        if not data:
            break
        weeks[week] = data
    return weeks


def _fetch_projected_stats(year, week):
    """Sleeper's own undocumented weekly projections endpoint -- see
    PROJECTIONS_BASE's comment for how its shape differs from the actual-
    points endpoint this reshapes to match. Returns {player_id: stats},
    same convention _extract_player_rows already expects from `stats`, or
    {} on any failure (wrong shape, network error, endpoint gone) -- this
    is unofficial and could change or disappear without notice, and a
    missing projection should just mean "no data for this week yet."""
    try:
        resp = requests.get(
            f"{PROJECTIONS_BASE}/{year}/{week}",
            params={"season_type": "regular", "position[]": PROJECTION_POSITIONS},
            timeout=30,
        )
        if resp.status_code != 200:
            return {}
        entries = resp.json() or []
        return {e["player_id"]: (e.get("stats") or {}) for e in entries if e.get("player_id")}
    except Exception:  # noqa: BLE001 -- unofficial endpoint, fail soft
        return {}


def _projected_matchup_records(week, matchups_list, points_by_roster):
    """Same pairing shape as _matchups_to_records below, but for a future
    week: no `winner` to compute (nothing's been played), and points come
    from `points_by_roster` (this week's projected sums) rather than
    Sleeper's own recorded points."""
    by_matchup_id = {}
    for m in matchups_list:
        by_matchup_id.setdefault(m.get("matchup_id"), []).append(m)

    records = []
    for matchup_id, entries in by_matchup_id.items():
        entries = sorted(entries, key=lambda e: e["roster_id"])
        home = entries[0]
        away = entries[1] if len(entries) > 1 else None
        home_id = str(home["roster_id"])
        away_id = str(away["roster_id"]) if away else None
        records.append(
            {
                "week": week,
                "matchup_id": matchup_id,
                "home_platform_team_id": home_id,
                "away_platform_team_id": away_id,
                "home_points": points_by_roster.get(home_id, 0.0),
                "away_points": points_by_roster.get(away_id) if away_id is not None else None,
                "is_bye": away is None,
            }
        )
    return records


def _matchups_to_records(week, matchups_list):
    by_matchup_id = {}
    for m in matchups_list:
        by_matchup_id.setdefault(m.get("matchup_id"), []).append(m)

    records = []
    for matchup_id, entries in by_matchup_id.items():
        entries = sorted(entries, key=lambda e: e["roster_id"])
        home = entries[0]
        away = entries[1] if len(entries) > 1 else None
        home_pts = home.get("points")
        away_pts = away.get("points") if away else None
        is_bye = away is None

        if is_bye:
            winner = "BYE"
        elif home_pts is None or away_pts is None:
            winner = "UNDECIDED"
        elif home_pts > away_pts:
            winner = "HOME"
        elif away_pts > home_pts:
            winner = "AWAY"
        else:
            winner = "TIE"

        records.append(
            {
                "week": week,
                "matchup_id": matchup_id,
                "home_platform_team_id": str(home["roster_id"]),
                "away_platform_team_id": str(away["roster_id"]) if away else None,
                "home_points": home_pts,
                "away_points": away_pts,
                "winner": winner,
                "is_bye": is_bye,
            }
        )
    return records


def _points_field(scoring_settings):
    """Pick the closest of Sleeper's three precomputed scoring formats to
    this league's actual reception scoring. See module docstring for the
    accuracy caveat this implies for player-level (not team-level) points."""
    rec = (scoring_settings or {}).get("rec") or 0
    if rec >= 1:
        return "pts_ppr"
    if rec >= 0.5:
        return "pts_half_ppr"
    return "pts_std"


def _get_cached_player_meta(conn, platform_player_id):
    row = conn.execute(
        "SELECT player_name, position FROM players WHERE platform = 'sleeper' AND platform_player_id = ?",
        (platform_player_id,),
    ).fetchone()
    return {"name": row[0], "position": row[1]} if row else None


def _sync_players_if_needed(conn, needed_ids):
    missing = [pid for pid in needed_ids if pid and _get_cached_player_meta(conn, pid) is None]
    if not missing:
        return

    _, last_synced = db_module.get_sync_state(conn, "sleeper_players_synced_at")
    if last_synced:
        elapsed = datetime.utcnow() - datetime.fromisoformat(last_synced)
        if elapsed < PLAYER_SYNC_MAX_AGE:
            # Trust what we already have -- any still-unresolved ids just
            # show up as "Player <id>" until the next sync window opens.
            return

    print(f"  Fetching Sleeper's full player list ({len(missing)} unseen id(s))...")
    all_players = _get("/players/nfl")
    for pid in missing:
        meta = all_players.get(pid)
        if not meta:
            continue
        name = meta.get("full_name") or f"{meta.get('first_name', '')} {meta.get('last_name', '')}".strip() or pid
        position = meta.get("position") or (meta.get("fantasy_positions") or ["UNK"])[0]
        db_module.get_or_create_player(conn, "sleeper", pid, name, position)
    db_module.set_sync_state(conn, "sleeper_players_synced_at", datetime.utcnow().isoformat())


def _player_display(conn, pid):
    meta = _get_cached_player_meta(conn, pid)
    if meta and meta["name"]:
        return meta["name"], meta["position"] or "UNK"
    if pid and pid.isalpha():
        # Team defenses appear in starters/players lists as the team
        # abbreviation itself (e.g. "DET") rather than a numeric id.
        return f"{pid} D/ST", "D/ST"
    return f"Player {pid}", "UNK"


def _extract_player_rows(conn, week_matchups, stats, year, week, team_manager, team_name, pts_field):
    rows = []
    for m in week_matchups:
        roster_id = str(m["roster_id"])
        for pid in m.get("starters") or []:
            if not pid or pid == "0":
                continue
            name, position = _player_display(conn, pid)
            points = (stats.get(pid) or {}).get(pts_field)
            rows.append(
                {
                    "season": year,
                    "week": week,
                    "manager": team_manager.get(roster_id, "Unknown"),
                    "team": team_name.get(roster_id),
                    "player": name,
                    "position": position,
                    "points": round(points, 2) if points is not None else None,
                    "platform_team_id": roster_id,
                    "platform_player_id": pid,
                }
            )
    return rows


def pull_season(conn, league_config, year, external_season_id):
    league = fetch_league(external_season_id)
    rosters = _get(f"/league/{external_season_id}/rosters")
    users = _get(f"/league/{external_season_id}/users")
    team_manager, team_name = _build_team_maps(rosters, users)

    weeks_data = _fetch_played_weeks(external_season_id)
    pts_field = _points_field(league.get("scoring_settings"))

    needed_ids = set()
    for week_matchups in weeks_data.values():
        for m in week_matchups:
            needed_ids.update(m.get("starters") or [])
    _sync_players_if_needed(conn, needed_ids)

    player_rows = []
    matchup_records = []
    for week, week_matchups in sorted(weeks_data.items()):
        stats = _get(f"/stats/nfl/regular/{year}/{week}") or {}
        player_rows.extend(
            _extract_player_rows(conn, week_matchups, stats, year, week, team_manager, team_name, pts_field)
        )
        matchup_records.extend(_matchups_to_records(week, week_matchups))

    # Sleeper exposes the playoff cutoff directly (unlike ESPN, where this
    # has to be configured by hand) -- the regular season is every week
    # before playoffs start. Self-service leagues (added through the web
    # UI, no config.json entry) rely entirely on this; leagues configured
    # in config.json can still override it there per season if needed.
    playoff_week_start = (league.get("settings") or {}).get("playoff_week_start")
    regular_season_weeks = playoff_week_start - 1 if playoff_week_start else None

    # Beyond the last actually-played week, pull PROJECTED per-player points
    # for every future week Sleeper still has scheduled, through
    # MAX_PROJECTED_WEEK -- same provisional-matchup shape ESPN's live pull
    # produces (this platform has no live-week concept of its own, see
    # module docstring), just spanning however many future weeks are found
    # instead of one. Wrapped in its own try/except: a hiccup pulling
    # projections is a nice-to-have miss, not worth failing the whole
    # season's pull over.
    projected_matchup_records = []
    last_played_week = max(weeks_data.keys(), default=0)
    future_weeks_data = _fetch_future_weeks(external_season_id, last_played_week + 1)
    if future_weeks_data:
        try:
            future_needed_ids = set()
            for week_matchups in future_weeks_data.values():
                for m in week_matchups:
                    future_needed_ids.update(m.get("starters") or [])
            _sync_players_if_needed(conn, future_needed_ids)

            for week, week_matchups in sorted(future_weeks_data.items()):
                projected_stats = _fetch_projected_stats(year, week)
                if not projected_stats:
                    # Sleeper hasn't published projections this far out yet
                    # -- skip rather than recording a misleading 0-0
                    # "projection"; picks up real numbers automatically on
                    # a later run once they're published.
                    continue
                week_player_rows = _extract_player_rows(
                    conn, week_matchups, projected_stats, year, week, team_manager, team_name, pts_field
                )
                if not any(row["points"] is not None for row in week_player_rows):
                    continue
                points_by_roster = {}
                for row in week_player_rows:
                    rid = row["platform_team_id"]
                    points_by_roster[rid] = round(
                        points_by_roster.get(rid, 0.0) + (row["points"] or 0.0), 2
                    )
                projected_matchup_records.extend(
                    _projected_matchup_records(week, week_matchups, points_by_roster)
                )
        except Exception as exc:  # noqa: BLE001 -- see comment above
            print(f"    Could not pull projected weeks: {exc}", file=sys.stderr)
            projected_matchup_records = []

    return {
        "platform": PLATFORM,
        "external_id": external_season_id,
        "league_name": league.get("name"),
        "regular_season_weeks": regular_season_weeks,
        "team_manager": team_manager,
        "team_name": team_name,
        "player_rows": player_rows,
        "matchup_records": matchup_records,
        "projected_matchup_records": projected_matchup_records,
    }
