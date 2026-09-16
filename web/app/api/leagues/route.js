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
// Both platforms also accept the same two optional Grand Prix defaults, set
// from the "Grand Prix settings" picker on the Add League form (see
// web/lib/scoring.js for the JSON shape/resolution rules, and
// web/app/leagues/new/page.js for the UI) -- both FOR THE INITIAL SEASON
// being registered, and both stored per-season on `league_seasons` (see
// db.py): `cupWeeks` (15 or 16, defaults to 16) and `scoringConfig` (this
// season's default placement->points scoring per cup, defaults to plain
// Solo with no overrides). Both are also editable later, per season, via
// PATCH /api/leagues/<slug> (see that route's own
// comment) -- registering a league doesn't lock them in forever, and later
// seasons get their own independent cup length and scoring config there
// too.
//
// Grand Prix settings are a commissioner-only decision, so submitting them
// (on EITHER platform) requires the same shared passphrase used everywhere
// else on this route/PATCH/DELETE (`passphrase` for ESPN's request as a
// whole; a separate `scoringPassphrase` field for Sleeper, since Sleeper
// registration itself must stay open -- see handleSleeper). Getting it wrong
// doesn't fail the registration -- it silently registers with plain
// defaults instead, and the response's `scoringSaved` flag reports whether
// the submitted settings actually took.
//
// `recapsEnabled` (optional boolean, default false) rides along with the
// same gating as cupWeeks/scoringConfig on both platforms -- opts this
// league into the automated weekly recap (see api/recaps/route.js and
// db.py's leagues.recaps_enabled comment). Unlike cupWeeks/scoringConfig,
// it's stored directly on `leagues`, not per-season on `league_seasons`,
// since it's a "does this league want this feature at all" toggle rather
// than something that legitimately varies year to year.
//
// POST /api/leagues
//   Sleeper: { platform: "sleeper", sleeperLeagueId, displayName?, cupWeeks?, scoringConfig?, recapsEnabled?, scoringPassphrase? }
//   ESPN:    { platform: "espn", espnLeagueId, espnS2?, espnSwid?, years?, displayName?, passphrase, cupWeeks?, scoringConfig?, recapsEnabled? }

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

// Registers/updates a league row. cup_weeks used to be set here too
// (league-wide) -- moved to upsertSeasonDefaults below, same as scoring,
// since cup length turned out to need to vary by season just like scoring
// does (see db.py's league_seasons.cup_weeks comment). Tolerates a
// not-yet-migrated DB missing a column this INSERT expects (e.g. pull_years
// on a very old DB) the same way it always has: falls back to the
// pre-existing INSERT shape rather than 500ing on every new league
// registration in the meantime.
async function upsertLeague({ platform, slug, displayName, sleeperLeagueId, espnFields, recapsEnabled }) {
  const isEspn = platform === "espn";
  const baseCols = isEspn
    ? ["platform", "slug", "display_name", "espn_league_id", "espn_s2", "espn_swid", "pull_years", "recaps_enabled"]
    : ["platform", "slug", "display_name", "sleeper_league_id", "recaps_enabled"];
  const baseVals = isEspn
    ? [
        "espn", slug, displayName, espnFields.espnLeagueId, espnFields.espnS2, espnFields.espnSwid,
        espnFields.pullYearsJson, recapsEnabled ? 1 : 0,
      ]
    : ["sleeper", slug, displayName, sleeperLeagueId, recapsEnabled ? 1 : 0];
  const baseUpdates = isEspn
    ? "display_name = excluded.display_name, espn_league_id = excluded.espn_league_id, espn_s2 = excluded.espn_s2, espn_swid = excluded.espn_swid, pull_years = excluded.pull_years, recaps_enabled = excluded.recaps_enabled"
    : "display_name = excluded.display_name, sleeper_league_id = excluded.sleeper_league_id, recaps_enabled = excluded.recaps_enabled";

  await query(
    `INSERT INTO leagues (${baseCols.join(", ")})
     VALUES (${baseCols.map(() => "?").join(", ")})
     ON CONFLICT(slug) DO UPDATE SET ${baseUpdates}`,
    baseVals
  );
}

// Upserts THIS season's Grand Prix defaults -- cup length AND scoring
// config together, into league_seasons (see db.py's league_seasons.
// cup_weeks/scoring_config comments for why both live per-season rather
// than per-league: a commissioner changing either for one season must
// never silently change a different season's Contests page too). Pre-
// inserts a partial row (just league_id + season + these two columns) when
// the pipeline hasn't created one for this season yet -- safe because
// db.py's set_league_season_info only ever touches external_id/
// league_name/regular_season_weeks in its own upsert's DO UPDATE SET, so
// values set here first survive untouched whenever the pipeline does get
// around to this season. Tolerates a not-yet-migrated DB -- logs and
// no-ops rather than failing the whole registration/edit over a missing
// column.
async function upsertSeasonDefaults(slug, season, { cupWeeks, scoringConfig }) {
  try {
    await query(
      `INSERT INTO league_seasons (league_id, season, cup_weeks, scoring_config)
       VALUES ((SELECT league_id FROM leagues WHERE slug = ?), ?, ?, ?)
       ON CONFLICT(league_id, season) DO UPDATE SET
            cup_weeks = excluded.cup_weeks, scoring_config = excluded.scoring_config`,
      [slug, season, cupWeeks, JSON.stringify(scoringConfig)]
    );
    return true;
  } catch (err) {
    console.error(`upsertSeasonDefaults(${slug}, ${season}) failed (DB likely not yet migrated):`, err);
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
  // Sleeper's own API reports which season this league id currently belongs
  // to -- used as the season Grand Prix settings below get saved against,
  // with no need to ask the registering visitor for it.
  const season = Number(sleeperLeague.season) || new Date().getFullYear();

  // Sleeper registration itself must stay fully open (see file-level
  // comment) -- but Grand Prix settings (cup length + scoring) are the same
  // commissioner-only decision here as everywhere else, so they still need
  // the shared passphrase. Rather than blocking registration over it, a
  // wrong/missing passphrase just silently registers the league with plain
  // defaults instead of whatever was submitted -- the commissioner can
  // always set real values afterward via Manage Leagues (which hard-fails
  // instead, since editing scoring is that form's entire purpose).
  const requestedScoring =
    body?.cupWeeks !== undefined || body?.scoringConfig !== undefined || body?.recapsEnabled !== undefined;
  const scoringAuthorized = passphraseOk(body?.scoringPassphrase);
  const cupWeeks = normalizeCupWeeks(scoringAuthorized ? body?.cupWeeks : null);
  const scoringConfig = normalizeScoringConfig(scoringAuthorized ? body?.scoringConfig : null);
  // Same commissioner-only gating as cupWeeks/scoringConfig above -- an
  // unauthorized request just registers with recaps off (the safe default)
  // rather than blocking registration entirely.
  const recapsEnabled = scoringAuthorized ? Boolean(body?.recapsEnabled) : false;

  await upsertLeague({ platform: "sleeper", slug, displayName, sleeperLeagueId, recapsEnabled });
  await upsertSeasonDefaults(slug, season, { cupWeeks, scoringConfig });

  return Response.json({
    slug,
    displayName: displayName || slug,
    season,
    cupWeeks,
    scoringConfig,
    recapsEnabled,
    // Tells the form whether its submitted Grand Prix settings actually
    // took, so it can say so, rather than silently showing plain defaults
    // back with no explanation of why they don't match what was entered.
    scoringSaved: !requestedScoring || scoringAuthorized,
  });
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
  // Grand Prix settings get saved against the most recent requested season
  // (same `checkYear` already used to validate the league/cookies above) --
  // no separate passphrase needed for this, since the top-of-function
  // passphraseOk(body?.passphrase) check already gates this entire request,
  // scoring settings included. recapsEnabled rides along the same way --
  // taken directly, no extra gate, since this whole request is already
  // passphrase-checked above.
  const season = checkYear;
  const recapsEnabled = Boolean(body?.recapsEnabled);

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
    recapsEnabled,
  });
  await upsertSeasonDefaults(slug, season, { cupWeeks, scoringConfig });

  return Response.json({
    slug, displayName: displayName || slug, years: pullYears, season, cupWeeks, scoringConfig, recapsEnabled,
  });
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
// league list -- for each one, every season that's been configured/pulled
// at all (`seasons`), plus that season's own cup length and scoring config
// (`cupWeeksBySeason`/`scoringConfigBySeason`, both keyed by season number)
// -- so the "Manage Leagues" section on the same page can list rename/
// delete controls and a per-season "Edit Scoring" picker without a second
// round trip to /api/meta. Both genuinely vary by season now (see db.py's
// league_seasons.cup_weeks/scoring_config comments), which is why they're
// shaped as per-season maps here instead of one value per league.
export async function GET() {
  const leagues = await query(
    "SELECT slug, display_name AS displayName, platform FROM leagues ORDER BY slug"
  ).catch(() => [] /* tolerate a not-yet-migrated DB that lacks the leagues table entirely */);

  // Fetched as its own separate, separately-tolerant query rather than
  // folded into the leagues SELECT above -- same reason seasonRows below is
  // split out too: a not-yet-migrated DB missing just this one column
  // should still show the rest of the league list, not fail it wholesale.
  const recapsEnabledRows = await query(
    "SELECT slug, recaps_enabled AS recapsEnabledRaw FROM leagues"
  ).catch(() => []);
  const recapsEnabledBySlug = new Map(
    recapsEnabledRows.map((r) => [r.slug, Boolean(r.recapsEnabledRaw)])
  );

  // Every (league, season) row that exists at all -- a season shows up here
  // once the pipeline has pulled it even once (see db.py's
  // set_league_season_info), regardless of whether its cup_weeks/
  // scoring_config have ever been explicitly set. Tolerant of a
  // not-yet-migrated DB missing either column, or even the whole
  // league_seasons table on a very old DB -- falls back to no seasons
  // rather than breaking the whole Manage Leagues section.
  const seasonRows = await query(
    `SELECT l.slug AS slug, ls.season AS season, ls.cup_weeks AS cupWeeksRaw, ls.scoring_config AS scoringConfigRaw
     FROM league_seasons ls JOIN leagues l ON l.league_id = ls.league_id
     ORDER BY l.slug, ls.season`
  ).catch(() => []);

  const seasonsBySlug = new Map();
  for (const row of seasonRows) {
    if (!seasonsBySlug.has(row.slug)) seasonsBySlug.set(row.slug, []);
    let scoringConfig = null;
    try {
      scoringConfig = row.scoringConfigRaw ? JSON.parse(row.scoringConfigRaw) : null;
    } catch {
      scoringConfig = null;
    }
    seasonsBySlug.get(row.slug).push({
      season: row.season,
      cupWeeks: normalizeCupWeeks(row.cupWeeksRaw),
      scoringConfig,
    });
  }

  const leaguesOut = leagues.map((l) => {
    const seasonEntries = seasonsBySlug.get(l.slug) || [];
    const cupWeeksBySeason = {};
    const scoringConfigBySeason = {};
    for (const e of seasonEntries) {
      cupWeeksBySeason[e.season] = e.cupWeeks;
      scoringConfigBySeason[e.season] = e.scoringConfig;
    }
    return {
      slug: l.slug,
      displayName: l.displayName,
      platform: l.platform,
      seasons: seasonEntries.map((e) => e.season),
      cupWeeksBySeason,
      scoringConfigBySeason,
      recapsEnabled: recapsEnabledBySlug.get(l.slug) || false,
    };
  });

  return Response.json({
    espnEnabled: Boolean(process.env.ADD_LEAGUE_PASSPHRASE),
    deleteEnabled: Boolean(process.env.ADD_LEAGUE_PASSPHRASE),
    leagues: leaguesOut,
  });
}
