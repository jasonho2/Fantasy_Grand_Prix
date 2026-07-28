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

// Cumulative W-L(-T) record for every manager as of the end of each week,
// computed from the FULL season's matchups regardless of any manager
// filter applied to the display -- a record has to account for every game
// played, not just the ones currently shown.
function computeRunningRecords(rows) {
  const managers = new Set();
  rows.forEach((r) => {
    managers.add(r.home_manager);
    if (r.away_manager) managers.add(r.away_manager);
  });
  const running = new Map([...managers].map((m) => [m, { wins: 0, losses: 0, ties: 0 }]));

  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  const snapshot = new Map(); // `${manager}|${week}` -> { wins, losses, ties }

  for (const week of weeks) {
    for (const row of rows.filter((r) => r.week === week)) {
      if (row.is_bye || !row.away_manager) continue;
      const home = running.get(row.home_manager);
      const away = running.get(row.away_manager);
      if (row.winner === "TIE") {
        home.ties += 1;
        away.ties += 1;
      } else if (row.winner === "HOME") {
        home.wins += 1;
        away.losses += 1;
      } else if (row.winner === "AWAY") {
        away.wins += 1;
        home.losses += 1;
      }
    }
    for (const m of managers) {
      snapshot.set(`${m}|${week}`, { ...running.get(m) });
    }
  }
  return snapshot;
}

function formatRecord(rec) {
  if (!rec) return "";
  return rec.ties > 0 ? `${rec.wins}-${rec.losses}-${rec.ties}` : `${rec.wins}-${rec.losses}`;
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
  const records = useMemo(() => computeRunningRecords(rows), [rows]);

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
                    {weekRows.map((row, i) => {
                      const homeWon = !row.is_bye && row.winner === "HOME";
                      const awayWon = !row.is_bye && row.winner === "AWAY";
                      const homeRec = formatRecord(records.get(`${row.home_manager}|${row.week}`));
                      const awayRec = row.away_manager
                        ? formatRecord(records.get(`${row.away_manager}|${row.week}`))
                        : "";
                      const winnerStyle = { color: "var(--win)", fontWeight: 700 };
                      return (
                        <tr key={i}>
                          <td style={homeWon ? winnerStyle : undefined}>
                            {row.home_manager}
                            {homeRec && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> ({homeRec})</span>}
                          </td>
                          <td>
                            {row.home_points?.toFixed?.(1) ?? row.home_points}
                            {!row.is_bye && row.away_points != null && ` - ${row.away_points.toFixed?.(1) ?? row.away_points}`}
                          </td>
                          <td style={awayWon ? winnerStyle : undefined}>
                            {row.is_bye ? "—" : row.away_manager}
                            {awayRec && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> ({awayRec})</span>}
                          </td>
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
                      );
                    })}
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
