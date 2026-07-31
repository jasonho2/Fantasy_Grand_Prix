"use client";

// A `dot` render prop for a recharts <Line>, used only at that line's last
// plotted data point, so every team's line ends with a small circular logo
// marker instead of just stopping. Not a component recharts mounts through
// React the normal way -- it's called directly as a function per data point
// (see recharts' own custom-dot examples), so this stays a plain function
// returning raw SVG elements, not a component with hooks.
//
// clipId must be unique per (chart, team) on the page -- a page can have
// more than one chart showing the same team (Standings' two trend charts,
// or a page with several cups), and SVG clipPath ids are a single global
// namespace per document, so reusing an id across charts would make one
// chart's circular clip silently apply to another's <image>.
export default function ChartTeamLogoDot({ cx, cy, src, size = 18, clipId }) {
  if (cx == null || cy == null) return null;
  const r = size / 2;
  const ex = cx + r + 4; // nudge past the line's actual endpoint, not on top of it

  if (!src) {
    return (
      <circle
        key={clipId}
        cx={ex}
        cy={cy}
        r={r}
        fill="var(--border)"
        stroke="#0d0f14"
        strokeWidth={1}
      />
    );
  }

  return (
    <g key={clipId}>
      <clipPath id={clipId}>
        <circle cx={ex} cy={cy} r={r} />
      </clipPath>
      <image
        href={src}
        x={ex - r}
        y={cy - r}
        width={size}
        height={size}
        preserveAspectRatio="xMidYMid slice"
        clipPath={`url(#${clipId})`}
      />
      <circle cx={ex} cy={cy} r={r} fill="none" stroke="#0d0f14" strokeWidth={1} />
    </g>
  );
}

// Slugifies a team name into something safe to embed in an SVG id/url(#..)
// reference -- team names can contain spaces, apostrophes, emoji, etc.,
// none of which belong in an id that's about to be referenced via
// `url(#id)`.
export function slugForId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-");
}

// Index of the last row (in a recharts-ready pivoted rows array) where this
// team has a non-null value -- i.e. where its line actually ends, which is
// not necessarily the last row in the array (a team can be missing data for
// the most recent week(s), e.g. this week hasn't been pulled yet). Shared
// by every chart that ends its lines with a logo marker.
export function lastValidRowIndex(rows, team) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][team] != null) return i;
  }
  return -1;
}
