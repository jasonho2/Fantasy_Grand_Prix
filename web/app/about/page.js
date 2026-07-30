export default function AboutPage() {
  return (
    <>
      <h1 style={{ fontSize: 20, margin: "0 0 20px" }}>About</h1>

      <div className="panel">
        <h2>Grand Prix Scoring</h2>
        <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
          Each cup has two modes. Solo ranks every team individually each week by that week&apos;s
          fantasy score, earning placement points (1st: 12, 2nd: 10, 3rd: 9, down to last: 0). Double
          Dash pairs up that week&apos;s actual head-to-head matchups instead -- both teams&apos;
          scores are combined, every pair in the league is ranked against each other, and both
          teammates earn the full placement points for wherever their pair landed (1st: 12, 2nd: 10,
          3rd: 9, 4th: 8, 5th: 7, 6th: 5). Either way, placement points accumulate within a cup&apos;s
          weeks and determine the ranking below by default; use the sort toggle on each cup to rank
          by total fantasy points instead, which is otherwise shown for reference only. While a week
          is being played, that week&apos;s column is marked <strong>LIVE</strong> and the standings
          already reflect its still-updating scores -- once ESPN finalizes the week, the provisional
          numbers are replaced with the real ones on the next data sync.
        </p>
      </div>
    </>
  );
}
