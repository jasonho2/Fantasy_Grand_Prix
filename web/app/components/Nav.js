"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";

const BASE_LINKS = [
  { href: "/standings", label: "Season Leaderboard" },
  { href: "/players", label: "Players & Positions" },
  { href: "/matchups", label: "Matchups & Schedule" },
  { href: "/leagues/new", label: "Leagues" },
];

// SQLite's datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" -- not ISO
// 8601 (no "T", no timezone offset) -- so handing that string straight to
// `new Date(...)` gets misinterpreted as *local* time by the browser
// instead of UTC. Normalizing to add "T"/"Z" first makes it unambiguous,
// then Intl.DateTimeFormat converts to Pacific for display regardless of
// the viewer's own timezone (this league runs on Pacific time, not
// whatever timezone a given visitor's device happens to be in).
function formatDataAsOf(lastPulledAt) {
  if (!lastPulledAt) return null;
  const iso = lastPulledAt.includes("T") ? lastPulledAt : `${lastPulledAt.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function NavInner() {
  const pathname = usePathname();
  // Read-only here -- Nav never changes these itself, only carries whatever
  // a page's LeagueSelect/SeasonSelect last set into its own links. See
  // lib/useUrlState.js for why this isn't next/navigation's
  // useSearchParams() (it doesn't reliably stay in sync with the raw URL
  // writes those selects now make).
  const [league] = useUrlState("league");
  const [season] = useUrlState("season");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const grandPrixLabel = meta?.leagueName ? `${meta.leagueName} Grand Prix` : "Contests";
  const dataAsOf = formatDataAsOf(meta?.lastPulledAt);

  // About is first "for now" per explicit request -- easy to move back
  // once the page's content is refined.
  const links = [{ href: "/about", label: "About" }, { href: "/contests", label: grandPrixLabel }, ...BASE_LINKS];

  // Carry the selected league and season across page navigation, so picking
  // either on one page doesn't silently reset when clicking to another.
  function hrefFor(href) {
    const params = new URLSearchParams();
    if (league) params.set("league", league);
    if (season) params.set("season", season);
    const qs = params.toString();
    return qs ? `${href}?${qs}` : href;
  }

  // Collapsed behind a hamburger button below the mobile breakpoint (see
  // the `nav.topnav` rules in globals.css). Closed on every route change
  // so navigating never leaves a stale menu open underneath the new page.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <nav className={`topnav${menuOpen ? " menu-open" : ""}`}>
      <div className="topnav-bar">
        <button
          type="button"
          className="nav-toggle"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <span className="brand">{grandPrixLabel}</span>
        {dataAsOf && (
          <span
            title="When the pipeline last checked ESPN for this league -- not necessarily when anything changed"
            style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}
          >
            Data as of {dataAsOf}
          </span>
        )}
      </div>
      <div className="nav-links">
        {links.map((link) => (
          <Link key={link.href} href={hrefFor(link.href)} className={pathname === link.href ? "active" : ""}>
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export default function Nav() {
  return (
    <Suspense fallback={<nav className="topnav" />}>
      <NavInner />
    </Suspense>
  );
}
