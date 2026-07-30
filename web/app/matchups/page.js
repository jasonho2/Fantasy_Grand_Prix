"use client";

import { Suspense, useMemo, useState } from "react";
import SeasonSelect from "../components/SeasonSelect";
import LeagueSelect from "../components/LeagueSelect";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

// Cumulative W-L(-T) record for every team as of the end of each week,
// computed from the FULL season's matchups regardless of any team
// filter applied to the display -- a record has to account for every game
// played, not just the ones currently shown.
function computeRunningRecords(rows) {
  const teams = new Set();
  rows.forEach((r) => {
    teams.add(r.home_team);
    if (r.away_team) teams.add(r.away_team);
  });
  const running = new Map([...teams].map((t) => [t, { wins: 0, losses: 0, ties: 0 }]));

  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  const snapshot = new Map(); // `${team}|${week}` -> { wins, losses, ties }

  for (const week of weeks) {
    for (const row of rows.filter((r) => r.week === week)) {
      if (row.is_bye || !row.away_team) continue;
      const home = running.get(row.home_team);
      const away = running.get(row.away_team);
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
    for (const t of teams) {
      snapshot.set(`${t}|${week}`, { ...running.get(t) });
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
    if (row.is_bye || !row.away_team) continue;
    const [a, b] = [row.home_team, row.away_team].sort();
    const key = `${a}|${b}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, aWins: 0, bWins: 0, ties: 0 });
    const entry = pairs.get(key);
    if (row.winner === "TIE") {
      entry.ties += 1;
    } else {
      const winnerTeam = row.winner === "HOME" ? row.home_team : row.away_team;
      if (winnerTeam === a) entry.aWins += 1;
      else entry.bWins += 1;
    }
  }
  return [...pairs.values()].sort((x, y) => (x.a + x.b).localeCompare(y.a + y.b));
}

function MatchupsInner() {
  const [league, setLeague] = useUrlState("league");
  const [season, setSeason] = useUrlState("season");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeSeason && activeLeague
      ? `/api/matchups?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );
  const rows = data?.rows || [];

  const [teamFilter, setTeamFilter] = useState("All");

  const teams = useMemo(() => {
    const set = new Set();
    rows.forEach((r) => {
      set.add(r.home_team);
      if (r.away_team) set.add(r.away_team);
    });
    return ["All", ...set].sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (teamFilter === "All") return rows;
    return rows.filter((r) => r.home_team === teamFilter || r.away_team === teamFilter);
  }, [rows, teamFilter]);

  const h2h = useMemo(() => headToHead(rows), [rows]);
  const weeks = useMemo(() => groupByWeek(filteredRows), [filteredRows]);
  const records = useMemo(() => computeRunningRecords(rows), [rows]);

  return (
    <>
      <div className="controls">
        <LeagueSelect
          leagues={meta?.leagues}
          league={activeLeague}
          onChange={(next) => setLeague(next, { clear: ["season"] })}
        />
        <SeasonSelect seasons={seasons} season={activeSeason} onChange={setSeason} />
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
          {teams.map((t) => (
            <option key={t} value={t}>{t === "All" ? "All Teams" : t}</option>
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
                <div className="table-scroll">
                  <table className="matchup-table">
                    <thead>
                      <tr>
                        <th>Home</th>
                        <th>Score</th>
                        <th>Away</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weekRows.map((row, i) => {
                        const homeWon = !row.is_bye && row.winner === "HOME";
                        const awayWon = !row.is_bye && row.winner === "AWAY";
                        const isTie = !row.is_bye && row.winner === "TIE";
                        const homeRec = formatRecord(records.get(`${row.home_team}|${row.week}`));
                        const awayRec = row.away_team
                          ? formatRecord(records.get(`${row.away_team}|${row.week}`))
                          : "";
                        const winnerStyle = { color: "var(--win)", fontWeight: 700 };
                        const tieStyle = { color: "var(--tie)" };
                        const cellStyle = (won) => (won ? winnerStyle : isTie ? tieStyle : undefined);
                        const recordStyle = { color: "var(--text-dim)", fontWeight: 400, whiteSpace: "nowrap" };
                        return (
                          <tr key={i}>
                            <td style={cellStyle(homeWon)}>
                              {row.home_team}
                              {homeRec && <span style={recordStyle}> ({homeRec})</span>}
                            </td>
                            <td title={row.is_bye ? "Starter points scored (bye week)" : undefined}>
                              {row.home_points?.toFixed?.(1) ?? row.home_points}
                              {!row.is_bye && row.away_points != null && ` - ${row.away_points.toFixed?.(1) ?? row.away_points}`}
                            </td>
                            <td style={cellStyle(awayWon)}>
                              {row.is_bye ? (
                                <span className="badge bye">BYE</span>
                              ) : (
                                row.away_team
                              )}
                              {awayRec && <span style={recordStyle}> ({awayRec})</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {weeks.length === 0 && <div className="empty-state">No games yet.</div>}
          </div>

          <div className="panel">
            <h2>Head-to-Head Records</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Team</th>
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
            </div>
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
