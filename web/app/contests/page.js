"use client";

import { Suspense, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import SeasonSelect from "../components/SeasonSelect";
import LeagueSelect from "../components/LeagueSelect";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

// Matches the palette used for the Standings/Players trend charts, for a
// consistent look across the app's line charts.
const COLORS = [
  "#5b9dff", "#3ecf8e", "#ff6b6b", "#d9b64e", "#c77dff",
  "#4dd4d4", "#ff9f5b", "#9fd35c", "#f06292", "#7986cb",
  "#a1887f", "#90a4ae",
];

const STATUS_LABEL = {
  final: "Final",
  in_progress: "In Progress",
  upcoming: "Upcoming",
};
const STATUS_BADGE_CLASS = {
  final: "win",
  in_progress: "tie",
  upcoming: "bye",
};

// Simple original icons evoking each cup (not reproductions of Nintendo's
// artwork/trademarks) so each contest panel is visually distinct at a glance.
function MushroomIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 11a10 6 0 0 1 20 0Z" fill="#ff6b6b" />
      <circle cx="8" cy="8.5" r="1.4" fill="#fff" />
      <circle cx="14" cy="7" r="1.1" fill="#fff" />
      <circle cx="17.5" cy="10" r="1" fill="#fff" />
      <rect x="8.5" y="11" width="7" height="8" rx="3" fill="#f2e9d8" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.7 6.2 6.6.6-5 4.5 1.5 6.6L12 16.9l-5.8 3.5 1.5-6.6-5-4.5 6.6-.6Z"
        fill="#f0d84a"
      />
    </svg>
  );
}

const CUP_ICONS = {
  "Mushroom Cup": MushroomIcon,
  "Flower Cup": "\u{1F337}", // tulip
  "Star Cup": StarIcon,
  "Special Cup": "\u{1F451}", // crown
};

// Movement vs. this cup's previous played week (see the contests API route
// for how it's computed -- always against the placement-points rank,
// regardless of whether the "Sort by" toggle below currently has fantasy
// points selected instead). Nothing renders for a team that held its
// spot, or before a second week has been played in this cup.
function RankDelta({ delta }) {
  if (!delta) return null;
  const up = delta > 0;
  const magnitude = Math.abs(delta);
  return (
    <span
      title={`${up ? "Up" : "Down"} ${magnitude} spot${magnitude === 1 ? "" : "s"} vs last week`}
      style={{
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 700,
        color: up ? "var(--win)" : "var(--loss)",
        whiteSpace: "nowrap",
      }}
    >
      {up ? "▲" : "▼"}
      {magnitude}
    </span>
  );
}

function ContestPanel({ contest }) {
  // Which ranking to show: Solo (each team ranked individually every week)
  // or Double Dash (that week's real head-to-head matchup pairs combine
  // scores and get ranked as a pair -- see the contests API route for the
  // full scoring rules). Independent of the Sort by toggle below, which
  // only changes display order within whichever mode is selected.
  const [mode, setMode] = useState("solo");
  // Descending only, per spec -- just which column, not direction.
  const [sortBy, setSortBy] = useState("contest_points");
  const [view, setView] = useState("table");
  // Clicking a team's name in the chart legend narrows the chart to just
  // that team's line; clicking it again, or clicking anywhere else in the
  // chart, clears it back to showing everyone.
  const [selectedTeam, setSelectedTeam] = useState(null);

  const modeLeaderboard = mode === "solo" ? contest.leaderboard : contest.doubleDashLeaderboard;

  const sortedLeaderboard = useMemo(() => {
    const rows = [...modeLeaderboard].sort((a, b) => b[sortBy] - a[sortBy]);
    return rows.map((row, i) => ({ ...row, displayRank: i + 1 }));
  }, [modeLeaderboard, sortBy]);

  // One point per week, each team's *cumulative* placement points through
  // that week -- running total, not that week's placement alone (which is
  // what the table's Wk columns already show). A team's line stops at the
  // last week it actually has placement points for, rather than drawing a
  // flat line through weeks that haven't been played yet in this cup.
  const chartData = useMemo(() => {
    const running = new Map(); // team -> running total so far
    return contest.weeks.map((wk, i) => {
      const point = { week: wk };
      for (const row of modeLeaderboard) {
        const weekPoints = row.weekly_points[i];
        if (weekPoints == null) continue; // not played yet -- leave this team out of this week's point
        const total = (running.get(row.team) || 0) + weekPoints;
        running.set(row.team, total);
        point[row.team] = total;
      }
      return point;
    });
  }, [modeLeaderboard, contest.weeks]);

  // Colors keyed off alphabetical team order -- same convention the
  // Standings trend chart uses (see pivotWeekly in standings/page.js) --
  // so a given team gets the same color there and on every cup's chart
  // here, rather than each cup assigning colors off its own current
  // rank order (which would drift cup to cup, and from Standings, as
  // relative standings shift).
  const sortedTeams = useMemo(
    () => modeLeaderboard.map((row) => row.team).sort(),
    [modeLeaderboard]
  );

  // event is the underlying MouseEvent for both Legend's and Line's onClick
  // (Recharts passes it as the 3rd argument either way) -- stopping it from
  // bubbling is what keeps selecting a team from immediately re-triggering
  // the chart wrapper's own onClick, which is what clears the selection.
  function selectTeam(team, event) {
    event?.stopPropagation();
    setSelectedTeam((prev) => (prev === team ? null : team));
  }

  // Built from the full leaderboard, not whichever teams currently have a
  // rendered Line -- otherwise the legend would shrink down to just the
  // selected team once isolated, and there'd be no way to click over to a
  // different team without resetting first.
  const legendPayload = modeLeaderboard.map((row) => ({
    value: row.team,
    type: "line",
    color: COLORS[sortedTeams.indexOf(row.team) % COLORS.length],
  }));
  const visibleRows = selectedTeam
    ? modeLeaderboard.filter((row) => row.team === selectedTeam)
    : modeLeaderboard;

  const Icon = CUP_ICONS[contest.name];

  return (
    <div className="panel">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {typeof Icon === "string" ? (
          <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden="true">{Icon}</span>
        ) : (
          Icon && <Icon />
        )}
        {contest.name} (Weeks {contest.start_week}-{contest.end_week}){" "}
        <span className={`badge ${STATUS_BADGE_CLASS[contest.status]}`}>{STATUS_LABEL[contest.status]}</span>
      </h2>

      {/* Two independent toggle groups (Sort by, then Mode) laid out on a
          shared grid -- see .toggle-grid in globals.css. Wide enough
          screens get both groups on one row; narrow/mobile drops to a
          two-column grid, which stacks Mode under Sort by while still
          keeping both labels the same width and both button groups
          starting at the same x, instead of each row being staggered by
          its own label's length. */}
      <div className="toggle-grid" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Sort by:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${sortBy === "contest_points" ? " selected" : ""}`}
            onClick={() => setSortBy("contest_points")}
          >
            Total
          </button>
          <button
            type="button"
            className={`week-chip${sortBy === "fantasy_points" ? " selected" : ""}`}
            onClick={() => setSortBy("fantasy_points")}
          >
            Fantasy Points (ref)
          </button>
        </div>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Mode:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${mode === "solo" ? " selected" : ""}`}
            onClick={() => setMode("solo")}
          >
            Solo
          </button>
          <button
            type="button"
            className={`week-chip${mode === "doubleDash" ? " selected" : ""}`}
            onClick={() => setMode("doubleDash")}
            title="This week's actual matchup pairs combine scores and get ranked as a pair -- both teammates score the same placement points."
          >
            Double Dash
          </button>
        </div>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>View:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${view === "table" ? " selected" : ""}`}
            onClick={() => setView("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={`week-chip${view === "chart" ? " selected" : ""}`}
            onClick={() => setView("chart")}
          >
            Chart
          </button>
        </div>
      </div>

      {view === "table" ? (
        <div className="table-scroll">
          <table className="contests-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th className="sticky-col">Team</th>
                {contest.weeks.map((wk) => (
                  <th key={wk}>Wk {wk}</th>
                ))}
                <th>Total</th>
                <th title="Fantasy Points (ref)">PF</th>
              </tr>
            </thead>
            <tbody>
              {sortedLeaderboard.map((row) => (
                <tr key={row.team} style={row.displayRank === 1 ? { fontWeight: 700 } : undefined}>
                  <td>{row.displayRank}</td>
                  <td className="sticky-col">
                    <span className="wrap-cell" style={{ display: "inline-block", verticalAlign: "middle" }}>
                      {row.team}
                    </span>
                    <RankDelta delta={row.rankDelta} />
                    {row.displayRank === 1 && (
                      <span className="badge win" style={{ marginLeft: 6 }}>
                        Leader
                      </span>
                    )}
                  </td>
                  {row.weekly_points.map((pts, i) => (
                    <td key={contest.weeks[i]}>{pts ?? "—"}</td>
                  ))}
                  <td style={sortBy === "contest_points" ? { fontWeight: 700 } : undefined}>{row.contest_points}</td>
                  <td style={sortBy === "fantasy_points" ? { fontWeight: 700 } : undefined}>{row.fantasy_points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {selectedTeam && (
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 8px" }}>
              Showing trend for <strong style={{ color: "var(--text)" }}>{selectedTeam}</strong> -- click
              elsewhere on the chart to show everyone again.
            </p>
          )}
          {/* Clicking anywhere in here that isn't a legend entry or line
              (both stop propagation in their own onClick) clears the
              selection -- CartesianGrid, empty plot area, the container
              padding, all of it. */}
          <div onClick={() => setSelectedTeam(null)}>
            <ResponsiveContainer width="100%" height={Math.max(320, modeLeaderboard.length * 24 + 200)}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#2a2e37" />
                <XAxis
                  dataKey="week"
                  stroke="#9aa1ad"
                  label={{ value: "Week", position: "insideBottom", offset: -5, fill: "#9aa1ad" }}
                />
                <YAxis
                  stroke="#9aa1ad"
                  label={{ value: "Cumulative points", angle: -90, position: "insideLeft", fill: "#9aa1ad" }}
                />
                <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
                <Legend
                  payload={legendPayload}
                  onClick={(entry, index, event) => selectTeam(entry.value, event)}
                  wrapperStyle={{ cursor: "pointer", paddingTop: 16 }}
                />
                {visibleRows.map((row) => (
                  <Line
                    key={row.team}
                    type="linear"
                    dataKey={row.team}
                    stroke={COLORS[sortedTeams.indexOf(row.team) % COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    onClick={(_, __, event) => selectTeam(row.team, event)}
                    style={{ cursor: "pointer" }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      {sortedLeaderboard.length === 0 && <div className="empty-state">No games played in this window yet.</div>}
    </div>
  );
}

function ContestsInner() {
  const [league, setLeague] = useUrlState("league");
  const [season, setSeason] = useUrlState("season");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeSeason && activeLeague
      ? `/api/contests?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );

  // Cups come back in chronological order (Mushroom -> Flower -> Star ->
  // Special), which is right for the weeks *within* a cup but backwards for
  // which cup you want to see first: the one currently being played, or
  // the last one that finished once the season's over. Reverse the order
  // and drop anything that hasn't started -- an "upcoming" cup with no
  // games yet has nothing to show, and would otherwise sit at the top
  // (since it's chronologically last) pushing the cup people actually care
  // about down the page. As the season progresses, each newly-started cup
  // takes over the top spot the same way.
  const startedContests = useMemo(
    () => (data?.contests || []).filter((c) => c.status !== "upcoming").reverse(),
    [data]
  );

  return (
    <>
      <div className="controls">
        <LeagueSelect
          leagues={meta?.leagues}
          league={activeLeague}
          onChange={(next) => setLeague(next, { clear: ["season"] })}
        />
        <SeasonSelect seasons={seasons} season={activeSeason} onChange={setSeason} />
      </div>

      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>
        {data?.leagueName ? `${data.leagueName} Grand Prix` : "Grand Prix"}
      </h1>
      <p style={{ color: "var(--text-dim)", fontSize: 14, marginTop: 0, marginBottom: 20 }}>
        Each cup has two modes. Solo ranks every team individually each week by that week&apos;s
        fantasy score, earning placement points (1st: 12, 2nd: 10, 3rd: 9, down to last: 0). Double
        Dash pairs up that week&apos;s actual head-to-head matchups instead -- both teams&apos;
        scores are combined, every pair in the league is ranked against each other, and both
        teammates earn the full placement points for wherever their pair landed (1st: 12, 2nd: 10,
        3rd: 9, 4th: 8, 5th: 7, 6th: 5). Either way, placement points accumulate within a cup&apos;s
        weeks and determine the ranking below by default; use the sort toggle on each cup to rank
        by total fantasy points instead, which is otherwise shown for reference only.
      </p>

      {loading && <div className="loading-state">Loading contests...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && data.contests.length === 0 && (
        <div className="panel">
          <div className="empty-state">
            No contest windows are configured for this season yet. Add a "contests" section for{" "}
            {activeSeason} in config.json and rerun the pipeline.
          </div>
        </div>
      )}

      {data && data.contests.length > 0 && startedContests.length === 0 && (
        <div className="panel">
          <div className="empty-state">
            No cups have started yet this season -- check back once the first week wraps up.
          </div>
        </div>
      )}

      {startedContests.map((contest) => (
        <ContestPanel key={contest.name} contest={contest} />
      ))}
    </>
  );
}

export default function ContestsPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <ContestsInner />
    </Suspense>
  );
}
