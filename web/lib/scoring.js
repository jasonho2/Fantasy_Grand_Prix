// Shared Grand Prix scoring helpers -- used by both the server (api/contests,
// api/leagues) and the client (the Contests page's "Change Point System"
// editor, and the Add League / Manage Leagues scoring picker). Centralized
// here so there's exactly one place these default numbers and the
// blank-means-default resolution rules live, instead of api/contests/route.js
// and contests/page.js each keeping their own copy in sync by hand.
//
// A league's configured Grand Prix defaults ("scoring_config" in the
// `leagues` table, stored as JSON) come in one of two shapes:
//
//   Uniform (same format for all 4 cups):
//     { uniform: true, mode: "solo" | "doubleDash", pointTable: [...] | null }
//
//   Per-cup (different format per cup):
//     { uniform: false, cups: [ {mode, pointTable}, x4, one per CUP_NAMES slot ] }
//
// `pointTable`, when present, is a *sparse* array the same length as
// DEFAULT_POINT_TABLES[mode] -- a null/blank slot means "use the built-in
// default for that placement," not zero (see resolvePointTable). It only
// ever overrides the placement table for `mode` itself; the other mode (the
// one not chosen as this cup's default) always uses the plain built-in
// default -- there's no way to configure a league default for a mode viewers
// aren't expected to look at.

export const DEFAULT_POINT_TABLES = {
  solo: [12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  doubleDash: [12, 10, 9, 8, 7, 5],
};

// Chronological order -- matches CUP_WEEK_SETS in api/contests/route.js and
// the order cups are configured in config.json's contest_windows. A league's
// per-cup scoring config is positional against this same order.
export const CUP_NAMES = ["Mushroom Cup", "Flower Cup", "Star Cup", "Special Cup"];

// Mario Kart: Double Dash!! track order within each cup -- race N of a cup
// (its Nth week) takes the Nth track. Same mapping the weekly recap
// automation uses for its titles, so the Contests table's per-week titles
// line up with the recap for that week. A cup configured longer than 4
// weeks just has no track name for the extra races (callers fall back to
// "Race N").
export const CUP_TRACKS = {
  "Mushroom Cup": ["Luigi Circuit", "Peach Beach", "Baby Park", "Dry Dry Desert"],
  "Flower Cup": ["Mushroom Bridge", "Mario Circuit", "Daisy Cruiser", "Waluigi Stadium"],
  "Star Cup": ["Sherbet Land", "Mushroom City", "Yoshi Circuit", "DK Mountain"],
  "Special Cup": ["Wario Colosseum", "Dino Dino Jungle", "Bowser's Castle", "Rainbow Road"],
};

export const DEFAULT_CUP_WEEKS = 16;

export function ordinal(n) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

// Points awarded for a given weekly placement (1st, 2nd, ...) under a fully-
// resolved (no blanks) table -- placements beyond the table's length score 0
// (a league with fewer teams than the table has slots for never hits this).
export function placementPointsFor(rank, table) {
  if (rank == null) return null;
  const idx = rank - 1;
  return idx < table.length ? table[idx] : 0;
}

// Resolves a *sparse* override table (values possibly "", null, undefined,
// or a non-numeric string, meaning "no override for this placement") against
// a fully-resolved `defaults` array of the same length, returning a fully-
// resolved array. Used both for a league's own configured default (against
// DEFAULT_POINT_TABLES[mode]) and for a viewer's personal override (against
// that league's resolved default) -- same blank-means-default rule either way.
export function pointsForRank(rank, table, defaults) {
  if (rank == null) return null;
  const idx = rank - 1;
  const override = table ? table[idx] : undefined;
  if (override !== undefined && override !== null && override !== "") {
    const n = Number(override);
    if (Number.isFinite(n)) return n;
  }
  return idx < defaults.length ? defaults[idx] : 0;
}

export function resolvePointTable(sparseTable, mode) {
  const defaults = DEFAULT_POINT_TABLES[mode];
  if (!Array.isArray(sparseTable)) return defaults;
  return defaults.map((def, i) => {
    const v = sparseTable[i];
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  });
}

// Reads a normalized scoring_config for one cup (0-3, chronological, see
// CUP_NAMES) -- always returns a usable { mode, pointTable } even when
// scoringConfig is null/malformed (falls back to plain Solo, no overrides).
export function cupScoringConfig(scoringConfig, cupIndex) {
  if (!scoringConfig || typeof scoringConfig !== "object") {
    return { mode: "solo", pointTable: null };
  }
  const raw = scoringConfig.uniform === false ? scoringConfig.cups?.[cupIndex] : scoringConfig;
  const mode = raw?.mode === "doubleDash" ? "doubleDash" : "solo";
  const pointTable = Array.isArray(raw?.pointTable) ? raw.pointTable : null;
  return { mode, pointTable };
}

// The default (fully-resolved) placement table a cup should use for a given
// mode. If that cup's configured default mode isn't `mode`, there's no
// league override for it -- always the plain built-in default in that case.
export function effectiveDefaultTable(scoringConfig, cupIndex, mode) {
  const cup = cupScoringConfig(scoringConfig, cupIndex);
  if (cup.mode !== mode) return DEFAULT_POINT_TABLES[mode];
  return resolvePointTable(cup.pointTable, mode);
}

export function defaultModeForCup(scoringConfig, cupIndex) {
  return cupScoringConfig(scoringConfig, cupIndex).mode;
}

// Sanitizes arbitrary client-submitted scoring config before it's stored as
// JSON -- clamps to the two known shapes, drops anything that isn't a
// finite number (or blank) from a point table, and always returns exactly 4
// per-cup entries in the per-cup shape so cupScoringConfig can index safely
// without ever seeing a shorter array. Returns a canonical, storage-ready
// object (never null) -- an all-blank/no-op submission still round-trips to
// { uniform: true, mode: "solo", pointTable: null }.
export function normalizeScoringConfig(raw) {
  function cleanCup(c) {
    const mode = c && c.mode === "doubleDash" ? "doubleDash" : "solo";
    let pointTable = null;
    if (c && Array.isArray(c.pointTable)) {
      const len = DEFAULT_POINT_TABLES[mode].length;
      const table = c.pointTable.slice(0, len).map((v) => {
        if (v === "" || v === null || v === undefined) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      });
      while (table.length < len) table.push(null);
      if (table.some((v) => v !== null)) pointTable = table;
    }
    return { mode, pointTable };
  }

  if (raw && raw.uniform === false) {
    const cupsIn = Array.isArray(raw.cups) ? raw.cups : [];
    return { uniform: false, cups: CUP_NAMES.map((_, i) => cleanCup(cupsIn[i])) };
  }
  return { uniform: true, ...cleanCup(raw) };
}

export function normalizeCupWeeks(raw) {
  return Number(raw) === 15 ? 15 : DEFAULT_CUP_WEEKS;
}
