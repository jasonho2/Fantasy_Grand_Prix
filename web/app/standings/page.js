"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import SeasonSelect from "../components/SeasonSelect";
import LeagueSelect from "../components/LeagueSelect";
import TeamLogo from "../components/TeamLogo";
import ChartTeamLogoDot, { slugForId, lastValidRowIndex } from "../components/ChartTeamLogoDot";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

const COLORS = [
  "#5b9dff", "#3ecf8e", "#ff6b6b", "#d9b64e", "#c77dff",
  "#4dd4d4", "#ff9f5b", "#9fd35c", "#f06292", "#7986cb",
  "#a1887f", "#90a4ae",
];

// Track width the slider line/fill are drawn at, plus the thumb radius
// reserved as padding on each side -- same slider as Players & Positions
// (see that page for the fuller explanation of the math).
const SLIDER_TRACK_WIDTH = 240;
const SLIDER_THUMB_RADIUS = 7;

// Weekly (non-cumulative) view: one row per week in range, one column per
// team, that week's raw value. Rounded to 2 decimals for display -- the
// underlying weekly_manager_points values already are (see its ROUND() in
// db.py), so this is mostly a safety net; Grand Prix's placement points
// are always whole numbers, so rounding is a no-op there either way.
function pivotWeekly(weekly, rangeMin, rangeMax) {
  const teams = [...new Set(weekly.map((r) => r.team))].sort();
  const byWeek = new Map();
  for (const row of weekly) {
    if (row.week < rangeMin || row.week > rangeMax) continue;
    if (!byWeek.has(row.week)) byWeek.set(row.week, { week: row.week });
    byWeek.get(row.week)[row.team] = row.points == null ? row.points : Number(row.points.toFixed(2));
  }
  const rows = [...byWeek.values()].sort((a, b) => a.week - b.week);
  return { teams, rows };
}

// Cumulative view: running total *within the visible range* -- resets to 0
// at rangeMin rather than always accumulating from week 1, so narrowing
// the slider shows "how's this stretch of weeks gone" rather than always
// carrying the whole season's head start. A team's line stops wherever it
// last had data, rather than drawing a flat line through a week it has no
// row for (bye weeks still have a row here since weekly_manager_points is
// bye-inclusive; a genuinely missing week -- nothing pulled yet -- does not).
function pivotCumulative(weekly, rangeMin, rangeMax) {
  const teams = [...new Set(weekly.map((r) => r.team))].sort();
  const weeksInRange = [...new Set(weekly.map((r) => r.week))]
    .filter((w) => w >= rangeMin && w <= rangeMax)
    .sort((a, b) => a - b);
  const byTeamWeek = new Map(); // `${team}|${week}` -> points
  for (const row of weekly) byTeamWeek.set(`${row.team}|${row.week}`, row.points);

  const running = new Map();
  const rows = weeksInRange.map((week) => {
    const point = { week };
    for (const team of teams) {
      const p = byTeamWeek.get(`${team}|${week}`);
      if (p == null) continue;
      // Rounded at every step, not just the final value -- summing
      // already-rounded weekly figures in floating point can otherwise
      // drift to something like 35.369999999999997 a few weeks in.
      const total = Number(((running.get(team) || 0) + p).toFixed(2));
      running.set(team, total);
      point[team] = total;
    }
    return point;
  });
  return { teams, rows };
}

// Re-aggregates the Season Leaderboard table for whatever week range the
// shared slider below is currently set to -- mirrors exactly what
// api/standings/route.js's SQL used to do server-side at a fixed cutoff
// (SUM wins/losses/ties/points, AVG points per game, over non-bye
// matchups only), just computed client-side so it can respond to an
// arbitrary user-chosen range without a round trip.
function computeStandings(weeklyRecords, rangeMin, rangeMax) {
  const byTeam = new Map();
  for (const r of weeklyRecords) {
    if (r.week < rangeMin || r.week > rangeMax) continue;
    if (!byTeam.has(r.team)) {
      byTeam.set(r.team, { team: r.team, wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0, games: 0 });
    }
    const t = byTeam.get(r.team);
    t.wins += r.win;
    t.losses += r.loss;
    t.ties += r.tie;
    t.points_for += r.points_for;
    t.points_against += r.points_against;
    t.games += 1;
  }
  return [...byTeam.values()].map((t) => ({
    team: t.team,
    wins: t.wins,
    losses: t.losses,
    ties: t.ties,
    points_for: Number(t.points_for.toFixed(2)),
    points_against: Number(t.points_against.toFixed(2)),
    avg_points: t.games ? Number((t.points_for / t.games).toFixed(2)) : 0,
  }));
}

// One consolidated trend chart (covers the full season, weeks 1-N, not
// split into separate regular-season/playoff charts) with a Weekly/
// Cumulative toggle and an optional divider line at the regular-season/
// playoff boundary. Used twice below -- once for raw fantasy points, once
// for Grand Prix (Mario Kart placement) points -- sharing the page-level
// week-range slider and team-selection state so isolating a team, or
// narrowing the weeks shown, affects both charts together.
function TrendChart({
  title,
  weeklyData,
  rangeMin,
  rangeMax,
  regularSeasonWeeks,
  selectedTeam,
  onSelectTeam,
  yAxisLabel,
  defaultViewMode = "weekly",
  logos,
  chartId,
}) {
  const [viewMode, setViewMode] = useState(defaultViewMode); // "weekly" | "cumulative"

  const { teams, rows } = useMemo(() => {
    return viewMode === "cumulative"
      ? pivotCumulative(weeklyData, rangeMin, rangeMax)
      : pivotWeekly(weeklyData, rangeMin, rangeMax);
  }, [weeklyData, rangeMin, rangeMax, viewMode]);

  const weeksInRange = useMemo(() => {
    const ws = [];
    for (let w = rangeMin; w <= rangeMax; w++) ws.push(w);
    return ws;
  }, [rangeMin, rangeMax]);

  const visibleTeams = selectedTeam ? teams.filter((t) => t === selectedTeam) : teams;

  // Built from the full team list, not just currently-rendered lines, so
  // every team stays clickable in the legend even while narrowed to one.
  const legendPayload = teams.map((team, i) => ({
    value: team,
    type: "line",
    color: COLORS[i % COLORS.length],
  }));

  // Only draw the boundary once the slider's visible range actually spans
  // it -- both the last regular-season week and the first playoff week
  // (14 and 15, for this league) have to be in view, otherwise the line
  // would be drawn at an edge or outside the plotted data entirely.
  const showDivider =
    regularSeasonWeeks != null && rangeMin <= regularSeasonWeeks && rangeMax >= regularSeasonWeeks + 1;

  return (
    <div className="panel">
      <h2>
        {title}
        {selectedTeam ? " (filtered)" : ""}
      </h2>
      <div className="toggle-grid" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>View:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${viewMode === "weekly" ? " selected" : ""}`}
            onClick={() => setViewMode("weekly")}
          >
            Weekly
          </button>
          <button
            type="button"
            className={`week-chip${viewMode === "cumulative" ? " selected" : ""}`}
            onClick={() => setViewMode("cumulative")}
          >
            Cumulative
          </button>
        </div>
      </div>
      {rows.length > 0 ? (
        <ResponsiveContainer width="100%" height={420}>
          {/* Extra right margin makes room for each line's end-of-line team
              logo, which is drawn just past the last plotted point (see
              ChartTeamLogoDot) rather than on top of it. */}
          <LineChart data={rows} margin={{ bottom: 12, right: 28 }}>
            <CartesianGrid stroke="#2a2e37" />
            <XAxis
              dataKey="week"
              type="number"
              domain={[rangeMin, rangeMax]}
              ticks={weeksInRange}
              stroke="#9aa1ad"
              label={{ value: "Week", position: "insideBottom", offset: -5, fill: "#9aa1ad" }}
            />
            <YAxis
              stroke="#9aa1ad"
              label={
                yAxisLabel ? { value: yAxisLabel, angle: -90, position: "insideLeft", fill: "#9aa1ad" } : undefined
              }
            />
            <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
            {showDivider && (
              <ReferenceLine
                x={regularSeasonWeeks + 0.5}
                stroke="#9aa1ad"
                strokeDasharray="4 4"
                label={{ value: "Playoffs", position: "insideTopRight", fill: "#9aa1ad", fontSize: 11 }}
              />
            )}
            <Legend
              payload={legendPayload}
              onClick={(e) => onSelectTeam(e.value)}
              wrapperStyle={{ cursor: "pointer", paddingTop: 20 }}
            />
            {visibleTeams.map((team) => {
              const lastIdx = lastValidRowIndex(rows, team);
              const clipId = `logo-clip-${slugForId(chartId)}-${slugForId(team)}`;
              return (
                <Line
                  key={team}
                  type="monotone"
                  dataKey={team}
                  stroke={COLORS[teams.indexOf(team) % COLORS.length]}
                  dot={(dotProps) =>
                    dotProps.index === lastIdx ? (
                      <ChartTeamLogoDot
                        key={clipId}
                        cx={dotProps.cx}
                        cy={dotProps.cy}
                        src={logos?.[team]}
                        clipId={clipId}
                      />
                    ) : null
                  }
                  strokeWidth={2}
                  onClick={() => onSelectTeam(team)}
                  style={{ cursor: "pointer" }}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="empty-state">No data for the selected weeks.</div>
      )}
    </div>
  );
}

function StandingsInner() {
  const [league, setLeague] = useUrlState("league");
  const [season, setSeason] = useUrlState("season");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeSeason && activeLeague
      ? `/api/standings?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );

  // Team name -> profile picture URL, for the Leaderboard table and the
  // end-of-line marker on both trend charts. Fetched once per league/season
  // rather than joined server-side, since every route here already keys its
  // rows by team name (see api/team-logos/route.js).
  const { data: logoData } = useJson(
    activeSeason && activeLeague
      ? `/api/team-logos?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );
  const logos = logoData?.logos;

  // null = default sort (best win-loss record, points_for as tiebreaker).
  // Clicking a column header switches to sorting by that column alone.
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("desc");

  // Shared week-range slider -- sits between the Leaderboard table and the
  // trend charts, filtering all three. Defaults to the full available
  // range, same convention as the Players & Positions page's slider.
  const availableWeeks = useMemo(
    () => [...new Set((data?.weekly || []).map((r) => r.week))].sort((a, b) => a - b),
    [data]
  );
  const seasonMinWeek = availableWeeks[0] ?? 1;
  const seasonMaxWeek = availableWeeks[availableWeeks.length - 1] ?? 1;

  const [weekRange, setWeekRange] = useState(null); // [min, max] -- null until weeks are known

  // Reset to the full range whenever the available weeks change (e.g. on
  // season switch), so a leftover range from a prior season can't silently
  // filter out everything.
  useEffect(() => {
    if (availableWeeks.length > 0) {
      setWeekRange([seasonMinWeek, seasonMaxWeek]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonMinWeek, seasonMaxWeek]);

  const [rangeMin, rangeMax] = weekRange ?? [seasonMinWeek, seasonMaxWeek];
  const isFullRange = rangeMin === seasonMinWeek && rangeMax === seasonMaxWeek;

  function handleMinChange(value) {
    const num = Number(value);
    if (Number.isNaN(num)) return;
    const next = Math.max(seasonMinWeek, Math.min(num, rangeMax));
    setWeekRange([next, rangeMax]);
  }

  function handleMaxChange(value) {
    const num = Number(value);
    if (Number.isNaN(num)) return;
    const next = Math.min(seasonMaxWeek, Math.max(num, rangeMin));
    setWeekRange([rangeMin, next]);
  }

  const weeksLabel = rangeMin === rangeMax ? `Week ${rangeMin}` : `Weeks ${rangeMin}-${rangeMax}`;

  // The Leaderboard table stays capped to the regular season (weeks
  // 1-regularSeasonWeeks) regardless of how far the shared slider's upper
  // handle is dragged into the playoffs -- only the trend charts below
  // follow the slider's full range. Narrowing the slider's own upper bound
  // to regularSeasonWeeks or below (e.g. weeks 1-10) still updates the
  // table normally, since rangeMax is then already <= the cap and min()
  // is a no-op; dragging past it (e.g. weeks 1-17) just stops moving the
  // table's upper bound any further, rather than pulling playoff games
  // into the win-loss record. An empty result (e.g. the slider narrowed
  // entirely into playoff weeks, rangeMin > regularSeasonWeeks) falls
  // through to the existing "No matchups played yet" empty state.
  const regularSeasonWeeks = data?.regularSeasonWeeks ?? null;
  const leaderboardMax = regularSeasonWeeks != null ? Math.min(rangeMax, regularSeasonWeeks) : rangeMax;
  const leaderboardMin = Math.min(rangeMin, leaderboardMax);
  const leaderboardHasWeeks = rangeMin <= leaderboardMax;
  const leaderboardIsFullRange =
    rangeMin === seasonMinWeek && leaderboardMax === (regularSeasonWeeks ?? seasonMaxWeek);
  const leaderboardWeeksLabel =
    leaderboardMin === leaderboardMax ? `Week ${leaderboardMin}` : `Weeks ${leaderboardMin}-${leaderboardMax}`;

  const standings = useMemo(
    () =>
      data?.weeklyRecords && leaderboardHasWeeks
        ? computeStandings(data.weeklyRecords, rangeMin, leaderboardMax)
        : [],
    [data, rangeMin, leaderboardMax, leaderboardHasWeeks]
  );

  const sortedStandings = useMemo(() => {
    const rows = [...standings];
    if (sortKey === null) {
      rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for - a.points_for);
      return rows;
    }
    rows.sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      return a[sortKey] > b[sortKey] ? dir : a[sortKey] < b[sortKey] ? -dir : 0;
    });
    return rows;
  }, [standings, sortKey, sortDir]);

  // Selecting a team (via the standings table or either trend chart's
  // legend/line) narrows both trend charts to just that team. Selecting
  // the same one again clears it back to showing everyone.
  const [selectedTeam, setSelectedTeam] = useState(null);
  function selectTeam(team) {
    setSelectedTeam((prev) => (prev === team ? null : team));
  }

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <>
      <div className="controls">
        <LeagueSelect
          leagues={meta?.leagues}
          league={activeLeague}
          onChange={(next) => setLeague(next, { clear: ["season"] })}
        />
        <SeasonSelect seasons={seasons} season={activeSeason} onChange={setSeason} />
        {selectedTeam && (
          <span style={{ fontSize: 14, color: "var(--text-dim)" }}>
            Showing trend for <strong style={{ color: "var(--text)" }}>{selectedTeam}</strong> --{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); setSelectedTeam(null); }}>
              show all
            </a>
          </span>
        )}
      </div>

      {loading && <div className="loading-state">Loading standings...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && (
        <>
          <div className="panel">
            <h2>
              Season Leaderboard
              {!leaderboardIsFullRange ? ` (${leaderboardWeeksLabel})` : ""}
            </h2>
            <div className="table-scroll">
              <table className="standings-table">
                <thead>
                  <tr>
                    <th className="sticky-col" onClick={() => toggleSort("team")}>Team</th>
                    <th onClick={() => toggleSort("wins")}>W</th>
                    <th onClick={() => toggleSort("losses")}>L</th>
                    <th onClick={() => toggleSort("ties")}>T</th>
                    <th onClick={() => toggleSort("points_for")}>Points For</th>
                    <th onClick={() => toggleSort("points_against")}>Points Against</th>
                    <th onClick={() => toggleSort("avg_points")}>Avg / Week</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStandings.map((row) => (
                    <tr
                      key={row.team}
                      onClick={() => selectTeam(row.team)}
                      style={{
                        cursor: "pointer",
                        background: selectedTeam === row.team ? "rgba(91,157,255,0.12)" : undefined,
                      }}
                    >
                      <td
                        className="sticky-col"
                        style={{ background: selectedTeam === row.team ? "#1f2a3c" : undefined }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <TeamLogo src={logos?.[row.team]} />
                          {row.team}
                        </span>
                      </td>
                      <td>{row.wins}</td>
                      <td>{row.losses}</td>
                      <td>{row.ties}</td>
                      <td>{row.points_for}</td>
                      <td>{row.points_against}</td>
                      <td>{row.avg_points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sortedStandings.length === 0 && <div className="empty-state">No matchups played yet.</div>}
          </div>

          {/* Shared by the Leaderboard table above and both trend charts
              below -- same slider component/behavior as Players &
              Positions. */}
          <div className="controls" style={{ marginTop: -12, alignItems: "center" }}>
            <span style={{ fontSize: 14, color: "var(--text-dim)" }}>{weeksLabel}</span>
            <input
              type="number"
              className="week-number-input"
              min={seasonMinWeek}
              max={seasonMaxWeek}
              value={rangeMin}
              onChange={(e) => handleMinChange(e.target.value)}
              aria-label="Minimum week (type a number)"
            />
            <span style={{ color: "var(--text-dim)" }}>to</span>
            <input
              type="number"
              className="week-number-input"
              min={seasonMinWeek}
              max={seasonMaxWeek}
              value={rangeMax}
              onChange={(e) => handleMaxChange(e.target.value)}
              aria-label="Maximum week (type a number)"
            />
            <div className="range-slider">
              <div
                className="range-slider-track-fill"
                style={{
                  left: `${SLIDER_THUMB_RADIUS + ((rangeMin - seasonMinWeek) / (seasonMaxWeek - seasonMinWeek || 1)) * SLIDER_TRACK_WIDTH}px`,
                  right: `${SLIDER_THUMB_RADIUS + (1 - (rangeMax - seasonMinWeek) / (seasonMaxWeek - seasonMinWeek || 1)) * SLIDER_TRACK_WIDTH}px`,
                }}
              />
              <input
                type="range"
                min={seasonMinWeek}
                max={seasonMaxWeek}
                value={rangeMin}
                onChange={(e) => handleMinChange(e.target.value)}
                aria-label="Minimum week"
              />
              <input
                type="range"
                min={seasonMinWeek}
                max={seasonMaxWeek}
                value={rangeMax}
                onChange={(e) => handleMaxChange(e.target.value)}
                aria-label="Maximum week"
              />
            </div>
            {!isFullRange && (
              <button
                type="button"
                className="week-chip"
                onClick={() => setWeekRange([seasonMinWeek, seasonMaxWeek])}
              >
                Reset
              </button>
            )}
          </div>

          <TrendChart
            title="Weekly Points Trend"
            weeklyData={data.weekly || []}
            rangeMin={rangeMin}
            rangeMax={rangeMax}
            regularSeasonWeeks={data.regularSeasonWeeks}
            selectedTeam={selectedTeam}
            onSelectTeam={selectTeam}
            yAxisLabel="Fantasy Points"
            logos={logos}
            chartId="weekly"
          />

          <TrendChart
            title="Grand Prix Points Trend"
            weeklyData={data.gpWeekly || []}
            rangeMin={rangeMin}
            rangeMax={rangeMax}
            regularSeasonWeeks={data.regularSeasonWeeks}
            selectedTeam={selectedTeam}
            onSelectTeam={selectTeam}
            yAxisLabel="Grand Prix Points"
            defaultViewMode="cumulative"
            logos={logos}
            chartId="grandprix"
          />
        </>
      )}
    </>
  );
}

export default function StandingsPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <StandingsInner />
    </Suspense>
  );
}
