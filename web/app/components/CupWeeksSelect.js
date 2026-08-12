"use client";

// Purely presentational, same pattern as SeasonSelect/LeagueSelect -- the
// parent page owns the value and how it's persisted (a "cupWeeks" URL
// param via useUrlState, carried across navigation the same way
// league/season are -- see Nav.js).
export default function CupWeeksSelect({ value, onChange }) {
  return (
    <select
      value={value === "15" ? "15" : "16"}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Grand Prix cup length"
    >
      <option value="16">16-Week Cups</option>
      <option value="15">15-Week Cups</option>
    </select>
  );
}
