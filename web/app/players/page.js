"use client";

import { Suspense, useMemo, useState } from "react";
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
  const byManager = new Map(managers.map((m) => [m, { manager: m }]));
  for (const row of rows) {
    const entry = byManager.get(row.manager);
    entry[row.position] = Number(((entry[row.position] || 0) + (row.points || 0)).toFixed(1));
  }
  return { chartRows: [...byManager.values()], positions };
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
  const [sortKey, setSortKey] = useState("total");
  const [sortDir, setSortDir] = useState("desc");

  const managers = useMemo(() => ["All", ...new Set(rows.map((r) => r.manager))].sort(), [rows]);
  const positions = useMemo(() => ["All", ...new Set(rows.map((r) => r.position))].sort(), [rows]);

  const { chartRows, positions: chartPositions } = useMemo(() => aggregateByManagerPosition(rows), [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (managerFilter !== "All" && r.manager !== managerFilter) return false;
      if (positionFilter !== "All" && r.position !== positionFilter) return false;
      if (playerSearch && !r.player.toLowerCase().includes(playerSearch.toLowerCase())) return false;
      return true;
    });
  }, [rows, managerFilter, positionFilter, playerSearch]);

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

  return (
    <>
      <div className="controls">
        <SeasonSelect seasons={seasons} season={activeSeason} />
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

      {loading && <div className="loading-state">Loading player data...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && (
        <>
          <div className="panel">
            <h2>Points by Position, per Manager</h2>
            {chartRows.length > 0 ? (
              <ResponsiveContainer width="100%" height={420}>
                <BarChart data={chartRows}>
                  <CartesianGrid stroke="#2a2e37" />
                  <XAxis dataKey="manager" stroke="#9aa1ad" angle={-20} textAnchor="end" height={70} />
                  <YAxis stroke="#9aa1ad" />
                  <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
                  <Legend />
                  {chartPositions.map((pos) => (
                    <Bar key={pos} dataKey={pos} stackId="pos" fill={POSITION_COLORS[pos] || FALLBACK_COLOR} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state">No player data yet.</div>
            )}
          </div>

          <div className="panel">
            <h2>Player Totals {managerFilter !== "All" || positionFilter !== "All" || playerSearch ? "(filtered)" : ""}</h2>
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
