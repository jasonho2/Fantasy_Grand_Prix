"use client";

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

  return (
    <nav className="topnav">
      <span className="brand">{grandPrixLabel}</span>
      {links.map((link) => (
        <Link key={link.href} href={link.href} className={pathname === link.href ? "active" : ""}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
