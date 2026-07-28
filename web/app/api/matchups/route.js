import { query } from "@/lib/db";

// Full schedule/results for a season. Head-to-head records are derived
// client-side from this list rather than a separate query.
// GET /api/matchups?season=2025
export async function GET(request) {
  const season = Number(new URL(request.url).searchParams.get("season"));
  if (!season) {
    return Response.json({ error: "season query param is required" }, { status: 400 });
  }

  const rows = await query(
    `SELECT mu.week,
            ht.team_name AS home_team,
            at.team_name AS away_team,
            mu.home_points,
            mu.away_points,
            mu.winner,
            mu.is_bye
     FROM matchups mu
     JOIN teams ht ON ht.team_id = mu.home_team_id
     LEFT JOIN teams at ON at.team_id = mu.away_team_id
     WHERE mu.season = ?
     ORDER BY mu.week`,
    [season]
  );

  return Response.json({ season, rows });
}
