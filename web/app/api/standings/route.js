import { query } from "@/lib/db";

// Standings table (wins/losses/points) + weekly trend series, for one
// league's season. Scoped to the regular season (weeks 1..regular_season_weeks)
// -- playoff weeks are returned separately as playoffWeekly rather than
// folded into the same standings/trend, since fantasy playoff results
// don't count toward the overall record the same way regular-season games
// do.
// GET /api/standings?league=<slug>&season=2025

// Shared by the current-standings query and the "as of last week" query
// used to compute each team's rank movement -- same shape, different week
// upper bound. team_id is only for joining the two snapshots together
// server-side; it's stripped back out before the response goes out.
function standingsQuery(season, weekCutoff, league) {
  return query(
    `WITH sides AS (
       SELECT season, week, home_team_id AS team_id, home_points AS points_for, away_points AS points_against,
              CASE WHEN winner = 'HOME' THEN 1 ELSE 0 END AS win,
              CASE WHEN winner = 'AWAY' THEN 1 ELSE 0 END AS loss,
              CASE WHEN winner = 'TIE' THEN 1 ELSE 0 END AS tie
       FROM matchups WHERE is_bye = 0
       UNION ALL
       SELECT season, week, away_team_id AS team_id, away_points AS points_for, home_points AS points_against,
              CASE WHEN winner = 'AWAY' THEN 1 ELSE 0 END AS win,
              CASE WHEN winner = 'HOME' THEN 1 ELSE 0 END AS loss,
              CASE WHEN winner = 'TIE' THEN 1 ELSE 0 END AS tie
       FROM matchups WHERE is_bye = 0 AND away_team_id IS NOT NULL
     )
     SELECT s.team_id AS team_id,
            m.manager_name AS manager,
            t.team_name AS team,
            SUM(s.win) AS wins,
            SUM(s.loss) AS losses,
            SUM(s.tie) AS ties,
            ROUND(SUM(s.points_for), 2) AS points_for,
            ROUND(SUM(s.points_against), 2) AS points_against,
            ROUND(AVG(s.points_for), 2) AS avg_points
     FROM sides s
     JOIN teams t ON t.team_id = s.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE s.season = ? AND s.week <= ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     GROUP BY s.team_id
     ORDER BY wins DESC, points_for DESC`,
    [season, weekCutoff, league]
  );
}

// Same tiebreak the standings table uses for its default sort (see
// StandingsInner's sortedStandings) -- rank movement has to be measured
// against that order, not whichever column the table happens to be
// sorted by at the moment, or the arrows would mean something different
// depending on what the viewer clicked.
function rankByRecord(rows) {
  const sorted = [...rows].sort(
    (a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for - a.points_for
  );
  const ranks = new Map();
  sorted.forEach((row, i) => ranks.set(row.team_id, i + 1));
  return ranks;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const season = Number(params.get("season"));
  const league = params.get("league");
  if (!season || !league) {
    return Response.json({ error: "season and league query params are required" }, { status: 400 });
  }

  const leagueRows = await query(
    `SELECT ls.regular_season_weeks FROM league_seasons ls
     JOIN leagues l ON l.league_id = ls.league_id
     WHERE l.slug = ? AND ls.season = ?`,
    [league, season]
  ).catch(() => []);
  // No configured cutoff -- treat every played week as "regular season"
  // rather than silently hiding weeks nobody told us were playoffs.
  const regularSeasonWeeks = leagueRows[0]?.regular_season_weeks ?? Infinity;
  // Infinity isn't a valid SQL bind value -- substitute a sentinel large
  // enough that "week <= sqlWeekCutoff" is always true when uncapped.
  const sqlWeekCutoff = Number.isFinite(regularSeasonWeeks) ? regularSeasonWeeks : 999999;

  const standingsRows = await standingsQuery(season, sqlWeekCutoff, league);

  // Rank movement vs. the previous week: standingsRows already reflects
  // every regular-season game played so far (the sqlWeekCutoff is just an
  // upper bound -- there's nothing beyond whatever week has actually been
  // played), so it doubles as "as of the most recent week" without a
  // separate query. Only the "as of one week earlier" snapshot needs its
  // own query, and only if a most-recent week is even known.
  const maxWeekRows = await query(
    `SELECT MAX(week) AS max_week FROM matchups
     WHERE season = ? AND is_bye = 0 AND league_id = (SELECT league_id FROM leagues WHERE slug = ?)
       AND week <= ?`,
    [season, league, sqlWeekCutoff]
  ).catch(() => []);
  const maxWeek = maxWeekRows[0]?.max_week ?? null;

  let previousRanks = new Map();
  if (maxWeek != null && maxWeek > 1) {
    const previousRows = await standingsQuery(season, maxWeek - 1, league);
    previousRanks = rankByRecord(previousRows);
  }
  const currentRanks = rankByRecord(standingsRows);

  const standingsWithRank = standingsRows.map(({ team_id, ...row }) => {
    const rank = currentRanks.get(team_id) ?? null;
    const previousRank = previousRanks.get(team_id) ?? null;
    return {
      ...row,
      rank,
      // Positive = moved up (a lower rank number is better); null = no
      // prior week to compare against yet (week 1, or a team new to the
      // league this week).
      rankDelta: rank != null && previousRank != null ? previousRank - rank : null,
    };
  });

  const allWeekly = await query(
    `SELECT wmp.week, m.manager_name AS manager, t.team_name AS team, wmp.points
     FROM weekly_manager_points wmp
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE t.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY wmp.week, team`,
    [season, league]
  );

  const weekly = allWeekly.filter((r) => r.week <= regularSeasonWeeks);
  const playoffWeekly = allWeekly.filter((r) => r.week > regularSeasonWeeks);

  return Response.json({
    season,
    regularSeasonWeeks: Number.isFinite(regularSeasonWeeks) ? regularSeasonWeeks : null,
    standings: standingsWithRank,
    weekly,
    playoffWeekly,
  });
}
