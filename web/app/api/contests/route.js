import { query } from "@/lib/db";

// Point-total side-contests within one league's season (e.g. weeks 1-4,
// 5-8, 9-12, 13-17). Windows are configured per league in config.json and
// loaded into the contest_windows table by the pipeline -- not hardcoded
// here, since they can vary by league/season/commissioner.
//
// Two scoring modes, both Mario-Kart-style weekly placement points that
// accumulate cumulatively across a contest window's weeks (each week's
// ranking is recomputed fresh from that week's raw score, not a running
// total), and both sorted by summed placement points with fantasy points
// only as a reference/tiebreak column:
//
// - Solo: every team in the league is individually ranked by that week's
//   fantasy score. Placement points via POINT_TABLE.
// - Double Dash: this week's actual head-to-head matchup pairs form Mario-
//   Kart-Double-Dash-style teams -- both teams' scores are summed into one
//   combined score, every pair in the league is ranked by that combined
//   score, and BOTH members of a pair receive the full placement points
//   for wherever the pair landed (via DOUBLE_DASH_POINT_TABLE). A team on
//   a bye (or otherwise missing a matchup that week) has no partner, so it
//   races alone -- still ranked against everyone else's combined score,
//   just on its own single score instead of a pair's.
//
// Both modes score off weekly_manager_points (each team's own summed
// starters), not matchups.home_points/away_points. Those two only agree
// most weeks -- this league awards the higher-seeded team in a matchup a
// +1 "home field advantage" point, which ESPN bakes into totalPoints (and
// therefore matchups.home_points) but which was never a real player stat,
// so weekly_manager_points never has it. That's exactly what's wanted:
// the bonus point should count for the real scoreboard/standings
// (matchups table, untouched) but not for Mario Kart placement.
//
// GET /api/contests?league=<slug>&season=2025

// Indexed by rank - 1 (rank 1 -> POINT_TABLE[0]). Sized for a 12-team
// league; a team placing beyond this list scores 0.
const POINT_TABLE = [12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
// Double Dash pairs up a 12-team league into 6 pairs, so only 6 placements
// exist most weeks; a pair placing beyond this list scores 0.
const DOUBLE_DASH_POINT_TABLE = [12, 10, 9, 8, 7, 5];

function placementPoints(rank) {
  return rank - 1 < POINT_TABLE.length ? POINT_TABLE[rank - 1] : 0;
}

function placementPointsDoubleDash(rank) {
  return rank - 1 < DOUBLE_DASH_POINT_TABLE.length ? DOUBLE_DASH_POINT_TABLE[rank - 1] : 0;
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

  // Double Dash: pair each week's actual head-to-head matchup, rank pairs
  // against every other pair in the league that week, and give BOTH
  // members that placement's points -- each still keeps their own
  // individual (weekly_manager_points) score as their reference column,
  // only the placement points come from the pair.
  //
  // Only used to find out *who played whom* -- not for the point values
  // themselves (see the file-level comment above for why: matchups'
  // points include a +1 bonus that shouldn't reach Mario Kart scoring).
  const matchupRows = await query(
    `SELECT mu.week,
            hm.manager_name AS home_manager,
            am.manager_name AS away_manager,
            mu.is_bye AS is_bye
     FROM matchups mu
     JOIN teams ht ON ht.team_id = mu.home_team_id
     JOIN managers hm ON hm.manager_id = ht.manager_id
     LEFT JOIN teams at ON at.team_id = mu.away_team_id
     LEFT JOIN managers am ON am.manager_id = at.manager_id
     WHERE mu.season = ? AND mu.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY mu.week`,
    [season, league]
  );

  // week -> manager -> points, straight off weeklyRows (already fetched
  // above for Solo) -- the bonus-free source of truth for what everyone
  // actually scored that week, including teams a matchup row might not
  // capture (see weekly_manager_points' own comment in db.py).
  const pointsByWeek = new Map();
  for (const row of weeklyRows) {
    if (!pointsByWeek.has(row.week)) pointsByWeek.set(row.week, new Map());
    pointsByWeek.get(row.week).set(row.manager, row.points);
  }

  const pairsByWeek = new Map(); // week -> [{ pairScore, members: [{manager, points}, ...] }]
  const pairedManagersByWeek = new Map(); // week -> Set(manager) -- who's already covered by a real pair

  for (const row of matchupRows) {
    if (row.is_bye || row.away_manager == null) continue; // no opponent -- handled in the sweep below
    const weekPoints = pointsByWeek.get(row.week) || new Map();
    const homePoints = weekPoints.get(row.home_manager) ?? 0;
    const awayPoints = weekPoints.get(row.away_manager) ?? 0;

    if (!pairsByWeek.has(row.week)) pairsByWeek.set(row.week, []);
    pairsByWeek.get(row.week).push({
      pairScore: homePoints + awayPoints,
      members: [
        { manager: row.home_manager, points: homePoints },
        { manager: row.away_manager, points: awayPoints },
      ],
    });

    if (!pairedManagersByWeek.has(row.week)) pairedManagersByWeek.set(row.week, new Set());
    pairedManagersByWeek.get(row.week).add(row.home_manager);
    pairedManagersByWeek.get(row.week).add(row.away_manager);
  }

  // Anyone who fielded a lineup that week but wasn't part of a real pair --
  // a bye, or a week the platform's schedule just doesn't list a matchup
  // for -- still races, alone, ranked on their own score against
  // everyone else's combined pair score. Not excluded from scoring.
  for (const [week, weekPoints] of pointsByWeek) {
    const paired = pairedManagersByWeek.get(week) || new Set();
    for (const [manager, points] of weekPoints) {
      if (paired.has(manager)) continue;
      if (!pairsByWeek.has(week)) pairsByWeek.set(week, []);
      pairsByWeek.get(week).push({ pairScore: points, members: [{ manager, points }] });
    }
  }

  const doubleDashRanked = []; // { week, manager, points, rank, placement_points }
  for (const [week, pairs] of pairsByWeek) {
    pairs.sort((a, b) => b.pairScore - a.pairScore);
    pairs.forEach((pair, i) => {
      const rank = i + 1;
      const placement_points = placementPointsDoubleDash(rank);
      for (const member of pair.members) {
        doubleDashRanked.push({ week, manager: member.manager, points: member.points, rank, placement_points });
      }
    });
  }

  // Sums a set of ranked rows into manager -> cumulative { contest_points,
  // fantasy_points }, the same reduction used for both the real leaderboard
  // and the "as of last week" snapshot used for rank-movement arrows below.
  function sumByManager(rows) {
    const totals = new Map();
    for (const r of rows) {
      if (!totals.has(r.manager)) totals.set(r.manager, { contest_points: 0, fantasy_points: 0, byWeek: {} });
      const t = totals.get(r.manager);
      t.contest_points += r.placement_points;
      t.fantasy_points += r.points;
      t.byWeek[r.week] = r.placement_points;
    }
    return totals;
  }

  // Same tiebreak the real leaderboard is sorted by (contest/placement
  // points, fantasy points as the tiebreaker) -- rank movement has to be
  // measured against that order, not whichever sort the "Sort by" toggle
  // happens to have selected client-side.
  function rankByContestPoints(totals) {
    const sorted = [...totals.entries()].sort(
      (a, b) => b[1].contest_points - a[1].contest_points || b[1].fantasy_points - a[1].fantasy_points
    );
    const ranks = new Map();
    sorted.forEach(([manager], i) => ranks.set(manager, i + 1));
    return ranks;
  }

  // Builds one mode's leaderboard for one contest window -- shared by Solo
  // (fed `ranked`) and Double Dash (fed `doubleDashRanked`) below, since
  // everything past "here are this window's ranked rows" (cumulative
  // totals, sort, rank, rank-movement-vs-last-week) is identical between
  // the two modes.
  function buildLeaderboard(rankedRows, w) {
    const contestWeeks = [];
    for (let wk = w.start_week; wk <= w.end_week; wk++) contestWeeks.push(wk);

    const inWindow = rankedRows.filter((r) => r.week >= w.start_week && r.week <= w.end_week);
    const playedWeeksInWindow = [...new Set(inWindow.map((r) => r.week))].sort((a, b) => a - b);
    const latestPlayedWeek = playedWeeksInWindow[playedWeeksInWindow.length - 1];

    const totals = sumByManager(inWindow);

    // Rank movement within this cup vs. the previous played week -- not
    // the previous week overall, since a cup only spans its own weeks.
    // Needs at least two played weeks in the window to have a "before".
    let previousRanks = new Map();
    if (playedWeeksInWindow.length >= 2) {
      const priorRows = inWindow.filter((r) => r.week < latestPlayedWeek);
      previousRanks = rankByContestPoints(sumByManager(priorRows));
    }

    return [...totals.entries()]
      .map(([manager, t]) => ({
        manager,
        team: managerTeam.get(manager) ?? manager,
        contest_points: t.contest_points,
        fantasy_points: Number(t.fantasy_points.toFixed(2)),
        weekly_points: contestWeeks.map((wk) => t.byWeek[wk] ?? null),
      }))
      // Sort by contest (placement) points, not fantasy points. Fantasy
      // points only break ties.
      .sort((a, b) => b.contest_points - a.contest_points || b.fantasy_points - a.fantasy_points)
      .map(({ manager, ...row }, i) => {
        const rank = i + 1;
        const previousRank = previousRanks.get(manager) ?? null;
        return {
          rank,
          // Positive = moved up (a lower rank number is better); null = no
          // earlier played week in this cup to compare against yet.
          rankDelta: previousRank != null ? previousRank - rank : null,
          ...row,
        };
      });
  }

  const contests = windows.map((w) => {
    const contestWeeks = [];
    for (let wk = w.start_week; wk <= w.end_week; wk++) contestWeeks.push(wk);

    return {
      name: w.name,
      start_week: w.start_week,
      end_week: w.end_week,
      weeks: contestWeeks,
      status: maxWeek >= w.end_week ? "final" : maxWeek >= w.start_week ? "in_progress" : "upcoming",
      leaderboard: buildLeaderboard(ranked, w),
      doubleDashLeaderboard: buildLeaderboard(doubleDashRanked, w),
    };
  });

  return Response.json({ season, maxWeek, leagueName, contests });
}
