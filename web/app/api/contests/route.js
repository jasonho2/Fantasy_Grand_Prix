import { query } from "@/lib/db";
import {
  placementPointsFor,
  effectiveDefaultTable,
  defaultModeForCup,
  normalizeCupWeeks,
} from "@/lib/scoring";

// Point-total side-contests within one league's season (e.g. weeks 1-4,
// 5-8, 9-12, 13-16). Cup names/count/order are configured per league in
// config.json and loaded into the contest_windows table by the pipeline --
// not hardcoded here, since they can vary by league/season/commissioner.
// Each cup's actual week boundaries, however, come from CUP_WEEK_SETS
// below (positionally overriding whatever's in contest_windows) so a
// viewer can toggle between the 15-week and 16-week structures live via
// ?cupWeeks=15|16, independent of season -- see that constant's comment.
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

// The *default* placement -> points tables used for the contest_points/
// rank/rankDelta this route returns are no longer fixed globally -- each
// league configures its own default per cup, per SEASON (see
// web/lib/scoring.js and the `league_seasons.scoring_config` column, set via
// Manage Leagues' passphrase-gated "Edit Scoring"), falling back to
// DEFAULT_POINT_TABLES (plain Solo, no overrides) for any season that was
// never explicitly configured. Scoring used to live on `leagues` (one
// config for every season a league has ever played) -- moved to
// league_seasons so editing one season's settings (e.g. this year's) can't
// silently rewrite an earlier season's (e.g. last year's) leaderboard too.
// weekly_rank/weekly_fantasy are included on every leaderboard row below as
// raw diagnostic data (this week's placement and fantasy score, independent
// of any point table) -- not currently consumed by the frontend, but cheap
// to include and useful for spot-checking a cup's numbers.

// The two supported Grand Prix cup lengths, viewable via ?cupWeeks=15|16 --
// independent of season (see below), since the cup leaderboard is already
// computed live from raw weekly scores per-request (nothing about a cup's
// standings is precomputed or cached beyond its week boundaries), so
// switching structures needs no pipeline re-run or database change.
//
// "15" is the original 3/4/4/4-week split (Mushroom 1-3, Flower 4-7, Star
// 8-11, Special 12-15). "16" is the league's new policy, a uniform
// 4/4/4/4-week split (Mushroom 1-4, Flower 5-8, Star 9-12, Special 13-16)
// -- the new default. Applied positionally (1st configured cup gets the
// 1st entry here, etc.) on top of whatever cups/names are configured in
// contest_windows, so a league with a different cup count just keeps its
// configured boundaries for any cups beyond these four.
const CUP_WEEK_SETS = {
  15: [
    { start_week: 1, end_week: 3 },
    { start_week: 4, end_week: 7 },
    { start_week: 8, end_week: 11 },
    { start_week: 12, end_week: 15 },
  ],
  16: [
    { start_week: 1, end_week: 4 },
    { start_week: 5, end_week: 8 },
    { start_week: 9, end_week: 12 },
    { start_week: 13, end_week: 16 },
  ],
};

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const season = Number(params.get("season"));
  const league = params.get("league");
  if (!season || !league) {
    return Response.json({ error: "season and league query params are required" }, { status: 400 });
  }
  // League-scoped row carrying the display name, this league's cup length
  // (league-wide -- doesn't vary by season), and THIS season's scoring
  // config (ls.scoring_config, not l.scoring_config -- see the file-level
  // comment above). The join is already season-scoped (ls.season = ?), so
  // pulling scoring_config off `ls` instead of `l` is what actually makes
  // scoring per-season instead of per-league. Selecting cup_weeks/
  // scoring_config here (rather than a separate query) means a
  // not-yet-migrated DB -- one the Python pipeline hasn't reconnected to
  // since these columns were added -- fails this whole query and falls back
  // to [] below, same tolerate-missing pattern used elsewhere in this route
  // (see the live_matchups query).
  const leagueRows = await query(
    `SELECT COALESCE(l.display_name, ls.league_name) AS name, l.cup_weeks AS cupWeeks, ls.scoring_config AS scoringConfigRaw
     FROM leagues l LEFT JOIN league_seasons ls ON ls.league_id = l.league_id AND ls.season = ?
     WHERE l.slug = ?`,
    [season, league]
  ).catch(() => []);
  const leagueName = leagueRows[0]?.name ?? null;
  // ?cupWeeks explicitly wins when present (the live viewer-facing toggle);
  // otherwise fall back to this league's configured default, then 16.
  const cupWeeksParam = params.get("cupWeeks");
  const cupWeeks =
    cupWeeksParam === "15" || cupWeeksParam === "16"
      ? Number(cupWeeksParam)
      : normalizeCupWeeks(leagueRows[0]?.cupWeeks);
  let scoringConfig = null;
  try {
    scoringConfig = leagueRows[0]?.scoringConfigRaw ? JSON.parse(leagueRows[0].scoringConfigRaw) : null;
  } catch {
    scoringConfig = null; // malformed JSON somehow got stored -- treat exactly like "never configured"
  }

  const configuredWindows = await query(
    `SELECT cw.id AS contest_id, cw.contest_name AS name, cw.start_week, cw.end_week, cw.sort_order
     FROM contest_windows cw
     WHERE cw.season = ? AND cw.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY cw.sort_order`,
    [season, league]
  );
  // Cup names/count/order still come from the database; only the week
  // boundaries get substituted, positionally, from whichever structure was
  // requested (see CUP_WEEK_SETS above).
  const weekOverrides = CUP_WEEK_SETS[cupWeeks];
  const windows = configuredWindows.map((w, i) => {
    const override = weekOverrides[i];
    return override ? { ...w, start_week: override.start_week, end_week: override.end_week } : w;
  });

  const weeklyRows = await query(
    `SELECT wmp.week, m.manager_name AS manager, t.team_name AS team, wmp.points
     FROM weekly_manager_points wmp
     JOIN teams t ON t.team_id = wmp.team_id
     JOIN managers m ON m.manager_id = t.manager_id
     WHERE wmp.season = ? AND t.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY wmp.week, wmp.points DESC`,
    [season, league]
  );
  // The last week ESPN has actually decided -- used below to gate a cup's
  // "final" status. Computed before merging in the live week (below) since
  // an in-progress week should never count as "decided" for that purpose,
  // even once its provisional scores are folded into the rankings.
  const maxDecidedWeek = weeklyRows.reduce((m, r) => Math.max(m, r.week), 0);

  // The single week currently being played (if any) -- provisional scores
  // pulled fresh each pipeline run, same bonus-free starter-point source as
  // every decided week (see live_matchups' schema comment in db.py and
  // api/matchups/route.js). Folded directly into the same ranking pipeline
  // as decided weeks below (not a separate code path) specifically so cup
  // standings move live as games happen, not just once a week is final --
  // the moment ESPN decides this week, live_matchups empties out and the
  // real decided-week data takes over here automatically on the next pull.
  const liveRows = await query(
    `SELECT lm.week,
            hm.manager_name AS home_manager,
            ht.team_name AS home_team,
            lm.home_points,
            am.manager_name AS away_manager,
            at.team_name AS away_team,
            lm.away_points,
            lm.is_bye
     FROM live_matchups lm
     JOIN teams ht ON ht.team_id = lm.home_team_id
     JOIN managers hm ON hm.manager_id = ht.manager_id
     LEFT JOIN teams at ON at.team_id = lm.away_team_id
     LEFT JOIN managers am ON am.manager_id = at.manager_id
     WHERE lm.season = ? AND lm.league_id = (SELECT league_id FROM leagues WHERE slug = ?)
     ORDER BY lm.week`,
    [season, league]
  ).catch(() => []); // tolerate a not-yet-migrated DB that lacks live_matchups

  const liveWeek = liveRows[0]?.week ?? null; // at most one live week ever exists at a time
  const liveWeeklyRows = []; // same shape as weeklyRows
  const liveMatchupRows = []; // same shape as matchupRows, below
  for (const row of liveRows) {
    liveWeeklyRows.push({ week: row.week, manager: row.home_manager, team: row.home_team, points: row.home_points });
    if (!row.is_bye && row.away_manager != null) {
      liveWeeklyRows.push({ week: row.week, manager: row.away_manager, team: row.away_team, points: row.away_points });
    }
    liveMatchupRows.push({
      week: row.week,
      home_manager: row.home_manager,
      away_manager: row.is_bye ? null : row.away_manager,
      is_bye: !!row.is_bye,
    });
  }

  // Everything below (Solo ranking, Double Dash pairing, managerTeam) reads
  // from allWeeklyRows/allMatchupRows rather than weeklyRows/matchupRows
  // directly, so the live week is ranked and paired exactly like any
  // decided week -- no separate logic to keep in sync.
  const allWeeklyRows = [...weeklyRows, ...liveWeeklyRows];

  // A manager maps to exactly one team for the season -- grab that mapping
  // once so the leaderboard can be built/grouped by manager (a stable key)
  // while still surfacing the team name for display.
  const managerTeam = new Map();
  for (const row of allWeeklyRows) {
    if (!managerTeam.has(row.manager)) managerTeam.set(row.manager, row.team);
  }

  // Rank each week's teams by that week's fantasy points. Placement points
  // aren't assigned here anymore -- which table applies can differ per cup
  // (a league's per-cup scoring config), so turning a rank into points
  // happens later, inside buildLeaderboard, once it's known which cup's
  // window a given week falls into.
  const byWeek = new Map();
  for (const row of allWeeklyRows) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, []);
    byWeek.get(row.week).push(row);
  }

  const ranked = []; // { week, manager, points, rank }
  let maxWeek = 0; // latest week with ANY data, decided or live -- see maxDecidedWeek above for "final" gating
  for (const [week, teams] of byWeek) {
    maxWeek = Math.max(maxWeek, week);
    teams.sort((a, b) => b.points - a.points); // rows already came sorted; be explicit anyway
    teams.forEach((row, i) => {
      ranked.push({ week, manager: row.manager, points: row.points, rank: i + 1 });
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
  // Live week's pairings (built above from live_matchups) folded in the
  // same way as allWeeklyRows above -- the pairing loop below doesn't need
  // to know or care that this week isn't decided yet.
  const allMatchupRows = [...matchupRows, ...liveMatchupRows];

  // week -> manager -> points, straight off allWeeklyRows (Solo's decided
  // + live rows from above) -- the bonus-free source of truth for what
  // everyone actually scored that week, including teams a matchup row
  // might not capture (see weekly_manager_points' own comment in db.py).
  const pointsByWeek = new Map();
  for (const row of allWeeklyRows) {
    if (!pointsByWeek.has(row.week)) pointsByWeek.set(row.week, new Map());
    pointsByWeek.get(row.week).set(row.manager, row.points);
  }

  const pairsByWeek = new Map(); // week -> [{ pairScore, members: [{manager, points}, ...] }]
  const pairedManagersByWeek = new Map(); // week -> Set(manager) -- who's already covered by a real pair

  for (const row of allMatchupRows) {
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

  const doubleDashRanked = []; // { week, manager, points, rank }
  for (const [week, pairs] of pairsByWeek) {
    pairs.sort((a, b) => b.pairScore - a.pairScore);
    pairs.forEach((pair, i) => {
      const rank = i + 1;
      for (const member of pair.members) {
        doubleDashRanked.push({ week, manager: member.manager, points: member.points, rank });
      }
    });
  }

  // Sums a set of ranked rows into manager -> cumulative { contest_points,
  // fantasy_points }, the same reduction used for both the real leaderboard
  // and the "as of last week" snapshot used for rank-movement arrows below.
  // `table` is the fully-resolved placement->points table *for this specific
  // cup* (its configured default, from buildLeaderboard) -- turning a raw
  // rank into placement points happens right here, not earlier, so the same
  // rank in two different cups can score differently under a per-cup
  // scoring config. byWeek keeps the raw rank and fantasy points too (not
  // just this table's placement points), not needed for the totals here but
  // carried through into buildLeaderboard's output below so the frontend can
  // re-derive placement points from a user-supplied custom table without
  // another round trip -- see weekly_rank/weekly_fantasy.
  function sumByManager(rows, table) {
    const totals = new Map();
    for (const r of rows) {
      if (!totals.has(r.manager)) totals.set(r.manager, { contest_points: 0, fantasy_points: 0, byWeek: {} });
      const t = totals.get(r.manager);
      const placement_points = placementPointsFor(r.rank, table);
      t.contest_points += placement_points;
      t.fantasy_points += r.points;
      t.byWeek[r.week] = { rank: r.rank, points: r.points, placement_points };
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
  // the two modes. `table` is this cup's fully-resolved default placement
  // table for whichever mode is being built (see effectiveDefaultTable) --
  // passed in by the caller rather than looked up in here, since it depends
  // on both the cup index and the mode, neither of which this function
  // otherwise needs to know about.
  function buildLeaderboard(rankedRows, w, table) {
    const contestWeeks = [];
    for (let wk = w.start_week; wk <= w.end_week; wk++) contestWeeks.push(wk);

    const inWindow = rankedRows.filter((r) => r.week >= w.start_week && r.week <= w.end_week);
    const playedWeeksInWindow = [...new Set(inWindow.map((r) => r.week))].sort((a, b) => a - b);
    const latestPlayedWeek = playedWeeksInWindow[playedWeeksInWindow.length - 1];

    const totals = sumByManager(inWindow, table);

    // Rank movement within this cup vs. the previous played week -- not
    // the previous week overall, since a cup only spans its own weeks.
    // Needs at least two played weeks in the window to have a "before".
    let previousRanks = new Map();
    if (playedWeeksInWindow.length >= 2) {
      const priorRows = inWindow.filter((r) => r.week < latestPlayedWeek);
      previousRanks = rankByContestPoints(sumByManager(priorRows, table));
    }

    return [...totals.entries()]
      .map(([manager, t]) => ({
        manager,
        team: managerTeam.get(manager) ?? manager,
        contest_points: t.contest_points,
        fantasy_points: Number(t.fantasy_points.toFixed(2)),
        weekly_points: contestWeeks.map((wk) => t.byWeek[wk]?.placement_points ?? null),
        // Raw weekly placement (1st, 2nd, ...) and raw weekly fantasy score,
        // independent of any point table -- see the file-level comment
        // above on weekly_rank/weekly_fantasy.
        weekly_rank: contestWeeks.map((wk) => t.byWeek[wk]?.rank ?? null),
        weekly_fantasy: contestWeeks.map((wk) => t.byWeek[wk]?.points ?? null),
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

  const contests = windows.map((w, i) => {
    const contestWeeks = [];
    for (let wk = w.start_week; wk <= w.end_week; wk++) contestWeeks.push(wk);

    // This cup's configured default (falls back to plain Solo, no
    // overrides, for a league that never set one) -- `i` lines up
    // positionally with CUP_NAMES the same way weekOverrides does above.
    const soloTable = effectiveDefaultTable(scoringConfig, i, "solo");
    const doubleDashTable = effectiveDefaultTable(scoringConfig, i, "doubleDash");

    return {
      name: w.name,
      start_week: w.start_week,
      end_week: w.end_week,
      weeks: contestWeeks,
      // "final" requires the cup's last week to be actually decided, not
      // just live -- maxDecidedWeek (not maxWeek) gates that, so a cup
      // whose final week is the one currently being played correctly stays
      // "in_progress" (via maxWeek, which does include the live week) until
      // ESPN calls it, instead of flashing "Final" early.
      status:
        maxDecidedWeek >= w.end_week ? "final" : maxWeek >= w.start_week ? "in_progress" : "upcoming",
      liveWeek: liveWeek != null && liveWeek >= w.start_week && liveWeek <= w.end_week ? liveWeek : null,
      leaderboard: buildLeaderboard(ranked, w, soloTable),
      doubleDashLeaderboard: buildLeaderboard(doubleDashRanked, w, doubleDashTable),
      // Which mode/table the league configured as this cup's default (for
      // this season) -- lets the frontend open on that mode, treat it as
      // what "Reset to Default" resets the view back to, and describe it in
      // the scoring badge next to the cup title.
      defaultMode: defaultModeForCup(scoringConfig, i),
      defaultPointTable: { solo: soloTable, doubleDash: doubleDashTable },
    };
  });

  return Response.json({ season, cupWeeks, maxWeek, maxDecidedWeek, liveWeek, leagueName, contests });
}
