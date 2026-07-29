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

from datetime import datetime, timedelta

import requests

import db as db_module

BASE = "https://api.sleeper.app/v1"
PLATFORM = "sleeper"

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

    return {
        "platform": PLATFORM,
        "external_id": external_season_id,
        "league_name": league.get("name"),
        "regular_season_weeks": regular_season_weeks,
        "team_manager": team_manager,
        "team_name": team_name,
        "player_rows": player_rows,
        "matchup_records": matchup_records,
    }
