"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

export default function SeasonSelect({ seasons, season }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleChange(e) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("season", e.target.value);
    router.push(`${pathname}?${params.toString()}`);
    // On a "cold" page (first load/hard refresh, before any other client-side
    // navigation has happened), Next's router cache can fail to re-render
    // components reading useSearchParams() for a search-param-only push on
    // the SAME route -- the URL bar updates but the page doesn't react. A
    // second navigation elsewhere "warms" the cache and it starts working,
    // which is the bug this was filed as. Forcing a refresh alongside the
    // push bypasses that cache instead of depending on an unrelated nav.
    router.refresh();
  }

  if (!seasons || seasons.length === 0) return null;

  return (
    <select value={season || ""} onChange={handleChange} aria-label="Season">
      {seasons.map((s) => (
        <option key={s} value={s}>
          {s} Season
        </option>
      ))}
    </select>
  );
}
