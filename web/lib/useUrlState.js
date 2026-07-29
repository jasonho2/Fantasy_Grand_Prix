"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A URL search param that behaves like useState: the value returned right
 * after calling the setter is never behind a pending router transition.
 *
 * Why this exists: SeasonSelect/LeagueSelect used to read straight from
 * useSearchParams() and call router.push() on change. On this deployment,
 * a router.push() that only changes search params on an already-loaded,
 * fully static ("use client") route turned out to not reliably update the
 * address bar at all -- not a re-render timing issue, the URL genuinely
 * never changed on the first attempt, confirmed by checking the URL bar
 * directly. Adding router.refresh() alongside it (a first attempted fix)
 * made it worse by racing the push and needing a second click.
 *
 * This sidesteps router.push() entirely for writing the URL: it writes
 * with the raw History API (which always works, since it's not routed
 * through whatever was swallowing router.push) and then dispatches a
 * synthetic `popstate` event so Next's own router notices the change the
 * same way it would a browser back/forward navigation -- that's what
 * keeps Nav.js's separate useSearchParams() call (for the page label and
 * for carrying the selection into its links) in sync without it needing
 * any changes of its own.
 *
 * The value used for rendering here, though, comes from local state --
 * updated synchronously the instant the setter is called -- not from
 * re-reading the URL after every render, so a dropdown always visibly (and
 * immediately) reacts to its own change regardless of how any of the above
 * plays out. An effect still watches the URL so a change that didn't come
 * from this hook's own setter (browser back/forward, a Nav link, pasting a
 * URL) is picked up rather than leaving local state stale.
 */
export function useUrlState(key) {
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
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      window.history.pushState(window.history.state, "", url);
      // pushState alone doesn't fire any event -- this is what lets Next's
      // router (and any other useUrlState instance on the page, e.g. the
      // other of the league/season pair) pick up the change.
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [key, pathname, searchParams]
  );

  return [value, setValue];
}
