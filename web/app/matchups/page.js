"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import SeasonSelect from "../components/SeasonSelect";
import { useJson } from "../../lib/useJson";

function resultBadge(row, perspective) {
  if (row.is_bye) return <span className="badge bye">BYE</span>;
  if (row.winner === "TIE") return <span className="badge tie">TIE</span>;
  const homeWon = row.winner === "HOME";
  if (perspective === "home") {
    return homeWon ? <span className="badge win">W</span> : <span className="badge loss">L</span>;
  }
  if (perspective === "away") {
    return homeWon ? <span className="badge loss">L</span> : <span className="badge win">W</span>;
  }
  return null;
}

function groupByWeek(rows) {
  const byWeek = new Map();
  for (const row of rows) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, []);
    byWeek.get(row.week).push(row);
  }
  return [...byWeek.entries()].sort((a, b) => a[0] - b[0]);
}

function headToHead(rows) {
  const pairs = new Map(); // key: sorted "A|B" -> { a, b, aWins, bWins, ties }
  for (const row of rows) {
    if (row.is_bye || !row.away_manager) continue;
    const [a, b] = [row.home_manager, row.away_manager].sort();
    const key = `${a}|${b}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, aWins: 0, bWins: 0, ties: 0 });
    const entry = pairs.get(key);
    if (row.winner === "TIE") {
      entry.ties += 1;
    } else {
      const winnerManager = row.winner === "HOME" ? row.home_manager : row.away_manager;
      if (winnerManager === a) entry.aWins += 1;
      else entry.bWins += 1;
    }
  }
  return [...pairs.values()].sort((x, y) => (x.a + x.b).localeCompare(y.a + y.b));
}

function MatchupsInner() {
  const searchParams = useSearchParams();
  const season = searchParams.get("season");

  const { data: meta } = useJson("/api/meta");
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];

  const { data, loading, error } = useJson(activeSeason ? `/api/matchups?season=${activeSeason}` : null);
  const rows = data?.rows || [];

  const [managerFilter, setManagerFilter] = useState("All");

  const managers = useMemo(() => {
    const set = new Set();
    rows.forEach((r) => {
      set.add(r.home_manager);
      if (r.away_manager) set.add(r.away_manager);
    });
    return ["All", ...set].sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (managerFilter === "All") return rows;
    return rows.filter((r) => r.home_manager === managerFilter || r.away_manager === managerFilter);
  }, [rows, managerFilter]);

  const h2h = useMemo(() => headToHead(rows), [rows]);
  const weeks = useMemo(() => groupByWeek(filteredRows), [filteredRows]);

  return (
    <>
      <div className="controls">
        <SeasonSelect seasons={seasons} season={activeSeason} />
        <select value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)}>
          {managers.map((m) => (
            <option key={m} value={m}>{m === "All" ? "All Managers" : m}</option>
          ))}
        </select>
      </div>

      {loading && <div className="loading-state">Loading schedule...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && (
        <>
          <div className="panel">
            <h2>Schedule &amp; Results</h2>
            {weeks.map(([week, weekRows]) => (
              <div key={week} style={{ marginBottom: 24 }}>
                <h3 style={{ fontSize: 14, color: "var(--text-dim)", margin: "0 0 8px" }}>Week {week}</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Home</th>
                      <th>Score</th>
                      <th>Away</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekRows.map((row, i) => (
                      <tr key={i}>
                        <td>{row.home_manager}</td>
                        <td>
                          {row.home_points?.toFixed?.(1) ?? row.home_points}
                          {!row.is_bye && row.away_points != null && ` - ${row.away_points.toFixed?.(1) ?? row.away_points}`}
                        </td>
                        <td>{row.is_bye ? "—" : row.away_manager}</td>
                        <td>
                          {row.is_bye
                            ? resultBadge(row)
                            : managerFilter !== "All"
                            ? resultBadge(row, row.home_manager === managerFilter ? "home" : "away")
                            : row.winner === "TIE"
                            ? <span className="badge tie">TIE</span>
                            : `${row.winner === "HOME" ? row.home_manager : row.away_manager} won`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {weeks.length === 0 && <div className="empty-state">No games yet.</div>}
          </div>

          <div className="panel">
            <h2>Head-to-Head Records</h2>
            <table>
              <thead>
                <tr>
                  <th>Manager</th>
                  <th>Manager</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {h2h.map((row) => (
                  <tr key={`${row.a}-${row.b}`}>
                    <td>{row.a}</td>
                    <td>{row.b}</td>
                    <td>
                      {row.aWins}-{row.bWins}
                      {row.ties > 0 ? `-${row.ties}` : ""}
                      {row.aWins !== row.bWins && (
                        <span style={{ color: "var(--text-dim)", marginLeft: 8 }}>
                          ({row.aWins > row.bWins ? row.a : row.b} leads)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {h2h.length === 0 && <div className="empty-state">No head-to-head games yet.</div>}
          </div>
        </>
      )}
    </>
  );
}

export default function MatchupsPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <MatchupsInner />
    </Suspense>
  );
}
