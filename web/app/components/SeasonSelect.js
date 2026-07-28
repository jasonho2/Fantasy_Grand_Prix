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
