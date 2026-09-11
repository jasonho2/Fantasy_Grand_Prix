import { query } from "@/lib/db";

// Mirrors POINT_TABLE in api/contests/route.js -- Solo-mode weekly
// placement points, applied here across the *entire* season (weeks 1-N)
// rather than scoped to a cup window, to power the Grand Prix Points
// Trend chart on the Season Leaderboard page. Keep in sync with the
// Contests route if either ever changes.
const POINT_TABLE = [12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
function placementPoints(rank) {
  return rank - 1 < POINT_TABLE.length ? POINT_TABLE[rank - 1] : 0;
}

// Standings table + two trend series, for one league's season.
//
// The Season Leaderboard table and the Fantasy/Grand-Prix Points Trend
// charts all share a single week-range slider on the frontend (see
// standings/page.js), so this route intentionally does NOT pre-aggregate
// the standings table to a fixed week cutoff the way it used to -- instead
// it returns weeklyRecords, one row per team per (non-bye) matchup week,
// and the frontend re-aggregates wins/losses/points for whatever range the
// slider is currently set to. regularSeasonWeeks is still returned (used
// for the chart's regular-season/playoff divider line), but it's no
// longer used server-side to cut anything off.
//
// GET /api/standings?league=<slug>&season=2025
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
  const regularSeasonWeeks = leagueRows[0]?.regular_season_weeks ?? null;

  // One row per team per week that team was in a real (non-bye) matchup --
  // the same "sides" shape the standings table used to aggregate in SQL,
  // just not summed here. The frontend sums whatever subset of weeks the
  // slider currently covers (see computeStandings in standings/page.js).
  const weeklyRecords = await query(
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
     SELECT s.week,
            t.team_name AS team,
            m.manager_name AS manager,
            s.points_for,
            s.points_against,
            s.win,
            s.loss,
            s.tie
     FROM sides s
     JOIN teams t ON t.team_id = s.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE s.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY s.week, team`,
    [season, league]
  );

  // Raw weekly fantasy points per team, every week the team fielded a
  // lineup -- including bye weeks (weekly_manager_points is bye-inclusive
  // by design; see its schema comment in db.py), unlike weeklyRecords
  // above which only covers weeks with a real opponent. This is the single
  // unified series (weeks 1 through however far the season's gotten) for
  // the Fantasy Points Trend chart -- no more separate regular-season/
  // playoff split, since the frontend now renders one consolidated chart
  // with a divider line instead of two side-by-side ones.
  const decidedWeekly = await query(
    `SELECT wmp.week, m.manager_name AS manager, t.team_name AS team, wmp.points
     FROM weekly_manager_points wmp
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE t.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY wmp.week, team`,
    [season, league]
  );

  // The single week currently being played (if any) -- provisional team
  // totals pulled fresh each pipeline run, same source as
  // api/contests/route.js's own live merge (see live_matchups' schema
  // comment in db.py). Folded into `weekly` below so the Weekly/Grand-Prix
  // Points Trend charts move live as games happen, same as Contests'
  // cup rankings already do -- but deliberately NOT folded into
  // weeklyRecords above, which stays decided-only: a W-L record can't be
  // known until a matchup is actually final, the way a raw point total
  // reasonably can be shown provisionally.
  const liveRows = await query(
    `SELECT lm.week,
            hm.manager_name AS home_manager,
            ht.team_name AS home_team,
            lm.home_points,
            am.manager_name AS away_manager,
            at.team_name AS away_team,
            lm.away_points,
            lm.is_bye
     FROM live_matchups lm
     JOIN teams ht ON ht.team_id = lm.home_team_id
     JOIN managers hm ON hm.manager_id = ht.manager_id
     LEFT JOIN teams at ON at.team_id = lm.away_team_id
     LEFT JOIN managers am ON am.manager_id = at.manager_id
     WHERE lm.season = ? AND lm.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY lm.week`,
    [season, league]
  ).catch(() => []); // tolerate a not-yet-migrated DB that lacks live_matchups

  const liveWeekly = []; // same shape as decidedWeekly
  for (const row of liveRows) {
    liveWeekly.push({ week: row.week, manager: row.home_manager, team: row.home_team, points: row.home_points });
    if (!row.is_bye && row.away_manager != null) {
      liveWeekly.push({ week: row.week, manager: row.away_manager, team: row.away_team, points: row.away_points });
    }
  }
  const weekly = [...decidedWeekly, ...liveWeekly];

  // Grand Prix (Mario Kart placement) points, same idea as the Contests
  // page's Solo mode but computed across the whole season rather than
  // scoped to a single cup window: each week, every team is ranked
  // against everyone else in the league by that week's raw fantasy score,
  // and earns placement points via POINT_TABLE. Solo only (no Double
  // Dash) -- Double Dash's pairing depends on that week's real head-to-
  // head matchup, which is a cup-specific concept the season-wide
  // Standings page doesn't otherwise deal in.
  const byWeek = new Map();
  for (const row of weekly) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, []);
    byWeek.get(row.week).push(row);
  }
  const gpWeekly = [];
  for (const [week, teams] of byWeek) {
    const sorted = [...teams].sort((a, b) => b.points - a.points);
    sorted.forEach((row, i) => {
      gpWeekly.push({ week, team: row.team, manager: row.manager, points: placementPoints(i + 1) });
    });
  }
  gpWeekly.sort((a, b) => a.week - b.week || a.team.localeCompare(b.team));

  return Response.json({
    season,
    regularSeasonWeeks,
    weeklyRecords,
    weekly,
    gpWeekly,
  });
}
