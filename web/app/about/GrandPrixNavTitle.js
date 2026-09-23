"use client";

import { Suspense } from "react";

import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

// The Contests page's nav label is "<league name> Grand Prix" (see Nav.js),
// so the About page's entry for it uses the same dynamic name -- falls back
// to plain "Grand Prix" before /api/meta loads or if no league is set up.
function Inner() {
  const [league] = useUrlState("league");
  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const name = meta?.leagueName ? `${meta.leagueName} Grand Prix` : "Grand Prix";
  return <>{name} -- Contests page</>;
}

export default function GrandPrixNavTitle() {
  return (
    <Suspense fallback={<>Grand Prix -- Contests page</>}>
      <Inner />
    </Suspense>
  );
}
