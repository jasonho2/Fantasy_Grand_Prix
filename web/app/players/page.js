"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { useJson } from "../../lib/useJson";

const POSITION_COLORS = {
  QB: "#5b9dff",
  RB: "#3ecf8e",
  WR: "#d9b64e",
  TE: "#c77dff",
  K: "#4dd4d4",
  "D/ST": "#ff6b6b",
};
const FALLBACK_COLOR = "#9aa1ad";

// Track width the slider line/fill are drawn at, plus the thumb radius
// reserved as padding on each side so a thumb centered at either extreme
// stays fully inside the slider's bounding box instead of poking past it.
const SLIDER_TRACK_WIDTH = 240;
const SLIDER_THUMB_RADIUS = 7;

function aggregateByManagerPosition(rows) {
  const managers = [...new Set(rows.map((r) => r.manager))].sort();
  const positions = [...new Set(rows.map((r) => r.position))].sort();
  const byManager = new Map(managers.map((m) => [m, { manager: m, total: 0 }]));
  for (const row of rows) {
    const entry = byManager.get(row.manager);
    entry[row.position] = Number(((entry[row.position] || 0) + (row.points || 0)).toFixed(1));
    entry.total = Number((entry.total + (row.points || 0)).toFixed(1));
  }
  // Points For descending, not alphabetical.
  const chartRows = [...byManager.values()].sort((a, b) => b.total - a.total);
  return { chartRows, positions };
}

// Renders the manager's season total just past the end (right side) of
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

// Managers who share a team (e.g. co-managed rosters) get names like
// "PersonA / PersonB". A "/" is the wrap signal: split there and stack
// the pieces on their own lines so the label stays compact instead of
// forcing extra Y-axis width for the combined length. Names without a
// "/" render on a single line, unrotated.
function ManagerTick({ x, y, payload }) {
  const raw = payload.value;
  const lines = raw.includes("/") ? raw.split("/").map((s) => s.trim()) : [raw];
  const lineHeight = 15;
  const firstDy = -((lines.length - 1) * lineHeight) / 2;
  return (
    <text x={x} y={y} textAnchor="end" fill="#9aa1ad" fontSize={13} dominantBaseline="central">
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
  const CHAR_PX = 7.5; // rough average glyph width at the 13px tick font
  const PADDING = 24; // tick-to-axis-line gap + a little breathing room
  const MIN_WIDTH = 70;
  const MAX_WIDTH = 220;
  let maxChars = 0;
  for (const row of chartRows) {
    const lines = row.manager.includes("/") ? row.manager.split("/").map((s) => s.trim()) : [row.manager];
    for (const line of lines) {
      if (line.length > maxChars) maxChars = line.length;
    }
  }
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, maxChars * CHAR_PX + PADDING));
}

function aggregateByPlayer(rows) {
  const byPlayer = new Map();
  for (const row of rows) {
    const key = `${row.player}|${row.position}|${row.manager}`;
    if (!byPlayer.has(key)) {
      byPlayer.set(key, {
        player: row.player,
        position: row.position,
        manager: row.manager,
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
  const searchParams = useSearchParams();
  const season = searchParams.get("season");

  const { data: meta } = useJson("/api/meta");
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];

  const { data, loading, error } = useJson(activeSeason ? `/api/players?season=${activeSeason}` : null);
  const rows = data?.rows || [];

  const [managerFilter, setManagerFilter] = useState("All");
  const [positionFilter, setPositionFilter] = useState("All");
  const [playerSearch, setPlayerSearch] = useState("");
  const [weekRange, setWeekRange] = useState(null); // [min, max] -- null until weeks are known
  const [sortKey, setSortKey] = useState("total");
  const [sortDir, setSortDir] = useState("desc");

  const managers = useMemo(() => ["All", ...new Set(rows.map((r) => r.manager))].sort(), [rows]);
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

  // Week range scopes both the chart and the table below it; manager/
  // position/search filters also apply to both.
  const weekScopedRows = useMemo(() => {
    if (!weekRange) return rows;
    return rows.filter((r) => r.week >= rangeMin && r.week <= rangeMax);
  }, [rows, weekRange, rangeMin, rangeMax]);

  const filteredRows = useMemo(() => {
    return weekScopedRows.filter((r) => {
      if (managerFilter !== "All" && r.manager !== managerFilter) return false;
      if (positionFilter !== "All" && r.position !== positionFilter) return false;
      if (playerSearch && !r.player.toLowerCase().includes(playerSearch.toLowerCase())) return false;
      return true;
    });
  }, [weekScopedRows, managerFilter, positionFilter, playerSearch]);

  const { chartRows, positions: chartPositions } = useMemo(
    () => aggregateByManagerPosition(filteredRows),
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
        <SeasonSelect seasons={seasons} season={activeSeason} />
      </div>

      {loading && <div className="loading-state">Loading player data...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && (
        <>
          <div className="panel">
            <h2>
              Points by Position, per Manager (sorted by Points For)
              {managerFilter !== "All" || positionFilter !== "All" || playerSearch ? " (filtered)" : ""}
            </h2>
            {chartRows.length > 0 ? (
              // layout="vertical" makes Recharts draw horizontal bars: the
              // category (manager) moves to the YAxis and the value axis
              // becomes the XAxis, so manager names render fully horizontal
              // instead of rotated. The YAxis width is computed from the
              // actual (post-wrap) label lengths so the left-side padding
              // stays as small as the longest visible line requires.
              <ResponsiveContainer width="100%" height={Math.max(320, chartRows.length * 42 + 80)}>
                <BarChart
                  data={chartRows}
                  layout="vertical"
                  margin={{ top: 24, right: 60, left: 4, bottom: 10 }}
                >
                  <CartesianGrid stroke="#2a2e37" horizontal={false} />
                  <XAxis type="number" stroke="#9aa1ad" />
                  <YAxis
                    dataKey="manager"
                    type="category"
                    stroke="#9aa1ad"
                    width={yAxisWidth}
                    tick={(props) => <ManagerTick {...props} />}
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
            <select value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)}>
              {managers.map((m) => (
                <option key={m} value={m}>{m === "All" ? "All Managers" : m}</option>
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
            <h2>Player Totals {managerFilter !== "All" || positionFilter !== "All" || playerSearch || !isFullRange ? "(filtered)" : ""}</h2>
            <table>
              <thead>
                <tr>
                  <th onClick={() => toggleSort("player")}>Player</th>
                  <th onClick={() => toggleSort("position")}>Position</th>
                  <th onClick={() => toggleSort("manager")}>Manager</th>
                  <th onClick={() => toggleSort("total")}>Total Points</th>
                  <th onClick={() => toggleSort("weeks")}>Weeks Started</th>
                  <th onClick={() => toggleSort("avg")}>Avg / Week</th>
                </tr>
              </thead>
              <tbody>
                {playerTotals.map((row) => (
                  <tr key={`${row.player}-${row.position}-${row.manager}`}>
                    <td>{row.player}</td>
                    <td>{row.position}</td>
                    <td>{row.manager}</td>
                    <td>{row.total}</td>
                    <td>{row.weeks}</td>
                    <td>{row.avg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
