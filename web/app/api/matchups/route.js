import { query } from "@/lib/db";

// Full schedule/results for one league's season. Head-to-head records are
// derived client-side from this list rather than a separate query.
// GET /api/matchups?league=<slug>&season=2025
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const season = Number(params.get("season"));
  const league = params.get("league");
  if (!season || !league) {
    return Response.json({ error: "season and league query params are required" }, { status: 400 });
  }

  // On a bye week there's no opponent, so matchups.home_points is just
  // whatever ESPN reported as that team's own weekly total -- which for a
  // *real* matchup would include the league's +1 "home field advantage"
  // bonus for the higher seed (see api/contests/route.js's file comment for
  // the full explanation). There's no second team to be "higher seed"
  // against on a bye, so the bonus likely never applies there in practice,
  // but rather than rely on that, bye rows get their score overridden below
  // with weekly_manager_points -- the sum of that week's actual starter
  // stat lines, which is bonus-free by construction (it's built from
  // weekly_player_points, not matchups, same as the Grand Prix contests
  // scoring) -- so a bye week's displayed score is guaranteed to be just
  // starter points, never a bonus point, regardless of what ESPN did.
  const rawRows = await query(
    `SELECT mu.week,
            ht.team_name AS home_team,
            at.team_name AS away_team,
            mu.home_points,
            mu.away_points,
            mu.winner,
            mu.is_bye,
            wmp.points AS home_starter_points
     FROM matchups mu
     JOIN teams ht ON ht.team_id = mu.home_team_id
     LEFT JOIN teams at ON at.team_id = mu.away_team_id
     LEFT JOIN weekly_manager_points wmp
       ON wmp.team_id = mu.home_team_id AND wmp.week = mu.week AND wmp.season = mu.season
     WHERE mu.season = ? AND mu.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY mu.week`,
    [season, league]
  );

  const rows = rawRows.map(({ home_starter_points, ...row }) =>
    row.is_bye && home_starter_points != null ? { ...row, home_points: home_starter_points } : row
  );

  return Response.json({ season, rows });
}
