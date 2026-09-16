"use client";

import { Suspense } from "react";
import LeagueSelect from "../components/LeagueSelect";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

// Renders one recap's body as separate paragraphs -- same convention as
// contests/page.js's WeeklyRecapPanel (stored as plain text with blank
// lines between paragraphs, no markdown renderer needed).
function RecapBody({ body }) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs.map((p, i) => (
    <p key={i} style={{ fontSize: 14, lineHeight: 1.6, margin: i === paragraphs.length - 1 ? 0 : "0 0 10px" }}>
      {p}
    </p>
  ));
}

// Archive of every recap ever posted for a league, newest first -- unlike
// the single latest one shown on the Contests page, this has no season
// filter, so a recap from last year sits right below this year's most
// recent one. See api/recaps/route.js: omitting `season` from the query
// returns every recap for the league across all seasons, already sorted
// season desc, week desc.
function WeeklyReportInner() {
  const [league, setLeague] = useUrlState("league");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeLeague ? `/api/recaps?league=${encodeURIComponent(activeLeague)}` : null
  );
  const recaps = data?.recaps || [];

  return (
    <>
      <div className="controls">
        <LeagueSelect leagues={meta?.leagues} league={activeLeague} onChange={setLeague} />
      </div>

      <h1 style={{ fontSize: 20, margin: "0 0 20px" }}>Weekly Report</h1>

      {loading && <div className="loading-state">Loading recaps...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && recaps.length === 0 && (
        <div className="panel">
          <div className="empty-state">
            No recaps posted yet for this league -- one shows up here automatically once the
            first week wraps up (only for a league with the automated weekly recap enabled, see
            Manage Leagues).
          </div>
        </div>
      )}

      {recaps.map((recap) => (
        <div key={`${recap.season}-${recap.week}`} className="panel" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>{recap.title || `Week ${recap.week} Recap`}</h2>
          <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px" }}>
            {recap.season} Season -- Week {recap.week}
          </p>
          <RecapBody body={recap.body} />
        </div>
      ))}
    </>
  );
}

export default function WeeklyReportPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <WeeklyReportInner />
    </Suspense>
  );
}
