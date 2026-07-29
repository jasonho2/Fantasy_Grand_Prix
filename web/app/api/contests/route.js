import { query } from "@/lib/db";

// Point-total side-contests within one league's season (e.g. weeks 1-4,
// 5-8, 9-12, 13-17). Windows are configured per league in config.json and
// loaded into the contest_windows table by the pipeline -- not hardcoded
// here, since they can vary by league/season/commissioner.
//
// Scoring: Mario-Kart-style weekly placement points. Every week, ALL teams
// in the league are ranked by that week's fantasy score (highest first);
// rank determines placement points for that week via POINT_TABLE below.
// Placement points accumulate cumulatively across a contest window's weeks
// (ranking itself is recomputed fresh each week from that week's raw score,
// not from a running fantasy-point total). A contest's leaderboard is
// sorted by summed placement points, not by fantasy points -- fantasy
// points are still summed and returned per manager as a reference column.
//
// GET /api/contests?league=<slug>&season=2025

// Indexed by rank - 1 (rank 1 -> POINT_TABLE[0]). Sized for a 12-team
// league; a team placing beyond this list scores 0.
const POINT_TABLE = [12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

function placementPoints(rank) {
  return rank - 1 < POINT_TABLE.length ? POINT_TABLE[rank - 1] : 0;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const season = Number(params.get("season"));
  const league = params.get("league");
  if (!season || !league) {
    return Response.json({ error: "season and league query params are required" }, { status: 400 });
  }

  const nameRows = await query(
    `SELECT COALESCE(l.display_name, ls.league_name) AS name
     FROM leagues l LEFT JOIN league_seasons ls ON ls.league_id = l.league_id AND ls.season = ?
     WHERE l.slug = ?`,
    [season, league]
  ).catch(() => []);
  const leagueName = nameRows[0]?.name ?? null;

  const windows = await query(
    `SELECT cw.id AS contest_id, cw.contest_name AS name, cw.start_week, cw.end_week, cw.sort_order
     FROM contest_windows cw
     WHERE cw.season = ? AND cw.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY cw.sort_order`,
    [season, league]
  );

  const weeklyRows = await query(
    `SELECT wmp.week, m.manager_name AS manager, t.team_name AS team, wmp.points
     FROM weekly_manager_points wmp
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE wmp.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY wmp.week, wmp.points DESC`,
    [season, league]
  );

  // A manager maps to exactly one team for the season -- grab that mapping
  // once so the leaderboard can be built/grouped by manager (a stable key)
  // while still surfacing the team name for display.
  const managerTeam = new Map();
  for (const row of weeklyRows) {
    if (!managerTeam.has(row.manager)) managerTeam.set(row.manager, row.team);
  }

  // Rank each week's teams by that week's fantasy points, assign placement points.
  const byWeek = new Map();
  for (const row of weeklyRows) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, []);
    byWeek.get(row.week).push(row);
  }

  const ranked = []; // { week, manager, points, rank, placement_points }
  let maxWeek = 0;
  for (const [week, teams] of byWeek) {
    maxWeek = Math.max(maxWeek, week);
    teams.sort((a, b) => b.points - a.points); // rows already came sorted; be explicit anyway
    teams.forEach((row, i) => {
      const rank = i + 1;
      ranked.push({ week, manager: row.manager, points: row.points, rank, placement_points: placementPoints(rank) });
    });
  }

  const contests = windows.map((w) => {
    const contestWeeks = [];
    for (let wk = w.start_week; wk <= w.end_week; wk++) contestWeeks.push(wk);

    const inWindow = ranked.filter((r) => r.week >= w.start_week && r.week <= w.end_week);

    // manager -> { contest_points, fantasy_points, byWeek: { week: placement_points } }
    const totals = new Map();
    for (const r of inWindow) {
      if (!totals.has(r.manager)) {
        totals.set(r.manager, { contest_points: 0, fantasy_points: 0, byWeek: {} });
      }
      const t = totals.get(r.manager);
      t.contest_points += r.placement_points;
      t.fantasy_points += r.points;
      t.byWeek[r.week] = r.placement_points;
    }

    const leaderboard = [...totals.entries()]
      .map(([manager, t]) => ({
        team: managerTeam.get(manager) ?? manager,
        contest_points: t.contest_points,
        fantasy_points: Number(t.fantasy_points.toFixed(2)),
        weekly_points: contestWeeks.map((wk) => t.byWeek[wk] ?? null),
      }))
      // Sort by contest (placement) points, not fantasy points. Fantasy
      // points only break ties.
      .sort((a, b) => b.contest_points - a.contest_points || b.fantasy_points - a.fantasy_points)
      .map((row, i) => ({ rank: i + 1, ...row }));

    return {
      name: w.name,
      start_week: w.start_week,
      end_week: w.end_week,
      weeks: contestWeeks,
      status: maxWeek >= w.end_week ? "final" : maxWeek >= w.start_week ? "in_progress" : "upcoming",
      leaderboard,
    };
  });

  return Response.json({ season, maxWeek, leagueName, contests });
}
