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

const COLORS = [
  "#5b9dff", "#3ecf8e", "#ff6b6b", "#d9b64e", "#c77dff",
  "#4dd4d4", "#ff9f5b", "#9fd35c", "#f06292", "#7986cb",
  "#a1887f", "#90a4ae",
];

function pivotWeekly(weekly) {
  const teams = [...new Set(weekly.map((r) => r.team))].sort();
  const byWeek = new Map();
  for (const row of weekly) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, { week: row.week });
    byWeek.get(row.week)[row.team] = row.points;
  }
  const rows = [...byWeek.values()].sort((a, b) => a.week - b.week);
  return { teams, rows };
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
      return a[sortKey] > b[sortKey] ? dir : a[sortKey] < b[sortKey] ? -dir : 0;
    });
    return rows;
  }, [data, sortKey, sortDir]);

  const { teams, rows: trendRows } = useMemo(
    () => (data?.weekly ? pivotWeekly(data.weekly) : { teams: [], rows: [] }),
    [data]
  );

  const { teams: playoffTeams, rows: playoffTrendRows } = useMemo(
    () => (data?.playoffWeekly ? pivotWeekly(data.playoffWeekly) : { teams: [], rows: [] }),
    [data]
  );

  // Selecting a team (via the standings table or either trend chart's
  // legend/line) narrows both trend charts to just that team. Selecting
  // the same one again clears it back to showing everyone.
  const [selectedTeam, setSelectedTeam] = useState(null);
  function selectTeam(team) {
    setSelectedTeam((prev) => (prev === team ? null : team));
  }

  const visibleTeams = selectedTeam ? teams.filter((t) => t === selectedTeam) : teams;
  const visiblePlayoffTeams = selectedTeam
    ? playoffTeams.filter((t) => t === selectedTeam)
    : playoffTeams;

  // Explicit legend payloads (rather than Recharts' default, which only
  // lists currently-rendered Lines) so every team stays clickable in the
  // legend even while the chart itself is narrowed to just one line.
  const legendPayload = teams.map((team, i) => ({
    value: team,
    type: "line",
    color: COLORS[i % COLORS.length],
  }));
  const playoffLegendPayload = playoffTeams.map((team, i) => ({
    value: team,
    type: "line",
    color: COLORS[i % COLORS.length],
  }));

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
              {data.regularSeasonWeeks ? ` (Regular Season, Weeks 1-${data.regularSeasonWeeks})` : ""}
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
                        {row.team}
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

          <div className="panel">
            <h2>
              Weekly Points Trend
              {data.regularSeasonWeeks ? ` (Regular Season, Weeks 1-${data.regularSeasonWeeks})` : ""}
            </h2>
            {trendRows.length > 0 ? (
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={trendRows} margin={{ bottom: 12 }}>
                  <CartesianGrid stroke="#2a2e37" />
                  <XAxis dataKey="week" stroke="#9aa1ad" label={{ value: "Week", position: "insideBottom", offset: -5, fill: "#9aa1ad" }} />
                  <YAxis stroke="#9aa1ad" />
                  <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
                  <Legend
                    payload={legendPayload}
                    onClick={(e) => selectTeam(e.value)}
                    wrapperStyle={{ cursor: "pointer", paddingTop: 20 }}
                  />
                  {visibleTeams.map((team) => (
                    <Line
                      key={team}
                      type="monotone"
                      dataKey={team}
                      stroke={COLORS[teams.indexOf(team) % COLORS.length]}
                      dot={false}
                      strokeWidth={2}
                      onClick={() => selectTeam(team)}
                      style={{ cursor: "pointer" }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state">No weekly data yet.</div>
            )}
          </div>

          {data.regularSeasonWeeks != null && (
            <div className="panel">
              <h2>
                Playoff Weekly Points Trend
                {playoffTrendRows.length > 0
                  ? ` (Weeks ${data.regularSeasonWeeks + 1}-${playoffTrendRows[playoffTrendRows.length - 1].week})`
                  : ""}
              </h2>
              {playoffTrendRows.length > 0 ? (
                <ResponsiveContainer width="100%" height={420}>
                  <LineChart data={playoffTrendRows} margin={{ bottom: 12 }}>
                    <CartesianGrid stroke="#2a2e37" />
                    <XAxis dataKey="week" stroke="#9aa1ad" label={{ value: "Week", position: "insideBottom", offset: -5, fill: "#9aa1ad" }} />
                    <YAxis stroke="#9aa1ad" />
                    <Tooltip contentStyle={{ background: "#171a21", border: "1px solid #2a2e37" }} />
                    <Legend
                      payload={playoffLegendPayload}
                      onClick={(e) => selectTeam(e.value)}
                      wrapperStyle={{ cursor: "pointer", paddingTop: 20 }}
                    />
                    {visiblePlayoffTeams.map((team) => (
                      <Line
                        key={team}
                        type="monotone"
                        dataKey={team}
                        stroke={COLORS[playoffTeams.indexOf(team) % COLORS.length]}
                        dot={false}
                        strokeWidth={2}
                        onClick={() => selectTeam(team)}
                        style={{ cursor: "pointer" }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="empty-state">Playoffs haven&apos;t started yet.</div>
              )}
            </div>
          )}
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
