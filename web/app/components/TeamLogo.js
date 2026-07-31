"use client";

import { useState } from "react";

// Small circular team profile picture for use inline next to a team name in
// a table cell. Falls back to a plain dot (not a broken-image icon) both
// when no logo_url is on record yet (team pulled before the column existed,
// or a platform -- Sleeper -- that doesn't expose one) and if the URL 404s
// or ESPN's CDN blocks the request at render time (onError), so a stale or
// unreachable logo degrades gracefully instead of showing a broken-image
// glyph.
export default function TeamLogo({ src, alt = "", size = 20, style }) {
  const [errored, setErrored] = useState(false);

  const dotStyle = {
    display: "inline-block",
    width: size,
    height: size,
    borderRadius: "50%",
    background: "var(--border)",
    verticalAlign: "middle",
    flexShrink: 0,
    ...style,
  };

  if (!src || errored) {
    return <span aria-hidden="true" style={dotStyle} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{
        ...dotStyle,
        background: "var(--panel)",
        objectFit: "cover",
      }}
      onError={() => setErrored(true)}
      referrerPolicy="no-referrer"
    />
  );
}
