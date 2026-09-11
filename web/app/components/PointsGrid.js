"use client";

import { ordinal } from "../../lib/scoring";

// Shared placement -> points entry grid: one number box per weekly
// placement (1st, 2nd, ...), sized and placeholder-labeled off whatever
// `defaults` array the caller passes in (a fully-resolved table -- the
// plain built-in default, or a league's own configured default, depending
// on the caller). Used both by the Contests page's personal "Change Point
// System" editor and the Add League / Manage Leagues "Grand Prix settings"
// scoring picker -- same input shape (a sparse array of strings, one slot
// per placement, blank = "no override") either way; only what the override
// means (a personal display preference vs. a league's stored default)
// differs, which is the caller's concern, not this component's.
export default function PointsGrid({ defaults, draft, onChange }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
        gap: 10,
      }}
    >
      {defaults.map((def, i) => (
        <label
          key={i}
          style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-dim)" }}
        >
          {ordinal(i + 1)}
          <input
            type="number"
            className="week-number-input"
            placeholder={String(def)}
            value={draft[i] ?? ""}
            onChange={(e) => onChange(i, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
