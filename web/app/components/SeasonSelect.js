"use client";

// Purely presentational -- the parent page owns the value and how it's
// persisted (see lib/useUrlState.js for why that's not a plain router.push
// done in here anymore).
export default function SeasonSelect({ seasons, season, onChange }) {
  if (!seasons || seasons.length === 0) return null;

  return (
    <select value={season || ""} onChange={(e) => onChange(e.target.value)} aria-label="Season">
      {seasons.map((s) => (
        <option key={s} value={s}>
          {s} Season
        </option>
      ))}
    </select>
  );
}
