"use client";

import { useEffect, useState } from "react";

// Desktop-only: pin the Recharts line-chart tooltip to a reserved column on
// the right side of the chart instead of letting it follow the cursor, so it
// never covers the lines being inspected -- the whole plot stays visible to
// the left of the tooltip. Mobile (<= 720px, same breakpoint as
// globals.css) keeps Recharts' default follow-the-cursor behavior, since a
// narrow screen can't spare the extra width.
export const SIDE_TOOLTIP_WIDTH = 210;
const DESKTOP_QUERY = "(min-width: 721px)";

export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

const BASE_CONTENT_STYLE = { background: "var(--panel)", border: "1px solid var(--border)" };

// Props for <Tooltip>. Recharts applies wrapperStyle *after* its own
// computed cursor-following transform, so overriding left/right/transform
// here pins the tooltip to the chart wrapper's top-right corner -- which,
// with sideTooltipMargin() added to the chart's right margin, is empty
// space beside the plot rather than on top of it.
export function sideTooltipProps(isDesktop) {
  if (!isDesktop) return { contentStyle: BASE_CONTENT_STYLE };
  return {
    contentStyle: { ...BASE_CONTENT_STYLE, whiteSpace: "normal", fontSize: 12, padding: "6px 8px" },
    wrapperStyle: {
      left: "auto",
      right: 0,
      top: 0,
      width: SIDE_TOOLTIP_WIDTH - 8,
      transform: "none",
      transition: "none",
    },
    isAnimationActive: false,
  };
}

// Extra right margin (px) to reserve for the pinned tooltip column.
export function sideTooltipMargin(isDesktop) {
  return isDesktop ? SIDE_TOOLTIP_WIDTH : 0;
}
