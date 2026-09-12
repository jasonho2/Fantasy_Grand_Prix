"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import SeasonSelect from "../components/SeasonSelect";
import LeagueSelect from "../components/LeagueSelect";
import CupWeeksSelect from "../components/CupWeeksSelect";
import TeamLogo from "../components/TeamLogo";
import ChartTeamLogoDot, { slugForId, lastValidRowIndex } from "../components/ChartTeamLogoDot";
import { useJson } from "../../lib/useJson";
import { useUrlState } from "../../lib/useUrlState";
import { ordinal } from "../../lib/scoring";

// Matches the palette used for the Standings/Players trend charts, for a
// consistent look across the app's line charts.
const COLORS = [
  "#5b9dff", "#3ecf8e", "#ff6b6b", "#d9b64e", "#c77dff",
  "#4dd4d4", "#ff9f5b", "#9fd35c", "#f06292", "#7986cb",
  "#a1887f", "#90a4ae",
];

// One line per placement ("1st: 12", "2nd: 10", ...) for a hover tooltip --
// `table` is a fully-resolved table (see resolvePointTable in
// ../../lib/scoring), so every index already has a real number, never a
// blank/override marker. Used on the scoring badge and the Mode toggle
// buttons so hovering either shows the whole distribution, not just the
// active mode's placement points.
function pointDistributionTooltip(table) {
  return table.map((pts, i) => `${ordinal(i + 1)}: ${pts}`).join("\n");
}

// Prefix for a per-week sort key, e.g. "week-2" sorts by contest.weeks[2] /
// row.weekly_points[2] -- distinguishes it from the two column-level sort
// keys ("contest_points", "fantasy_points") which index straight into a
// leaderboard row instead of into its weekly_points array.
const WEEK_SORT_PREFIX = "week-";

function weekSortKey(weekIndex) {
  return `${WEEK_SORT_PREFIX}${weekIndex}`;
}

// The value sortedLeaderboard below sorts by, for one row under whichever
// `sortBy` is currently active -- either a leaderboard-level total
// (contest_points/fantasy_points) or one specific week's placement points
// (weekly_points[i]). A bye/unplayed week is null, not 0; sorting by that
// week should still put those teams last (descending sort, so the lowest
// value sorts to the bottom) rather than tied with a team that actually
// scored 0 that week. "projected" isn't a real field on a row -- picking it
// swaps modeLeaderboard's whole source to the projected leaderboard (see
// ContestPanel below), whose rows still use "contest_points" as the total
// to rank by, same as the real "Total" sort.
function sortValueFor(row, sortBy) {
  if (typeof sortBy === "string" && sortBy.startsWith(WEEK_SORT_PREFIX)) {
    const weekIndex = Number(sortBy.slice(WEEK_SORT_PREFIX.length));
    const points = row.weekly_points[weekIndex];
    return points == null ? -Infinity : points;
  }
  if (sortBy === "projected") return row.contest_points;
  return row[sortBy];
}

const STATUS_LABEL = {
  final: "Final",
  in_progress: "In Progress",
  upcoming: "Upcoming",
};
const STATUS_BADGE_CLASS = {
  final: "win",
  in_progress: "tie",
  upcoming: "bye",
};

// Simple original icons evoking each cup (not reproductions of Nintendo's
// artwork/trademarks) so each contest panel is visually distinct at a glance.
function MushroomIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 11a10 6 0 0 1 20 0Z" fill="#ff6b6b" />
      <circle cx="8" cy="8.5" r="1.4" fill="#fff" />
      <circle cx="14" cy="7" r="1.1" fill="#fff" />
      <circle cx="17.5" cy="10" r="1" fill="#fff" />
      <rect x="8.5" y="11" width="7" height="8" rx="3" fill="#f2e9d8" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.7 6.2 6.6.6-5 4.5 1.5 6.6L12 16.9l-5.8 3.5 1.5-6.6-5-4.5 6.6-.6Z"
        fill="#f0d84a"
      />
    </svg>
  );
}

const CUP_ICONS = {
  "Mushroom Cup": MushroomIcon,
  "Flower Cup": "\u{1F337}", // tulip
  "Star Cup": StarIcon,
  "Special Cup": "\u{1F451}", // crown
};

// Movement vs. this cup's previous played week (see the contests API route
// for how it's computed -- always against the placement-points rank,
// regardless of whether the "Sort by" toggle below currently has fantasy
// points selected instead). Nothing renders for a team that held its
// spot, or before a second week has been played in this cup.
function RankDelta({ delta }) {
  if (!delta) return null;
  const up = delta > 0;
  const magnitude = Math.abs(delta);
  return (
    <span
      title={`${up ? "Up" : "Down"} ${magnitude} spot${magnitude === 1 ? "" : "s"} vs last week`}
      style={{
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 700,
        color: up ? "var(--win)" : "var(--loss)",
        whiteSpace: "nowrap",
      }}
    >
      {up ? "▲" : "▼"}
      {magnitude}
    </span>
  );
}

function ContestPanel({ contest, league, season, logos }) {
  // This cup's league-configured default mode (see api/contests/route.js's
  // defaultModeForCup) -- what the Mode toggle opens on, and what "Reset to
  // Default" switches back to regardless of whichever mode is currently
  // selected.
  const defaultMode = contest.defaultMode === "doubleDash" ? "doubleDash" : "solo";

  // Which ranking to show: Solo (each team ranked individually every week)
  // or Double Dash (that week's real head-to-head matchup pairs combine
  // scores and get ranked as a pair -- see the contests API route for the
  // full scoring rules). Independent of the Sort by toggle below, which
  // only changes display order within whichever mode is selected. Opens on
  // this cup's league-configured default mode rather than always Solo.
  const [mode, setMode] = useState(defaultMode);
  // A cup that hasn't started yet has an empty real leaderboard (no weeks
  // played) -- opening it on the normal "Total" sort would just show the
  // "No games played in this window yet" empty state despite this cup
  // having a full slate of projections available (that's exactly why it's
  // visible at all now -- see startedContests' filter above). Opening
  // straight on "Projected Finish" instead means there's actually something
  // to look at the moment this panel appears. A cup already under way (or
  // finished) keeps opening on the real "Total" sort, unchanged.
  const defaultSortBy = contest.status === "upcoming" ? "projected" : "contest_points";
  // Descending only, per spec -- just which column, not direction.
  const [sortBy, setSortBy] = useState(defaultSortBy);
  const [view, setView] = useState("table");
  // Clicking a team's name in the chart legend narrows the chart to just
  // that team's line; clicking it again, or clicking anywhere else in the
  // chart, clears it back to showing everyone.
  const [selectedTeam, setSelectedTeam] = useState(null);
  // The scoring badge's `title` attribute shows the point distribution on
  // desktop hover, but touch devices have no hover state -- a tap just
  // fires a click with no way to see a native title tooltip first. This
  // mirrors that same content in a tap-to-open popover instead: tapping the
  // badge toggles it open, and a document-wide click closes it again
  // (see the effect below), so tapping anywhere else -- another badge, the
  // Mode buttons, the table -- dismisses it the same way a real tooltip
  // would on mouseout.
  const [scoringTooltipOpen, setScoringTooltipOpen] = useState(false);

  useEffect(() => {
    if (!scoringTooltipOpen) return undefined;
    function closeTooltip() {
      setScoringTooltipOpen(false);
    }
    document.addEventListener("click", closeTooltip);
    return () => document.removeEventListener("click", closeTooltip);
  }, [scoringTooltipOpen]);

  // "Projected Finish" swaps the whole leaderboard source rather than just
  // changing sort order within the real one -- it's the same cup, same
  // scoring, but with any week beyond whichever one is live/decided filled
  // in from that platform's own projections instead of left blank (see
  // api/contests/route.js's projectedLeaderboard/projectedDoubleDashLeaderboard).
  // Falls back to [] defensively; the API always returns an array here
  // (possibly empty, e.g. a not-yet-migrated DB or a cup with no projection
  // data yet), never undefined.
  const modeLeaderboard =
    sortBy === "projected"
      ? (mode === "solo" ? contest.projectedLeaderboard : contest.projectedDoubleDashLeaderboard) || []
      : mode === "solo"
        ? contest.leaderboard
        : contest.doubleDashLeaderboard;

  // Already showing exactly what the league configured, plus the plain
  // "Total" sort and table view every cup opens on -- so there'd be
  // nothing for "Reset to Default" to do. Used to disable that button
  // rather than let it be a no-op click.
  const isAtDefault = mode === defaultMode && sortBy === defaultSortBy && view === "table";

  // Restores this cup's entire display to how it looked before any of
  // these were touched: the mode (Solo vs Double Dash), the Sort by
  // column, and the Table/Chart view. Scoring itself is no longer a
  // per-viewer setting (see the removed "Change Point System" feature) --
  // it's whatever the league commissioner configured for this season in
  // Manage Leagues (see api/contests/route.js), so there's nothing left
  // for this button to reset on that front.
  function resetToDefault() {
    setMode(defaultMode);
    setSortBy(defaultSortBy);
    setView("table");
  }

  const sortedLeaderboard = useMemo(() => {
    const rows = [...modeLeaderboard].sort((a, b) => sortValueFor(b, sortBy) - sortValueFor(a, sortBy));
    return rows.map((row, i) => ({ ...row, displayRank: i + 1 }));
  }, [modeLeaderboard, sortBy]);

  // One point per week, each team's *cumulative* placement points through
  // that week -- running total, not that week's placement alone (which is
  // what the table's Wk columns already show). A team's line stops at the
  // last week it actually has placement points for, rather than drawing a
  // flat line through weeks that haven't been played yet in this cup.
  const chartData = useMemo(() => {
    const running = new Map(); // team -> running total so far
    return contest.weeks.map((wk, i) => {
      const point = { week: wk };
      for (const row of modeLeaderboard) {
        const weekPoints = row.weekly_points[i];
        if (weekPoints == null) continue; // not played yet -- leave this team out of this week's point
        const total = (running.get(row.team) || 0) + weekPoints;
        running.set(row.team, total);
        point[row.team] = total;
      }
      return point;
    });
  }, [modeLeaderboard, contest.weeks]);

  // Colors keyed off alphabetical team order -- same convention the
  // Standings trend chart uses (see pivotWeekly in standings/page.js) --
  // so a given team gets the same color there and on every cup's chart
  // here, rather than each cup assigning colors off its own current
  // rank order (which would drift cup to cup, and from Standings, as
  // relative standings shift).
  const sortedTeams = useMemo(
    () => modeLeaderboard.map((row) => row.team).sort(),
    [modeLeaderboard]
  );

  // event is the underlying MouseEvent for both Legend's and Line's onClick
  // (Recharts passes it as the 3rd argument either way) -- stopping it from
  // bubbling is what keeps selecting a team from immediately re-triggering
  // the chart wrapper's own onClick, which is what clears the selection.
  function selectTeam(team, event) {
    event?.stopPropagation();
    setSelectedTeam((prev) => (prev === team ? null : team));
  }

  // Built from the full leaderboard, not whichever teams currently have a
  // rendered Line -- otherwise the legend would shrink down to just the
  // selected team once isolated, and there'd be no way to click over to a
  // different team without resetting first.
  const legendPayload = modeLeaderboard.map((row) => ({
    value: row.team,
    type: "line",
    color: COLORS[sortedTeams.indexOf(row.team) % COLORS.length],
  }));
  const visibleRows = selectedTeam
    ? modeLeaderboard.filter((row) => row.team === selectedTeam)
    : modeLeaderboard;

  const Icon = CUP_ICONS[contest.name];
  // This cup's league-configured default scoring, always shown regardless
  // of whichever mode the Mode toggle currently has selected -- tells a
  // viewer what "Reset to Default" above brings the view back to. Hovering
  // /tapping the badge (or either Mode button below) reveals the full
  // placement table for that mode.
  const defaultModeLabel = defaultMode === "doubleDash" ? "Double Dash" : "Solo";
  const defaultModeTable = contest.defaultPointTable[defaultMode];
  const soloPointsTooltip = pointDistributionTooltip(contest.defaultPointTable.solo);
  const doubleDashPointsTooltip = pointDistributionTooltip(contest.defaultPointTable.doubleDash);

  return (
    <div className="panel">
      <h2 style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {typeof Icon === "string" ? (
          <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden="true">{Icon}</span>
        ) : (
          Icon && <Icon />
        )}
        {contest.name} (Weeks {contest.start_week}-{contest.end_week}){" "}
        <span className={`badge ${STATUS_BADGE_CLASS[contest.status]}`}>{STATUS_LABEL[contest.status]}</span>
        <span
          className="badge scoring"
          style={{ position: "relative" }}
          title={`Weekly placement points\n${pointDistributionTooltip(defaultModeTable)}`}
          onClick={(e) => {
            // Stops this same click from immediately reaching the
            // document-level listener that closes an already-open
            // tooltip -- without it, opening one would also instantly
            // close it in the same tap.
            e.stopPropagation();
            setScoringTooltipOpen((v) => !v);
          }}
        >
          {defaultModeLabel}
          {scoringTooltipOpen && (
            <span
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 6,
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12,
                fontWeight: 400,
                textTransform: "none",
                letterSpacing: "normal",
                color: "var(--text)",
                whiteSpace: "nowrap",
                textAlign: "left",
                boxShadow: "0 6px 16px rgba(0,0,0,0.3)",
                zIndex: 20,
                cursor: "default",
              }}
            >
              <strong style={{ display: "block", marginBottom: 4 }}>Weekly placement points</strong>
              {defaultModeTable.map((pts, i) => (
                <div key={i}>
                  {ordinal(i + 1)}: {pts}
                </div>
              ))}
            </span>
          )}
        </span>
      </h2>

      {/* Two independent toggle groups (Sort by, then Mode) laid out on a
          shared grid -- see .toggle-grid in globals.css. Wide enough
          screens get both groups on one row; narrow/mobile drops to a
          two-column grid, which stacks Mode under Sort by while still
          keeping both labels the same width and both button groups
          starting at the same x, instead of each row being staggered by
          its own label's length. */}
      <div className="toggle-grid" style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Sort by:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${sortBy === "contest_points" ? " selected" : ""}`}
            onClick={() => setSortBy("contest_points")}
          >
            Total
          </button>
          <button
            type="button"
            className={`week-chip${sortBy === "fantasy_points" ? " selected" : ""}`}
            onClick={() => setSortBy("fantasy_points")}
          >
            Fantasy Points (ref)
          </button>
          <button
            type="button"
            className={`week-chip${sortBy === "projected" ? " selected" : ""}`}
            onClick={() => setSortBy("projected")}
            title="Actual points for weeks already played, plus this platform's own projection for every week still to come in this cup."
          >
            Projected Finish
          </button>
        </div>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Mode:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${mode === "solo" ? " selected" : ""}`}
            onClick={() => setMode("solo")}
            title={`Weekly placement points\n${soloPointsTooltip}`}
          >
            Solo
          </button>
          <button
            type="button"
            className={`week-chip${mode === "doubleDash" ? " selected" : ""}`}
            onClick={() => setMode("doubleDash")}
            title={`This week's actual matchup pairs combine scores and get ranked as a pair -- both teammates score the same placement points.\n\nWeekly placement points\n${doubleDashPointsTooltip}`}
          >
            Double Dash
          </button>
        </div>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>View:</span>
        <div className="toggle-grid-buttons">
          <button
            type="button"
            className={`week-chip${view === "table" ? " selected" : ""}`}
            onClick={() => setView("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={`week-chip${view === "chart" ? " selected" : ""}`}
            onClick={() => setView("chart")}
          >
            Chart
          </button>
        </div>
      </div>

      {/* Scoring itself is no longer a per-viewer setting -- it's whatever
          the league commissioner configured in Manage Leagues (see
          api/contests/route.js). This button just resets the display: Mode
          back to this cup's default, Sort by back to Total, and view back
          to Table -- disabled once all three already match. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <button
          type="button"
          className="week-chip"
          onClick={resetToDefault}
          disabled={isAtDefault}
          title={isAtDefault ? "Already showing the league default" : undefined}
        >
          Reset to Default
        </button>
      </div>

      {view === "table" ? (
        <div className="table-scroll">
          <table className="contests-table">
            <thead>
              <tr>
                {/* No label -- the cells below already read "1st", "2nd",
                    etc., so a "Rank" header would only add width the
                    column doesn't otherwise need (this matters most on
                    narrow/mobile screens). aria-label keeps it named for
                    screen readers despite the empty visual header. */}
                <th aria-label="Rank" />
                <th className="sticky-col">Team</th>
                {/* Clicking/tapping a week column sorts the table by that
                    week's placement points (see sortValueFor above) --
                    same descending-only behavior as the Sort by toggle
                    above the table, just scoped to one week instead of the
                    season-to-date total. aria-sort marks the active column
                    for assistive tech; there's no ascending state to cycle
                    through (per spec, sorting here is always descending). */}
                {contest.weeks.map((wk, i) => {
                  const thisWeekSortKey = weekSortKey(i);
                  const isSorted = sortBy === thisWeekSortKey;
                  const liveNote =
                    wk === contest.liveWeek ? "Game in progress -- scores still updating. " : "";
                  return (
                    <th
                      key={wk}
                      onClick={() => setSortBy(thisWeekSortKey)}
                      className={`sortable-th${isSorted ? " sorted" : ""}`}
                      aria-sort={isSorted ? "descending" : undefined}
                      title={`${liveNote}Click/tap to sort by this week's points.`}
                    >
                      Wk {wk}
                      {wk === contest.liveWeek && (
                        <span className="badge tie" style={{ marginLeft: 4 }}>
                          LIVE
                        </span>
                      )}
                    </th>
                  );
                })}
                <th>Total</th>
                <th title="Fantasy Points (ref)">PF</th>
              </tr>
            </thead>
            <tbody>
              {sortedLeaderboard.map((row) => (
                <tr key={row.team} style={row.displayRank === 1 ? { fontWeight: 700 } : undefined}>
                  <td>{ordinal(row.displayRank)}</td>
                  <td className="sticky-col">
                    <span
                      className="wrap-cell"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}
                    >
                      <TeamLogo src={logos?.[row.team]} />
                      {row.team}
                    </span>
                    <RankDelta delta={row.rankDelta} />
                    {row.displayRank === 1 && (
                      <span className="badge win" style={{ marginLeft: 6 }}>
                        Leader
                      </span>
                    )}
                  </td>
                  {row.weekly_points.map((pts, i) => (
                    <td key={contest.weeks[i]}>{pts ?? "—"}</td>
                  ))}
                  <td style={sortBy === "contest_points" ? { fontWeight: 700 } : undefined}>{row.contest_points}</td>
                  <td style={sortBy === "fantasy_points" ? { fontWeight: 700 } : undefined}>{row.fantasy_points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {selectedTeam && (
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 8px" }}>
              Showing trend for <strong style={{ color: "var(--text)" }}>{selectedTeam}</strong> -- click
              elsewhere on the chart to show everyone again.
            </p>
          )}
          {/* Clicking anywhere in here that isn't a legend entry or line
              (both stop propagation in their own onClick) clears the
              selection -- CartesianGrid, empty plot area, the container
              padding, all of it. */}
          <div onClick={() => setSelectedTeam(null)}>
            <ResponsiveContainer width="100%" height={Math.max(320, modeLeaderboard.length * 24 + 200)}>
              {/* Extra right margin makes room for each line's end-of-line
                  team logo (see ChartTeamLogoDot), drawn just past the last
                  plotted point rather than on top of it. */}
              <LineChart data={chartData} margin={{ top: 10, right: 44, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="var(--border)" />
                <XAxis
                  dataKey="week"
                  stroke="var(--text-dim)"
                  label={{ value: "Week", position: "insideBottom", offset: -5, fill: "var(--text-dim)" }}
                />
                <YAxis
                  stroke="var(--text-dim)"
                  label={{
                    value: "Cumulative points",
                    angle: -90,
                    position: "insideLeft",
                    fill: "var(--text-dim)",
                  }}
                />
                <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)" }} />
                <Legend
                  payload={legendPayload}
                  onClick={(entry, index, event) => selectTeam(entry.value, event)}
                  wrapperStyle={{ cursor: "pointer", paddingTop: 16 }}
                />
                {visibleRows.map((row) => {
                  const lastIdx = lastValidRowIndex(chartData, row.team);
                  const clipId = `logo-clip-${slugForId(contest.name)}-${slugForId(row.team)}`;
                  return (
                    <Line
                      key={row.team}
                      type="linear"
                      dataKey={row.team}
                      stroke={COLORS[sortedTeams.indexOf(row.team) % COLORS.length]}
                      strokeWidth={2}
                      dot={(dotProps) =>
                        dotProps.index === lastIdx ? (
                          <ChartTeamLogoDot
                            key={clipId}
                            cx={dotProps.cx}
                            cy={dotProps.cy}
                            src={logos?.[row.team]}
                            clipId={clipId}
                          />
                        ) : null
                      }
                      connectNulls={false}
                      onClick={(_, __, event) => selectTeam(row.team, event)}
                      style={{ cursor: "pointer" }}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      {sortedLeaderboard.length === 0 && <div className="empty-state">No games played in this window yet.</div>}
    </div>
  );
}

function ContestsInner() {
  const [league, setLeague] = useUrlState("league");
  const [season, setSeason] = useUrlState("season");
  // 15-week (legacy) vs 16-week (current league policy) cup structure --
  // independent of season, and persisted the same way league/season are:
  // a URL param carried across page navigation by Nav.js, so it survives
  // both a refresh and clicking away to another page and back. Absent from
  // the URL until explicitly changed; defaults to "16" (see
  // api/contests/route.js's CUP_WEEK_SETS) both here and server-side.
  const [cupWeeksParam, setCupWeeks] = useUrlState("cupWeeks");
  const activeCupWeeks = cupWeeksParam === "15" ? "15" : "16";

  const { data: meta } = useJson(`/api/meta${league ? `?league=${encodeURIComponent(league)}` : ""}`);
  const seasons = meta?.seasons || [];
  const activeSeason = season || seasons[0];
  const activeLeague = league || meta?.league;

  const { data, loading, error } = useJson(
    activeSeason && activeLeague
      ? `/api/contests?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}&cupWeeks=${activeCupWeeks}`
      : null
  );

  const { data: logoData } = useJson(
    activeSeason && activeLeague
      ? `/api/team-logos?season=${activeSeason}&league=${encodeURIComponent(activeLeague)}`
      : null
  );
  const logos = logoData?.logos;

  // Cups come back in chronological order (Mushroom -> Flower -> Star ->
  // Special), which is right for the weeks *within* a cup but backwards for
  // which cup you want to see first: the one currently being played, or
  // the last one that finished once the season's over. Reverse the order
  // and drop anything that hasn't started AND has no projections either --
  // a genuinely empty "upcoming" cup (no real data, no projections yet)
  // still has nothing to show, and would otherwise sit at the top (since
  // it's chronologically last) pushing the cup people actually care about
  // down the page. But an "upcoming" cup that already has a full slate of
  // projected_matchups (see api/contests/route.js's projectedLeaderboard)
  // is exactly the case "Projected Finish" exists for -- seeing the whole
  // rest of the season's cups projected out, not just the one currently in
  // progress -- so it stays visible (opening straight on Projected Finish;
  // see ContestPanel's defaultSortBy). As the season progresses, each
  // newly-started cup takes over the top spot the same way as before.
  const startedContests = useMemo(
    () =>
      (data?.contests || [])
        .filter(
          (c) =>
            c.status !== "upcoming" ||
            c.projectedLeaderboard?.length > 0 ||
            c.projectedDoubleDashLeaderboard?.length > 0
        )
        .reverse(),
    [data]
  );

  return (
    <>
      <div className="controls">
        <LeagueSelect
          leagues={meta?.leagues}
          league={activeLeague}
          onChange={(next) => setLeague(next, { clear: ["season"] })}
        />
        <SeasonSelect seasons={seasons} season={activeSeason} onChange={setSeason} />
        <CupWeeksSelect value={activeCupWeeks} onChange={setCupWeeks} />
      </div>

      <h1 style={{ fontSize: 20, margin: "0 0 20px" }}>
        {data?.leagueName ? `${data.leagueName} Grand Prix` : "Grand Prix"}
      </h1>

      {loading && <div className="loading-state">Loading contests...</div>}
      {error && <div className="error-state">{error}</div>}

      {data && data.contests.length === 0 && (
        <div className="panel">
          <div className="empty-state">
            No contest windows are configured for this season yet. Add a "contests" section for{" "}
            {activeSeason} in config.json and rerun the pipeline.
          </div>
        </div>
      )}

      {data && data.contests.length > 0 && startedContests.length === 0 && (
        <div className="panel">
          <div className="empty-state">
            No cups have started yet this season -- check back once the first week wraps up.
          </div>
        </div>
      )}

      {startedContests.map((contest) => (
        <ContestPanel
          key={contest.name}
          contest={contest}
          league={activeLeague}
          season={activeSeason}
          logos={logos}
        />
      ))}
    </>
  );
}

export default function ContestsPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading...</div>}>
      <ContestsInner />
    </Suspense>
  );
}
