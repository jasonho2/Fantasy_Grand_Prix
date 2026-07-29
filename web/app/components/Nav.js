"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { useJson } from "../../lib/useJson";

const BASE_LINKS = [
  { href: "/standings", label: "Season Leaderboard" },
  { href: "/players", label: "Players & Positions" },
  { href: "/matchups", label: "Matchups & Schedule" },
  { href: "/leagues/new", label: "+ Add League" },
];

function NavInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const league = searchParams.get("league");

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const grandPrixLabel = meta?.leagueName ? `${meta.leagueName} Grand Prix` : "Contests";

  const links = [{ href: "/contests", label: grandPrixLabel }, ...BASE_LINKS];

  // Carry the selected league across page navigation (unlike season, which
  // intentionally resets to each page's latest by default) -- otherwise
  // picking a league on one page and clicking to another would silently
  // snap back to the first registered league.
  function hrefFor(href) {
    return league ? `${href}?league=${encodeURIComponent(league)}` : href;
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
