import { query } from "@/lib/db";

// Point-total side-contests within a season (e.g. weeks 1-4, 5-8, 9-12,
// 13-17). Windows are configured per season in config.json and loaded into
// the contest_windows table by the Python pipeline -- not hardcoded here,
// since they can vary by season/commissioner.
// GET /api/contests?season=2025
export async function GET(request) {
  const season = Number(new URL(request.url).searchParams.get("season"));
  if (!season) {
    return Response.json({ error: "season query param is required" }, { status: 400 });
  }

  const rows = await query(
    `SELECT cw.id AS contest_id,
            cw.contest_name AS name,
            cw.start_week,
            cw.end_week,
            cw.sort_order,
            m.manager_name AS manager,
            ROUND(SUM(wmp.points), 2) AS total_points
     FROM contest_windows cw
     JOIN weekly_manager_points wmp
       ON wmp.season = cw.season AND wmp.week BETWEEN cw.start_week AND cw.end_week
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE cw.season = ?
     GROUP BY cw.id, wmp.team_id
     ORDER BY cw.sort_order, total_points DESC`,
    [season]
  );

  const maxWeekRow = await query(
    "SELECT MAX(week) AS max_week FROM weekly_manager_points WHERE season = ?",
    [season]
  );
  const maxWeek = maxWeekRow[0]?.max_week ?? 0;

  // Group flat rows into one object per contest, in window order.
  const byContest = new Map();
  for (const row of rows) {
    if (!byContest.has(row.contest_id)) {
      byContest.set(row.contest_id, {
        name: row.name,
        start_week: row.start_week,
        end_week: row.end_week,
        sort_order: row.sort_order,
        leaderboard: [],
      });
    }
    byContest.get(row.contest_id).leaderboard.push({
      manager: row.manager,
      total_points: row.total_points,
    });
  }

  const contests = [...byContest.values()]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((c) => ({
      ...c,
      status: maxWeek >= c.end_week ? "final" : maxWeek >= c.start_week ? "in_progress" : "upcoming",
      leaderboard: c.leaderboard.map((row, i) => ({ rank: i + 1, ...row })),
    }));

  return Response.json({ season, maxWeek, contests });
}
