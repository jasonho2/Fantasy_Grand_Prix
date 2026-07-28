"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useJson } from "../../lib/useJson";

const BASE_LINKS = [
  { href: "/standings", label: "Season Leaderboard" },
  { href: "/players", label: "Players & Positions" },
  { href: "/matchups", label: "Matchups & Schedule" },
];

export default function Nav() {
  const pathname = usePathname();
  const { data: meta } = useJson("/api/meta");
  const grandPrixLabel = meta?.leagueName ? `${meta.leagueName} Grand Prix` : "Contests";

  const links = [{ href: "/contests", label: grandPrixLabel }, ...BASE_LINKS];

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
          <Link key={link.href} href={link.href} className={pathname === link.href ? "active" : ""}>
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
