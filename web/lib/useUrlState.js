"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * A URL search param that behaves like useState: the value returned right
 * after calling the setter is never behind a pending router transition.
 *
 * Why this exists: SeasonSelect/LeagueSelect used to read straight from
 * useSearchParams() and call router.push() on change. On a "cold" page --
 * first load, or first change since the page mounted -- that push can take
 * a moment (or, per a still-unexplained Next.js App Router quirk, can miss
 * a render entirely) before components reading useSearchParams() see the
 * new value, so the dropdown looked unresponsive on the first try and only
 * "caught up" on a second click. This sidesteps that by tracking the
 * current value in local state -- updated synchronously the instant the
 * setter is called -- rather than re-deriving it from the URL after every
 * render. The URL is still kept in sync as a side effect (for bookmarking,
 * sharing, and Nav carrying the selection across pages), it just isn't the
 * thing anything here has to wait on.
 *
 * An effect still watches the URL so a change that didn't come from this
 * hook's own setter (browser back/forward, a Nav link, pasting a URL) is
 * picked up rather than leaving local state stale.
 */
export function useUrlState(key) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get(key);

  const [value, setLocalValue] = useState(urlValue);

  useEffect(() => {
    setLocalValue(urlValue);
  }, [urlValue]);

  const setValue = useCallback(
    (next, { clear } = {}) => {
      setLocalValue(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next == null || next === "") params.delete(key);
      else params.set(key, next);
      if (clear) {
        for (const clearKey of clear) params.delete(clearKey);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [key, pathname, router, searchParams]
  );

  return [value, setValue];
}
