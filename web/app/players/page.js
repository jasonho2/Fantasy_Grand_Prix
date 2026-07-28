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

// Renders the manager's season total above the top segment of their
// stacked bar (rather than that segment's own value).
function TotalLabel(props) {
  const { x, y, width, value, index, data } = props;
  if (value == null || !data?.[index]) return null;
  const total = data[index].total;
  return (
    <text x={x + width / 2} y={y - 8} textAnchor="middle" fill="var(--text)" fontSize={12} fontWeight={600}>
      {total}
    </text>
  );
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
    const next = Math.min(Number(value), rangeMax);
    setWeekRange([next, rangeMax]);
  }

  function handleMaxChange(value) {
    const next = Math.max(Number(value), rangeMin);
    setWeekRange([rangeMin, next]);
  }

  // Week range scopes both the chart and the table below it; manager/
  // position/search only narrow the table (the chart stays a full
  // manager-vs-manager comparison for whatever weeks are in scope).
  const weekScopedRows = useMemo(() => {
    if (!weekRange) return rows;
    return rows.filter((r) => r.week >= rangeMin && r.week <= rangeMax);
  }, [rows, weekRange, rangeMin, rangeMax]);

  const { chartRows, positions: chartPositions } = useMemo(
    () => aggregateByManagerPosition(weekScopedRows),
    [weekScopedRows]
  );

  const filteredRows = useMemo(() => {
    return weekScopedRows.filter((r) => {
      if (managerFilter !== "All" && r.manager !== managerFilter) return false;
      if (positionFilter !== "All" && r.position !== positionFilter) return false;
      if (playerSearch && !r.player.toLowerCase().includes(playerSearch.toLowerCase())) return false;
      return true;
    });
  }, [weekScopedRows, managerFilter, positionFilter, playerSearch]);

  const playerTotals = useMemo(() => {
    const agg = aggregateByPlayer(filteredRows);
    agg.sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      return a[sortKey] > b[sortKey] ? dir * -1 : a[sortKey] < b[sortKey] ? dir : 0;
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
            <h2>Points by Position, per Manager (sorted by Points For)</h2>
            {chartRows.length > 0 ? (
              <ResponsiveContainer width="100%" height={440}>
                <BarChart data={chartRows} margin={{ top: 24, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#2a2e37" />
                  <XAxis dataKey="manager" stroke="#9aa1ad" angle={-20} textAnchor="end" height={70} />
                  <YAxis stroke="#9aa1ad" />
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
            <span style={{ fontSize: 14, color: "var(--text-dim)", minWidth: 110 }}>{weeksLabel}</span>
            <div className="range-slider">
              <div
                className="range-slider-track-fill"
                style={{
                  left: `${((rangeMin - seasonMinWeek) / (seasonMaxWeek - seasonMinWeek || 1)) * 100}%`,
                  right: `${100 - ((rangeMax - seasonMinWeek) / (seasonMaxWeek - seasonMinWeek || 1)) * 100}%`,
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
