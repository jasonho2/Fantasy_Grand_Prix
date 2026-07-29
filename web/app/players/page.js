"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import SeasonSelect from "../components/SeasonSelect";
import LeagueSelect from "../components/LeagueSelect";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

const POSITION_COLORS = {
  QB: "#5b9dff",
  RB: "#3ecf8e",
  WR: "#d9b64e",
  TE: "#c77dff",
  K: "#4dd4d4",
  "D/ST": "#ff6b6b",
};
const FALLBACK_COLOR = "#9aa1ad";

// Chart/legend stacking order (offense skill positions, then D/ST, then
// K) rather than alphabetical. Any position not in this list (shouldn't
// happen, but just in case) sorts after the known ones, alphabetically.
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "D/ST", "K"];
function sortPositions(positions) {
  return [...positions].sort((a, b) => {
    const ai = POSITION_ORDER.indexOf(a);
    const bi = POSITION_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

// Track width the slider line/fill are drawn at, plus the thumb radius
// reserved as padding on each side so a thumb centered at either extreme
// stays fully inside the slider's bounding box instead of poking past it.
const SLIDER_TRACK_WIDTH = 240;
const SLIDER_THUMB_RADIUS = 7;

function aggregateByTeamPosition(rows) {
  const teams = [...new Set(rows.map((r) => r.team))].sort();
  const positions = sortPositions([...new Set(rows.map((r) => r.position))]);
  const byTeam = new Map(teams.map((t) => [t, { team: t, total: 0 }]));
  for (const row of rows) {
    const entry = byTeam.get(row.team);
    entry[row.position] = Number(((entry[row.position] || 0) + (row.points || 0)).toFixed(1));
    entry.total = Number((entry.total + (row.points || 0)).toFixed(1));
  }
  // Points For descending, not alphabetical.
  const chartRows = [...byTeam.values()].sort((a, b) => b.total - a.total);
  return { chartRows, positions };
}

// Renders the team's season total just past the end (right side) of
// their stacked horizontal bar, vertically centered on the bar, rather
// than that segment's own value.
function TotalLabel(props) {
  const { x, y, width, height, value, index, data } = props;
  if (value == null || !data?.[index]) return null;
  const total = data[index].total;
  return (
    <text
      x={x + width + 8}
      y={y + height / 2}
      dy={4}
      textAnchor="start"
      fill="var(--text)"
      fontSize={12}
      fontWeight={600}
    >
      {total}
    </text>
  );
}

const Y_AXIS_MAX_FIRST_LINE = 20;

// Word-wraps a team name to at most 2 lines: line 1 fills up with whole
// words up to `maxFirstLine` characters (never splitting a word, so a
// single overlong word can still exceed it -- there's no way to break it
// without hyphenating), and everything left over becomes line 2 as-is.
function wrapTeamName(name, maxFirstLine = Y_AXIS_MAX_FIRST_LINE) {
  const words = name.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (lines.length === 0 && current && candidate.length > maxFirstLine) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function TeamTick({ x, y, payload }) {
  const lines = wrapTeamName(payload.value);
  const lineHeight = 13;
  const firstDy = -((lines.length - 1) * lineHeight) / 2;
  return (
    <text x={x} y={y} textAnchor="end" fill="#9aa1ad" fontSize={11} dominantBaseline="central">
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={i === 0 ? firstDy : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

// Reserve just enough Y-axis width for the longest line that will
// actually be rendered (post-wrap), instead of a fixed value sized for
// the single longest full name.
function estimateYAxisWidth(chartRows) {
  const CHAR_PX = 6.3; // rough average glyph width at the 11px tick font
  const PADDING = 6; // tick-to-axis-line gap + a little breathing room
  const MIN_WIDTH = 46;
  const MAX_WIDTH = 140;
  let maxChars = 0;
  for (const row of chartRows) {
    for (const line of wrapTeamName(row.team)) {
      if (line.length > maxChars) maxChars = line.length;
    }
  }
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, maxChars * CHAR_PX + PADDING));
}

function aggregateByPlayer(rows) {
  const byPlayer = new Map();
  for (const row of rows) {
    const key = `${row.player}|${row.position}|${row.team}`;
    if (!byPlayer.has(key)) {
      byPlayer.set(key, {
        player: row.player,
        position: row.position,
        team: row.team,
        total: 0,
        weeks: 0,
      });
    }
    const entry = byPlayer.get(key);
    entry.total += row.points || 0;
    entry.weeks += 1;
  }
  return [...byPlayer.values()].map((r) => ({
    ...r,
    total: Number(r.total.toFixed(1)),
    avg: Number((r.total / r.weeks).toFixed(1)),
  }));
}

function PlayersInner() {
  const [league, setLeague] = useUrlState("league");
  const [season, setSeason] = useUrlState("season");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeSeason && activeLeague
      ? `/api/players?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );
  const rows = data?.rows || [];

  const [teamFilter, setTeamFilter] = useState("All");
  const [positionFilter, setPositionFilter] = useState("All");
  const [playerSearch, setPlayerSearch] = useState("");
  const [weekRange, setWeekRange] = useState(null); // [min, max] -- null until weeks are known
  const [sortKey, setSortKey] = useState("total");
  const [sortDir, setSortDir] = useState("desc");

  const teams = useMemo(() => ["All", ...new Set(rows.map((r) => r.team))].sort(), [rows]);
  const positions = useMemo(() => ["All", ...new Set(rows.map((r) => r.position))].sort(), [rows]);
  const availableWeeks = useMemo(
    () => [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b),
    [rows]
  );
  const seasonMinWeek = availableWeeks[0] ?? 1;
  const seasonMaxWeek = availableWeeks[availableWeeks.length - 1] ?? 1;

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

  // Week range scopes both the chart and the table below it; team/
  // position/search filters also apply to both.
  const weekScopedRows = useMemo(() => {
    if (!weekRange) return rows;
    return rows.filter((r) => r.week >= rangeMin && r.week <= rangeMax);
  }, [rows, weekRange, rangeMin, rangeMax]);

  const filteredRows = useMemo(() => {
    return weekScopedRows.filter((r) => {
      if (teamFilter !== "All" && r.team !== teamFilter) return false;
      if (positionFilter !== "All" && r.position !== positionFilter) return false;
      if (playerSearch && !r.player.toLowerCase().includes(playerSearch.toLowerCase())) return false;
      return true;
    });
  }, [weekScopedRows, teamFilter, positionFilter, playerSearch]);

  const { chartRows, positions: chartPositions } = useMemo(
    () => aggregateByTeamPosition(filteredRows),
    [filteredRows]
  );

  const yAxisWidth = useMemo(() => estimateYAxisWidth(chartRows), [chartRows]);

  const playerTotals = useMemo(() => {
    const agg = aggregateByPlayer(filteredRows);
    agg.sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      return a[sortKey] > b[sortKey] ? dir : a[sortKey] < b[sortKey] ? -dir : 0;
    });
    return agg;
  }, [filteredRows, sortKey, sortDir]);

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const weeksLabel = rangeMin === rangeMax ? `Week ${rangeMin}` : `Weeks ${rangeMin}-${rangeMax}`;

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

      {loading && <div className="loading-state">Loading player data...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && (
        <>
          <div className="panel">
            <h2>
              Points by Position, per Team (sorted by Points For)
              {teamFilter !== "All" || positionFilter !== "All" || playerSearch ? " (filtered)" : ""}
            </h2>
            {chartRows.length > 0 ? (
              // layout="vertical" makes Recharts draw horizontal bars: the
              // category (team) moves to the YAxis and the value axis
              // becomes the XAxis, so team names render fully horizontal
              // instead of rotated. The YAxis width is computed from the
              // actual (post-wrap) label lengths so the left-side padding
              // stays as small as the longest visible line requires.
              <ResponsiveContainer width="100%" height={Math.max(320, chartRows.length * 42 + 80)}>
                <BarChart
                  data={chartRows}
                  layout="vertical"
                  margin={{ top: 24, right: 50, left: 0, bottom: 10 }}
                >
                  <CartesianGrid stroke="#2a2e37" horizontal={false} />
                  <XAxis type="number" stroke="#9aa1ad" />
                  <YAxis
                    dataKey="team"
                    type="category"
                    stroke="#9aa1ad"
                    width={yAxisWidth}
                    tickMargin={2}
                    tickLine={false}
                    tick={(props) => <TeamTick {...props} />}
                  />
                  <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
                  <Legend />
                  {chartPositions.map((pos, i) => (
                    <Bar key={pos} dataKey={pos} stackId="pos" fill={POSITION_COLORS[pos] || FALLBACK_COLOR}>
                      {i === chartPositions.length - 1 && (
                        <LabelList dataKey={pos} content={(props) => <TotalLabel {...props} data={chartRows} />} />
                      )}
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state">No player data yet.</div>
            )}
          </div>

          <div className="controls">
            <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              {teams.map((t) => (
                <option key={t} value={t}>{t === "All" ? "All Teams" : t}</option>
              ))}
            </select>
            <select value={positionFilter} onChange={(e) => setPositionFilter(e.target.value)}>
              {positions.map((p) => (
                <option key={p} value={p}>{p === "All" ? "All Positions" : p}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search player..."
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
            />
          </div>
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

          <div className="panel">
            <h2>Player Totals {teamFilter !== "All" || positionFilter !== "All" || playerSearch || !isFullRange ? "(filtered)" : ""}</h2>
            <div className="table-scroll">
              <table className="players-table">
                <thead>
                  <tr>
                    <th className="sticky-col" onClick={() => toggleSort("player")}>Player</th>
                    <th onClick={() => toggleSort("position")}>Slot</th>
                    <th onClick={() => toggleSort("team")}>Team</th>
                    <th title="Total Points" onClick={() => toggleSort("total")}>PF</th>
                    <th title="Weeks Started" onClick={() => toggleSort("weeks")}>Wks Started</th>
                    <th title="Avg / Week" onClick={() => toggleSort("avg")}>Avg / Wk</th>
                  </tr>
                </thead>
                <tbody>
                  {playerTotals.map((row) => (
                    <tr key={`${row.player}-${row.position}-${row.team}`}>
                      <td className="sticky-col wrap-cell">{row.player}</td>
                      <td>{row.position}</td>
                      <td>{row.team}</td>
                      <td>{row.total}</td>
                      <td>{row.weeks}</td>
                      <td>{row.avg}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {playerTotals.length === 0 && <div className="empty-state">No players match these filters.</div>}
          </div>
        </>
      )}
    </>
  );
}

export default function PlayersPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <PlayersInner />
    </Suspense>
  );
}
