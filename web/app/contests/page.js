"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import SeasonSelect from "../components/SeasonSelect";
import { useJson } from "../../lib/useJson";

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

function ContestsInner() {
  const searchParams = useSearchParams();
  const season = searchParams.get("season");

  const { data: meta } = useJson("/api/meta");
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];

  const { data, loading, error } = useJson(activeSeason ? `/api/contests?season=${activeSeason}` : null);

  return (
    <>
      <div className="controls">
        <SeasonSelect seasons={seasons} season={activeSeason} />
      </div>

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

      {data &&
        data.contests.map((contest) => (
          <div className="panel" key={contest.name}>
            <h2>
              {contest.name} (Weeks {contest.start_week}-{contest.end_week}){" "}
              <span className={`badge ${STATUS_BADGE_CLASS[contest.status]}`}>
                {STATUS_LABEL[contest.status]}
              </span>
            </h2>
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Manager</th>
                  <th>Points</th>
                </tr>
              </thead>
              <tbody>
                {contest.leaderboard.map((row) => (
                  <tr key={row.manager} style={row.rank === 1 ? { fontWeight: 700 } : undefined}>
                    <td>{row.rank}</td>
                    <td>
                      {row.manager}
                      {row.rank === 1 && (
                        <span className="badge win" style={{ marginLeft: 8 }}>
                          Leader
                        </span>
                      )}
                    </td>
                    <td>{row.total_points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {contest.leaderboard.length === 0 && (
              <div className="empty-state">No games played in this window yet.</div>
            )}
          </div>
        ))}
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
