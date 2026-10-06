import { query } from "@/lib/db";
import { GET as getContests } from "../contests/route";

// Grand Prix crowns: one per cup a team has won, across every season this
// league has data for. A cup counts only once it's "final", and the winner
// is whoever finished 1st on that cup's leaderboard under the league's
// configured default scoring for that season and cup (Solo or Double Dash,
// with its point table) -- exactly the leaderboard api/contests already
// builds, so this reuses that route rather than re-deriving any scoring.
// The 1st-place sort already breaks contest-point ties on fantasy points;
// only a tie on both (vanishingly rare) crowns more than one team.
//
// Crowns are counted per MANAGER, since team names change between (and
// even within) seasons, then reported keyed by each manager's team name in
// the requested season so the Standings page can look them up by row.team.
//
// GET /api/crowns?league=<slug>&season=<year>
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const league = params.get("league");
  const season = Number(params.get("season"));
  if (!league || !season) {
    return Response.json({ error: "league and season query params are required" }, { status: 400 });
  }

  const seasonRows = await query(
    `SELECT DISTINCT ls.season FROM league_seasons ls
     JOIN leagues l ON l.league_id = ls.league_id
     WHERE l.slug = ? ORDER BY ls.season`,
    [league]
  ).catch(() => []);

  const byManager = new Map(); // manager -> [{ season, cup }]
  for (const { season: s } of seasonRows) {
    const res = await getContests(
      new Request(`http://internal/api/contests?season=${s}&league=${encodeURIComponent(league)}`)
    );
    if (!res.ok) continue;
    const data = await res.json();
    for (const cup of data.contests || []) {
      if (cup.status !== "final") continue;
      const board = cup.defaultMode === "doubleDash" ? cup.doubleDashLeaderboard : cup.leaderboard;
      const top = board?.[0];
      if (!top) continue;
      const winners = board.filter(
        (r) => r.contest_points === top.contest_points && r.fantasy_points === top.fantasy_points
      );
      for (const w of winners) {
        const key = w.manager ?? w.team;
        if (!byManager.has(key)) byManager.set(key, []);
        byManager.get(key).push({ season: s, cup: cup.name, team: w.team });
      }
    }
  }

  // Manager -> their team name in the requested season.
  const teamRows = await query(
    `SELECT t.team_name AS team, m.manager_name AS manager
     FROM teams t
     JOIN managers m ON m.manager_id = t.manager_id
     JOIN leagues l ON l.league_id = t.league_id
     WHERE l.slug = ? AND t.season = ?`,
    [league, season]
  ).catch(() => []);

  const crowns = {};
  for (const { team, manager } of teamRows) {
    const wins = byManager.get(manager);
    if (wins?.length) crowns[team] = { count: wins.length, wins };
  }
  return Response.json({ crowns });
}
