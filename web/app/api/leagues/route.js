import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { normalizeCupWeeks, normalizeScoringConfig } from "@/lib/scoring";

// Self-service "add a league". This site has no login, so the two
// platforms are handled very differently:
//
// - Sleeper: fully open. Its API is public read-only and needs no
//   credentials at all, so there's nothing sensitive being accepted from
//   an anonymous visitor.
// - ESPN: needs real espn_s2/SWID cookies, which IS sensitive -- an open
//   form would let anyone who finds the URL submit (and overwrite)
//   credentials that get stored and used by the automated pipeline. Gated
//   behind a shared passphrase (ADD_LEAGUE_PASSPHRASE env var) as a
//   deliberately lightweight speed bump, not real auth. If that env var
//   isn't set at all, the ESPN path is disabled outright rather than
//   silently accepting any passphrase.
//
// Either way, this route only registers the league (writes one row to
// `leagues`) -- it doesn't pull any data itself. The next scheduled
// pipeline run (or a manually triggered one) picks up anything registered
// here that config.json doesn't already cover and pulls it (see
// pipeline.py's docstring).
//
// Both platforms also accept the same two optional Grand Prix defaults,
// set from the "Grand Prix settings" picker on the Add League form (see
// web/lib/scoring.js for the JSON shape/resolution rules, and
// web/app/leagues/new/page.js for the UI): `cupWeeks` (15 or 16, defaults to
// 16) and `scoringConfig` (this league's default placement->points scoring
// per cup, defaults to plain Solo with no overrides). Both are also
// editable later via PATCH /api/leagues/<slug> (see that route's own
// comment) -- registering a league doesn't lock them in forever.
//
// POST /api/leagues
//   Sleeper: { platform: "sleeper", sleeperLeagueId, displayName?, cupWeeks?, scoringConfig? }
//   ESPN:    { platform: "espn", espnLeagueId, espnS2?, espnSwid?, years?, displayName?, passphrase, cupWeeks?, scoringConfig? }

function slugify(base) {
  return base
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Reserves a slug, reusing an existing one if it already belongs to this
// same external league (so resubmitting the form updates in place instead
// of minting duplicates).
async function reserveSlug(baseSlug, matchesExisting) {
  let slug = baseSlug;
  for (let i = 2; i < 50; i++) {
    const existing = await query("SELECT * FROM leagues WHERE slug = ?", [slug]);
    if (existing.length === 0 || matchesExisting(existing[0])) break;
    slug = `${baseSlug}-${i}`;
  }
  return slug;
}

// Registers/updates a league row, tolerating a not-yet-migrated DB that
// lacks the cup_weeks/scoring_config columns (added well after this table
// first shipped -- see db.py's COLUMN_MIGRATIONS). Those columns only exist
// once the Python pipeline has reconnected at least once since they were
// added; until then, this falls back to the pre-existing INSERT shape
// rather than 500ing on every new league registration in the meantime --
// the Grand Prix defaults just don't stick yet, and can be set again later
// via Manage Leagues once the pipeline has caught up.
async function upsertLeague({ platform, slug, displayName, sleeperLeagueId, espnFields, cupWeeks, scoringConfig }) {
  const isEspn = platform === "espn";
  const baseCols = isEspn
    ? ["platform", "slug", "display_name", "espn_league_id", "espn_s2", "espn_swid", "pull_years"]
    : ["platform", "slug", "display_name", "sleeper_league_id"];
  const baseVals = isEspn
    ? ["espn", slug, displayName, espnFields.espnLeagueId, espnFields.espnS2, espnFields.espnSwid, espnFields.pullYearsJson]
    : ["sleeper", slug, displayName, sleeperLeagueId];
  const baseUpdates = isEspn
    ? "display_name = excluded.display_name, espn_league_id = excluded.espn_league_id, espn_s2 = excluded.espn_s2, espn_swid = excluded.espn_swid, pull_years = excluded.pull_years"
    : "display_name = excluded.display_name, sleeper_league_id = excluded.sleeper_league_id";

  try {
    await query(
      `INSERT INTO leagues (${baseCols.join(", ")}, cup_weeks, scoring_config)
       VALUES (${baseCols.map(() => "?").join(", ")}, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET ${baseUpdates}, cup_weeks = excluded.cup_weeks, scoring_config = excluded.scoring_config`,
      [...baseVals, cupWeeks, JSON.stringify(scoringConfig)]
    );
    return true;
  } catch (err) {
    console.error("Insert with cup_weeks/scoring_config failed, falling back (DB likely not yet migrated):", err);
    await query(
      `INSERT INTO leagues (${baseCols.join(", ")})
       VALUES (${baseCols.map(() => "?").join(", ")})
       ON CONFLICT(slug) DO UPDATE SET ${baseUpdates}`,
      baseVals
    );
    return false;
  }
}

function passphraseOk(submitted) {
  const expected = process.env.ADD_LEAGUE_PASSPHRASE;
  if (!expected) return false; // not configured -- ESPN self-service is disabled
  const a = Buffer.from(String(submitted ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
  return timingSafeEqual(a, b);
}

// "2024,2025" or "2024-2026" (or a mix: "2023,2025-2026") -> [2024,2025,...].
function parseYears(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const years = new Set();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (range) {
      const [, start, end] = range;
      for (let y = Number(start); y <= Number(end); y++) years.add(y);
    } else if (/^\d{4}$/.test(trimmed)) {
      years.add(Number(trimmed));
    }
  }
  return [...years].sort();
}

async function handleSleeper(body) {
  const sleeperLeagueId = typeof body?.sleeperLeagueId === "string" ? body.sleeperLeagueId.trim() : "";
  const requestedDisplayName =
    typeof body?.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null;

  if (!sleeperLeagueId) {
    return Response.json({ error: "sleeperLeagueId is required" }, { status: 400 });
  }
  if (!/^\d+$/.test(sleeperLeagueId)) {
    return Response.json(
      { error: "That doesn't look like a Sleeper league ID (should be all digits)." },
      { status: 400 }
    );
  }

  let sleeperLeague;
  try {
    const resp = await fetch(`https://api.sleeper.app/v1/league/${encodeURIComponent(sleeperLeagueId)}`);
    if (!resp.ok) throw new Error("not found");
    sleeperLeague = await resp.json();
    if (!sleeperLeague || sleeperLeague.sport !== "nfl") throw new Error("not an NFL league");
  } catch {
    return Response.json(
      { error: "Couldn't find an NFL league on Sleeper with that ID. Double-check it and try again." },
      { status: 400 }
    );
  }

  const displayName = requestedDisplayName || sleeperLeague.name || null;
  const baseSlug = slugify(displayName || `sleeper-${sleeperLeagueId}`) || `sleeper-${sleeperLeagueId}`;
  const slug = await reserveSlug(baseSlug, (row) => row.sleeper_league_id === sleeperLeagueId);
  const cupWeeks = normalizeCupWeeks(body?.cupWeeks);
  const scoringConfig = normalizeScoringConfig(body?.scoringConfig);

  await upsertLeague({ platform: "sleeper", slug, displayName, sleeperLeagueId, cupWeeks, scoringConfig });

  return Response.json({ slug, displayName: displayName || slug, cupWeeks, scoringConfig });
}

async function handleEspn(body) {
  if (!passphraseOk(body?.passphrase)) {
    return Response.json(
      { error: "Incorrect passphrase, or ESPN self-service isn't enabled on this deployment." },
      { status: 401 }
    );
  }

  const espnLeagueId = typeof body?.espnLeagueId === "string" ? body.espnLeagueId.trim() : "";
  const espnS2 = typeof body?.espnS2 === "string" ? body.espnS2.trim() : "";
  const espnSwid = typeof body?.espnSwid === "string" ? body.espnSwid.trim() : "";
  const requestedDisplayName =
    typeof body?.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null;

  if (!espnLeagueId || !/^\d+$/.test(espnLeagueId)) {
    return Response.json({ error: "A numeric ESPN league ID is required." }, { status: 400 });
  }

  const years = parseYears(body?.years);
  const pullYears = years.length ? years : [new Date().getFullYear()];

  // Validate the league id/cookies against ESPN's real API before storing
  // anything -- catches a wrong id or expired/incorrect cookies up front
  // instead of failing silently on the next pipeline run. Uses the most
  // recent requested year (or this year) to check against.
  const checkYear = pullYears[pullYears.length - 1];
  const cookieHeader = [espnS2 && `espn_s2=${espnS2}`, espnSwid && `SWID=${espnSwid}`].filter(Boolean).join("; ");
  let espnLeagueName = null;
  try {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${checkYear}/segments/0/leagues/${espnLeagueId}?view=mSettings`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    });
    if (!resp.ok) throw new Error("not found");
    const data = await resp.json();
    espnLeagueName = data?.settings?.name ?? null;
  } catch {
    return Response.json(
      {
        error:
          "Couldn't reach that ESPN league for the requested year(s). Check the league ID and, for a " +
          "private league, that the espn_s2/SWID cookies are current (they expire periodically).",
      },
      { status: 400 }
    );
  }

  const displayName = requestedDisplayName || espnLeagueName || null;
  const baseSlug = slugify(displayName || `espn-${espnLeagueId}`) || `espn-${espnLeagueId}`;
  const slug = await reserveSlug(baseSlug, (row) => String(row.espn_league_id) === espnLeagueId);
  const cupWeeks = normalizeCupWeeks(body?.cupWeeks);
  const scoringConfig = normalizeScoringConfig(body?.scoringConfig);

  await upsertLeague({
    platform: "espn",
    slug,
    displayName,
    espnFields: {
      espnLeagueId: Number(espnLeagueId),
      espnS2: espnS2 || null,
      espnSwid: espnSwid || null,
      pullYearsJson: JSON.stringify(pullYears),
    },
    cupWeeks,
    scoringConfig,
  });

  return Response.json({ slug, displayName: displayName || slug, years: pullYears, cupWeeks, scoringConfig });
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  try {
    if (body?.platform === "espn") {
      return await handleEspn(body);
    }
    return await handleSleeper(body);
  } catch (err) {
    // Anything unhandled below (most commonly: the database isn't reachable
    // yet, or is missing a column this route expects -- see the comment on
    // db.py's COLUMN_MIGRATIONS, which only gets applied when the Python
    // pipeline connects, not by this route) would otherwise surface as a
    // bare 500 with no JSON body, which the form can only report as a
    // generic "Request failed". Surface the real reason instead.
    console.error("POST /api/leagues failed:", err);
    return Response.json(
      { error: `Something went wrong registering the league: ${err.message || err}` },
      { status: 500 }
    );
  }
}

// GET tells the form whether the ESPN path is even enabled on this
// deployment, so it can hide/disable those fields instead of letting
// someone fill out a form that can only ever 401. Also returns the current
// league list (including each one's Grand Prix defaults, so Manage
// Leagues' "Edit Scoring" action can prefill the same picker the Add League
// form uses), so the "Manage Leagues" section on the same page can list
// rename/delete/edit-scoring controls without a second round trip to
// /api/meta.
export async function GET() {
  // Tries the full column list first; falls back to the pre-existing
  // (narrower) SELECT if cup_weeks/scoring_config don't exist yet on this
  // DB (see upsertLeague's comment above) -- a not-yet-migrated DB should
  // still list leagues normally for rename/delete, just without scoring
  // defaults to prefill, rather than breaking the whole Manage Leagues
  // section outright.
  let leagues = await query(
    "SELECT slug, display_name AS displayName, platform, cup_weeks AS cupWeeks, scoring_config AS scoringConfigRaw FROM leagues ORDER BY slug"
  ).catch(() => null);
  if (leagues === null) {
    leagues = await query("SELECT slug, display_name AS displayName, platform FROM leagues ORDER BY slug").catch(
      () => [] // tolerate a not-yet-migrated DB that lacks the leagues table entirely
    );
  }
  leagues = leagues.map((l) => {
    let scoringConfig = null;
    try {
      scoringConfig = l.scoringConfigRaw ? JSON.parse(l.scoringConfigRaw) : null;
    } catch {
      scoringConfig = null;
    }
    return {
      slug: l.slug,
      displayName: l.displayName,
      platform: l.platform,
      cupWeeks: normalizeCupWeeks(l.cupWeeks),
      scoringConfig,
    };
  });

  return Response.json({
    espnEnabled: Boolean(process.env.ADD_LEAGUE_PASSPHRASE),
    deleteEnabled: Boolean(process.env.ADD_LEAGUE_PASSPHRASE),
    leagues,
  });
}
