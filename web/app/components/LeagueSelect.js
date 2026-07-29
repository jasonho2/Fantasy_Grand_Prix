"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Mirrors SeasonSelect. Hidden entirely when 0-1 leagues are registered, so
// a single-league setup (the common case today) looks exactly as it always
// has -- the dropdown only appears once a second league actually exists.
export default function LeagueSelect({ leagues, league }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleChange(e) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("league", e.target.value);
    // Different leagues can have different seasons pulled -- drop any
    // season pinned in the URL so the new league falls back to its own
    // latest season instead of possibly pointing at one it doesn't have.
    params.delete("season");
    router.push(`${pathname}?${params.toString()}`);
  }

  if (!leagues || leagues.length < 2) return null;

  return (
    <select value={league || ""} onChange={handleChange} aria-label="League">
      {leagues.map((l) => (
        <option key={l.slug} value={l.slug}>
          {l.displayName || l.slug}
        </option>
      ))}
    </select>
  );
}
