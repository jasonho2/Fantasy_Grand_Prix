"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/standings", label: "Standings & Trends" },
  { href: "/players", label: "Players & Positions" },
  { href: "/matchups", label: "Matchups & Schedule" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="topnav">
      <span className="brand">ESPN Fantasy Football</span>
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} className={pathname === link.href ? "active" : ""}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
