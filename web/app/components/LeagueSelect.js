"use client";

// Mirrors SeasonSelect -- purely presentational, hidden entirely when 0-1
// leagues are registered so a single-league setup (the common case today)
// looks exactly as it always has. The parent page owns the value and how
// it's persisted (see lib/useUrlState.js).
export default function LeagueSelect({ leagues, league, onChange }) {
  if (!leagues || leagues.length < 2) return null;

  return (
    <select value={league || ""} onChange={(e) => onChange(e.target.value)} aria-label="League">
      {leagues.map((l) => (
        <option key={l.slug} value={l.slug}>
          {l.displayName || l.slug}
        </option>
      ))}
    </select>
  );
}
