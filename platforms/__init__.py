"""
Platform pullers: one module per fantasy football host (espn, sleeper --
yahoo may be added later). Each module is responsible only for turning that
platform's API into a common normalized shape; nothing here talks to the
database directly except where a platform's own API constraints force it
(see platforms/sleeper.py's player-list caching for why that one is an
exception).

Every puller module exposes the same two functions, so pipeline.py can treat
all platforms identically:

    resolve_years(conn, league_config, years) -> {year: external_season_id}
        Maps the requested season years to that platform's season-specific
        league id. For ESPN this is trivial (the same league id is reused
        every season). For Sleeper, each season has its own league id
        chained via previous_league_id, so this walks that chain. Years
        with no corresponding season on the platform are simply omitted
        from the returned dict (pipeline.py treats that as "skip").

    pull_season(conn, league_config, year, external_season_id) -> dict | None
        Fetches one season and returns:
          {
            "platform": "espn" | "sleeper",
            "external_id": <that season's platform-side league id>,
            "league_name": str | None,
            "regular_season_weeks": int | None,  # optional; omitted/None means
                # "not auto-detectable on this platform" (true for ESPN --
                # pipeline.py falls back to config.json's regular_season_weeks
                # for those). Sleeper derives it from the league's own
                # playoff_week_start setting.
            "team_manager": {platform_team_id: manager_display_name},
            "team_name": {platform_team_id: team_display_name},
            "player_rows": [
                {"season", "week", "manager", "team", "player", "position",
                 "points", "platform_team_id", "platform_player_id"}, ...
            ],
            "matchup_records": [
                {"week", "matchup_id", "home_platform_team_id",
                 "away_platform_team_id", "home_points", "away_points",
                 "winner", "is_bye"}, ...
            ],
          }
        Returns None (or raises) if the season isn't available -- pipeline.py
        catches exceptions per-season so one bad season doesn't abort a run.

league_config is the dict pipeline.py loaded for one league from config.json
(platform, credentials, etc. -- see pipeline.py's docstring for its shape).
"""
