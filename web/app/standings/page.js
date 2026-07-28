"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { useJson } from "../../lib/useJson";

const COLORS = [
  "#5b9dff", "#3ecf8e", "#ff6b6b", "#d9b64e", "#c77dff",
  "#4dd4d4", "#ff9f5b", "#9fd35c", "#f06292", "#7986cb",
  "#a1887f", "#90a4ae",
];

function pivotWeekly(weekly) {
  const managers = [...new Set(weekly.map((r) => r.manager))].sort();
  const byWeek = new Map();
  for (const row of weekly) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, { week: row.week });
    byWeek.get(row.week)[row.manager] = row.points;
  }
  const rows = [...byWeek.values()].sort((a, b) => a.week - b.week);
  return { managers, rows };
}

function StandingsInner() {
  const searchParams = useSearchParams();
  const season = searchParams.get("season");

  const { data: meta } = useJson("/api/meta");
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];

  const { data, loading, error } = useJson(activeSeason ? `/api/standings?season=${activeSeason}` : null);

  // null = default sort (best win-loss record, points_for as tiebreaker).
  // Clicking a column header switches to sorting by that column alone.
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("desc");

  const sortedStandings = useMemo(() => {
    if (!data?.standings) return [];
    const rows = [...data.standings];
    if (sortKey === null) {
      rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for - a.points_for);
      return rows;
    }
    rows.sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      return a[sortKey] > b[sortKey] ? dir * -1 : a[sortKey] < b[sortKey] ? dir : 0;
    });
    return rows;
  }, [data, sortKey, sortDir]);

  const { managers, rows: trendRows } = useMemo(
    () => (data?.weekly ? pivotWeekly(data.weekly) : { managers: [], rows: [] }),
    [data]
  );

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
      </div>

      {loading && <div className="loading-state">Loading standings...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && (
        <>
          <div className="panel">
            <h2>Season Leaderboard</h2>
            <table>
              <thead>
                <tr>
                  <th onClick={() => toggleSort("manager")}>Manager</th>
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
                  <tr key={row.manager}>
                    <td>{row.manager}</td>
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
            {sortedStandings.length === 0 && <div className="empty-state">No matchups played yet.</div>}
          </div>

          <div className="panel">
            <h2>Weekly Points Trend</h2>
            {trendRows.length > 0 ? (
              <ResponsiveContainer width="100%" height={400}>
                <LineChart data={trendRows}>
                  <CartesianGrid stroke="#2a2e37" />
                  <XAxis dataKey="week" stroke="#9aa1ad" label={{ value: "Week", position: "insideBottom", offset: -5, fill: "#9aa1ad" }} />
                  <YAxis stroke="#9aa1ad" />
                  <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
                  <Legend />
                  {managers.map((mgr, i) => (
                    <Line
                      key={mgr}
                      type="monotone"
                      dataKey={mgr}
                      stroke={COLORS[i % COLORS.length]}
                      dot={false}
                      strokeWidth={2}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state">No weekly data yet.</div>
            )}
          </div>
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
