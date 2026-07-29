import { query } from "@/lib/db";

// Every starting-lineup player-week for one league's season, joined with
// names. Filtering by manager/position/player is done client-side (dataset
// is small -- a season is a couple thousand rows at most).
// GET /api/players?league=<slug>&season=2025
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const season = Number(params.get("season"));
  const league = params.get("league");
  if (!season || !league) {
    return Response.json({ error: "season and league query params are required" }, { status: 400 });
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
     WHERE t.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY wpp.week, manager, position, player`,
    [season, league]
  );

  return Response.json({ season, rows });
}
