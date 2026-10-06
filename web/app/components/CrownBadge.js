"use client";

// Crown emoji with the number of Grand Prix cups this team's manager has
// won (all seasons, league-configured scoring) printed on the crown itself.
// Renders nothing for a team with no crowns. See api/crowns/route.js.
export default function CrownBadge({ crown, size = 22 }) {
  if (!crown?.count) return null;
  const tooltip = `${crown.count} Grand Prix crown${crown.count === 1 ? "" : "s"}:\n${crown.wins
    .map((w) => `${w.season} ${w.cup}${w.team ? ` (${w.team})` : ""}`)
    .join("\n")}`;
  return (
    <span
      title={tooltip}
      aria-label={`${crown.count} Grand Prix crown${crown.count === 1 ? "" : "s"}`}
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        lineHeight: `${size}px`,
        fontSize: size * 0.9,
        textAlign: "center",
        flexShrink: 0,
        cursor: "help",
      }}
    >
      <span aria-hidden="true">👑</span>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "54%",
          transform: "translateY(-50%)",
          fontSize: Math.round(size * 0.42),
          fontWeight: 800,
          lineHeight: 1,
          color: "#4a2c00",
          textShadow: "0 0 2px #ffe27a",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {crown.count}
      </span>
    </span>
  );
}
