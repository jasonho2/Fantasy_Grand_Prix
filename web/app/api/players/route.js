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

  const decidedRows = await query(
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

  // The single week currently being played (if any) -- provisional
  // per-player stats pulled fresh each pipeline run, same source/shape as
  // decidedRows above, just from live_player_points instead of
  // weekly_player_points (see that table's schema comment in db.py and
  // api/matchups/route.js's analogous is_live handling). Unioned in below
  // so the Player Totals table and Points-by-Position chart both reflect
  // the in-progress week immediately rather than waiting for it to be
  // decided -- there's no win/loss concept at this granularity to worry
  // about prematurely finalizing, unlike Standings' Leaderboard table.
  const liveRows = await query(
    `SELECT lpp.week,
            m.manager_name AS manager,
            t.team_name AS team,
            p.player_name AS player,
            p.position AS position,
            lpp.points AS points
     FROM live_player_points lpp
     JOIN teams t ON t.team_id = lpp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     JOIN players p ON p.player_id = lpp.player_id
     WHERE t.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY lpp.week, manager, position, player`,
    [season, league]
  ).catch(() => []); // tolerate a not-yet-migrated DB that lacks live_player_points

  const rows = [
    ...decidedRows,
    ...liveRows.map((row) => ({ ...row, is_live: true })),
  ];

  return Response.json({ season, rows });
}
