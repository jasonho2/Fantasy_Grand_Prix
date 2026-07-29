"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A URL search param that behaves like useState, fully decoupled from
 * Next's App Router for both reading and writing.
 *
 * Why: this used to read via next/navigation's useSearchParams() and write
 * via router.push(). router.push() turned out to not reliably update the
 * address bar at all for a search-param-only change on this deployment.
 * Switching the write to a raw history.pushState() (plus a synthetic
 * popstate event, so other instances of this hook on the page notice) fixed
 * that -- but it surfaced a second problem: Next's own router apparently
 * only updates its internal useSearchParams() state from *its own*
 * navigations (real browser back/forward, or router.push/replace), not
 * from a manually dispatched popstate event. So Nav.js, which reads
 * league/season via useSearchParams() to build its links, went stale and
 * stopped carrying the current season across page navigation.
 *
 * Rather than patch around that a third time, this hook (and Nav.js) don't
 * use next/navigation's search-param APIs at all anymore -- everything
 * reads/writes window.location directly and stays in sync purely via the
 * popstate event (both the real one, for actual back/forward, and the
 * synthetic one this hook's own setter dispatches). Any component using
 * this hook for the same key -- on the same page or in Nav -- reacts to
 * every change, from wherever it came from.
 */

function readParam(key) {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function useUrlState(key) {
  const [value, setLocalValue] = useState(() => readParam(key));

  useEffect(() => {
    function sync() {
      setLocalValue(readParam(key));
    }
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [key]);

  const setValue = useCallback(
    (next, { clear } = {}) => {
      const params = new URLSearchParams(window.location.search);
      if (next == null || next === "") params.delete(key);
      else params.set(key, next);
      if (clear) {
        for (const clearKey of clear) params.delete(clearKey);
      }
      const qs = params.toString();
      const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      window.history.pushState(window.history.state, "", url);
      // Update synchronously rather than waiting on the event below, so
      // this component reacts to its own change immediately regardless of
      // event dispatch/listener ordering.
      setLocalValue(next);
      // Not fired natively by pushState -- this is what lets every other
      // useUrlState instance (this page's other key, or Nav.js) notice.
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [key]
  );

  return [value, setValue];
}
