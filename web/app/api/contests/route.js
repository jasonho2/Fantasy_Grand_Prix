import { query } from "@/lib/db";

// Point-total side-contests within a season (e.g. weeks 1-4, 5-8, 9-12,
// 13-17). Windows are configured per season in config.json and loaded into
// the contest_windows table by the Python pipeline -- not hardcoded here,
// since they can vary by season/commissioner.
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
// GET /api/contests?season=2025

// Indexed by rank - 1 (rank 1 -> POINT_TABLE[0]). Sized for a 12-team
// league; a team placing beyond this list scores 0.
const POINT_TABLE = [12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

function placementPoints(rank) {
  return rank - 1 < POINT_TABLE.length ? POINT_TABLE[rank - 1] : 0;
}

export async function GET(request) {
  const season = Number(new URL(request.url).searchParams.get("season"));
  if (!season) {
    return Response.json({ error: "season query param is required" }, { status: 400 });
  }

  const windows = await query(
    `SELECT id AS contest_id, contest_name AS name, start_week, end_week, sort_order
     FROM contest_windows WHERE season = ? ORDER BY sort_order`,
    [season]
  );

  const weeklyRows = await query(
    `SELECT wmp.week, m.manager_name AS manager, wmp.points
     FROM weekly_manager_points wmp
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE wmp.season = ?
     ORDER BY wmp.week, wmp.points DESC`,
    [season]
  );

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
    const inWindow = ranked.filter((r) => r.week >= w.start_week && r.week <= w.end_week);

    const totals = new Map(); // manager -> { contest_points, fantasy_points }
    for (const r of inWindow) {
      if (!totals.has(r.manager)) totals.set(r.manager, { contest_points: 0, fantasy_points: 0 });
      const t = totals.get(r.manager);
      t.contest_points += r.placement_points;
      t.fantasy_points += r.points;
    }

    const leaderboard = [...totals.entries()]
      .map(([manager, t]) => ({
        manager,
        contest_points: t.contest_points,
        fantasy_points: Number(t.fantasy_points.toFixed(2)),
      }))
      // Sort by contest (placement) points, not fantasy points. Fantasy
      // points only break ties.
      .sort((a, b) => b.contest_points - a.contest_points || b.fantasy_points - a.fantasy_points)
      .map((row, i) => ({ rank: i + 1, ...row }));

    return {
      name: w.name,
      start_week: w.start_week,
      end_week: w.end_week,
      status: maxWeek >= w.end_week ? "final" : maxWeek >= w.start_week ? "in_progress" : "upcoming",
      leaderboard,
    };
  });

  return Response.json({ season, maxWeek, contests });
}
