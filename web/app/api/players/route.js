import { query } from "@/lib/db";

// Every starting-lineup player-week for a season, joined with names.
// Filtering by manager/position/player is done client-side (dataset is
// small -- a season is a couple thousand rows at most).
// GET /api/players?season=2025
export async function GET(request) {
  const season = Number(new URL(request.url).searchParams.get("season"));
  if (!season) {
    return Response.json({ error: "season query param is required" }, { status: 400 });
  }

  const rows = await query(
    `SELECT wpp.week,
            m.manager_name AS manager,
            t.team_name AS team,
            p.player_name AS player,
            p.position AS position,
            wpp.points AS points
     FROM weekly_player_points wpp
     JOIN teams t ON t.team_id = wpp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     JOIN players p ON p.player_id = wpp.player_id
     WHERE t.season = ?
     ORDER BY wpp.week, manager, position, player`,
    [season]
  );

  return Response.json({ season, rows });
}
