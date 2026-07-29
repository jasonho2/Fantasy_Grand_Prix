"use client";

import { Suspense, useMemo, useState } from "react";
import SeasonSelect from "../components/SeasonSelect";
import LeagueSelect from "../components/LeagueSelect";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

const STATUS_LABEL = {
  final: "Final",
  in_progress: "In Progress",
  upcoming: "Upcoming",
};
const STATUS_BADGE_CLASS = {
  final: "win",
  in_progress: "tie",
  upcoming: "bye",
};

// Simple original icons evoking each cup (not reproductions of Nintendo's
// artwork/trademarks) so each contest panel is visually distinct at a glance.
function MushroomIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 11a10 6 0 0 1 20 0Z" fill="#ff6b6b" />
      <circle cx="8" cy="8.5" r="1.4" fill="#fff" />
      <circle cx="14" cy="7" r="1.1" fill="#fff" />
      <circle cx="17.5" cy="10" r="1" fill="#fff" />
      <rect x="8.5" y="11" width="7" height="8" rx="3" fill="#f2e9d8" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.7 6.2 6.6.6-5 4.5 1.5 6.6L12 16.9l-5.8 3.5 1.5-6.6-5-4.5 6.6-.6Z"
        fill="#f0d84a"
      />
    </svg>
  );
}

const CUP_ICONS = {
  "Mushroom Cup": MushroomIcon,
  "Flower Cup": "\u{1F337}", // tulip
  "Star Cup": StarIcon,
  "Special Cup": "\u{1F451}", // crown
};

// Movement vs. this cup's previous played week (see the contests API route
// for how it's computed -- always against the placement-points rank,
// regardless of whether the "Sort by" toggle below currently has fantasy
// points selected instead). Nothing renders for a team that held its
// spot, or before a second week has been played in this cup.
function RankDelta({ delta }) {
  if (!delta) return null;
  const up = delta > 0;
  const magnitude = Math.abs(delta);
  return (
    <span
      title={`${up ? "Up" : "Down"} ${magnitude} spot${magnitude === 1 ? "" : "s"} vs last week`}
      style={{
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 700,
        color: up ? "var(--win)" : "var(--loss)",
        whiteSpace: "nowrap",
      }}
    >
      {up ? "▲" : "▼"}
      {magnitude}
    </span>
  );
}

function ContestPanel({ contest }) {
  // Descending only, per spec -- just which column, not direction.
  const [sortBy, setSortBy] = useState("contest_points");

  const sortedLeaderboard = useMemo(() => {
    const rows = [...contest.leaderboard].sort((a, b) => b[sortBy] - a[sortBy]);
    return rows.map((row, i) => ({ ...row, displayRank: i + 1 }));
  }, [contest.leaderboard, sortBy]);

  const Icon = CUP_ICONS[contest.name];

  return (
    <div className="panel">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {typeof Icon === "string" ? (
          <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden="true">{Icon}</span>
        ) : (
          Icon && <Icon />
        )}
        {contest.name} (Weeks {contest.start_week}-{contest.end_week}){" "}
        <span className={`badge ${STATUS_BADGE_CLASS[contest.status]}`}>{STATUS_LABEL[contest.status]}</span>
      </h2>

      <div className="controls" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Sort by:</span>
        <button
          type="button"
          className={`week-chip${sortBy === "contest_points" ? " selected" : ""}`}
          onClick={() => setSortBy("contest_points")}
        >
          Total
        </button>
        <button
          type="button"
          className={`week-chip${sortBy === "fantasy_points" ? " selected" : ""}`}
          onClick={() => setSortBy("fantasy_points")}
        >
          Fantasy Points (ref)
        </button>
      </div>

      <div className="table-scroll">
        <table className="contests-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th className="sticky-col">Team</th>
              {contest.weeks.map((wk) => (
                <th key={wk}>Wk {wk}</th>
              ))}
              <th>Total</th>
              <th title="Fantasy Points (ref)">PF</th>
            </tr>
          </thead>
          <tbody>
            {sortedLeaderboard.map((row) => (
              <tr key={row.team} style={row.displayRank === 1 ? { fontWeight: 700 } : undefined}>
                <td>{row.displayRank}</td>
                <td className="sticky-col">
                  <span className="wrap-cell" style={{ display: "inline-block", verticalAlign: "middle" }}>
                    {row.team}
                  </span>
                  <RankDelta delta={row.rankDelta} />
                  {row.displayRank === 1 && (
                    <span className="badge win" style={{ marginLeft: 6 }}>
                      Leader
                    </span>
                  )}
                </td>
                {row.weekly_points.map((pts, i) => (
                  <td key={contest.weeks[i]}>{pts ?? "—"}</td>
                ))}
                <td style={sortBy === "contest_points" ? { fontWeight: 700 } : undefined}>{row.contest_points}</td>
                <td style={sortBy === "fantasy_points" ? { fontWeight: 700 } : undefined}>{row.fantasy_points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sortedLeaderboard.length === 0 && <div className="empty-state">No games played in this window yet.</div>}
    </div>
  );
}

function ContestsInner() {
  const [league, setLeague] = useUrlState("league");
  const [season, setSeason] = useUrlState("season");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeSeason && activeLeague
      ? `/api/contests?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );

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

      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>
        {data?.leagueName ? `${data.leagueName} Grand Prix` : "Grand Prix"}
      </h1>
      <p style={{ color: "var(--text-dim)", fontSize: 14, marginTop: 0, marginBottom: 20 }}>
        Each week, every team is ranked by that week&apos;s fantasy score and earns placement
        points (1st: 12, 2nd: 10, 3rd: 9, down to last: 0). Placement points accumulate within a
        cup&apos;s weeks and determine the ranking below by default; use the sort toggle on each
        cup to rank by total fantasy points instead. Fantasy points are otherwise shown for
        reference only.
      </p>

      {loading && <div className="loading-state">Loading contests...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && data.contests.length === 0 && (
        <div className="panel">
          <div className="empty-state">
            No contest windows are configured for this season yet. Add a "contests" section for{" "}
            {activeSeason} in config.json and rerun the pipeline.
          </div>
        </div>
      )}

      {data && data.contests.map((contest) => <ContestPanel key={contest.name} contest={contest} />)}
    </>
  );
}

export default function ContestsPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <ContestsInner />
    </Suspense>
  );
}
