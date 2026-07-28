import { query } from "@/lib/db";

// Standings table (wins/losses/points) + weekly trend series, for one season.
// GET /api/standings?season=2025
export async function GET(request) {
  const season = Number(new URL(request.url).searchParams.get("season"));
  if (!season) {
    return Response.json({ error: "season query param is required" }, { status: 400 });
  }

  const standingsRows = await query(
    `WITH sides AS (
       SELECT season, home_team_id AS team_id, home_points AS points_for, away_points AS points_against,
              CASE WHEN winner = 'HOME' THEN 1 ELSE 0 END AS win,
              CASE WHEN winner = 'AWAY' THEN 1 ELSE 0 END AS loss,
              CASE WHEN winner = 'TIE' THEN 1 ELSE 0 END AS tie
       FROM matchups WHERE is_bye = 0
       UNION ALL
       SELECT season, away_team_id AS team_id, away_points AS points_for, home_points AS points_against,
              CASE WHEN winner = 'AWAY' THEN 1 ELSE 0 END AS win,
              CASE WHEN winner = 'HOME' THEN 1 ELSE 0 END AS loss,
              CASE WHEN winner = 'TIE' THEN 1 ELSE 0 END AS tie
       FROM matchups WHERE is_bye = 0 AND away_team_id IS NOT NULL
     )
     SELECT m.manager_name AS manager,
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
     WHERE s.season = ?
     GROUP BY s.team_id
     ORDER BY wins DESC, points_for DESC`,
    [season]
  );

  const weekly = await query(
    `SELECT wmp.week, m.manager_name AS manager, wmp.points
     FROM weekly_manager_points wmp
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE t.season = ?
     ORDER BY wmp.week, manager`,
    [season]
  );

  return Response.json({ season, standings: standingsRows, weekly });
}
