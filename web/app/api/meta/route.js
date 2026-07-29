import { query } from "@/lib/db";

// Powers the league/season/manager filter dropdowns shared across pages,
// and the league display name used for nav labeling (e.g. the Contests
// "<league> Grand Prix" link).
//
// GET /api/meta               -> defaults to the first registered league
// GET /api/meta?league=<slug> -> scoped to that league
export async function GET(request) {
  const requestedSlug = new URL(request.url).searchParams.get("league");

  const leagues = await query(
    "SELECT slug, display_name AS displayName, platform FROM leagues ORDER BY slug"
  ).catch(() => []); // tolerate a not-yet-migrated DB that lacks the leagues table

  if (leagues.length === 0) {
    return Response.json({ leagues: [], league: null, seasons: [], managers: [], leagueName: null });
  }

  const activeSlug = leagues.some((l) => l.slug === requestedSlug) ? requestedSlug : leagues[0].slug;

  const seasons = await query(
    `SELECT DISTINCT ls.season FROM league_seasons ls
     JOIN leagues l ON l.league_id = ls.league_id
     WHERE l.slug = ? ORDER BY ls.season DESC`,
    [activeSlug]
  );
  const managers = await query(
    `SELECT DISTINCT m.manager_name FROM managers m
     JOIN leagues l ON l.league_id = m.league_id
     WHERE l.slug = ? ORDER BY m.manager_name`,
    [activeSlug]
  );
  // Prefer a manually-set display_name; otherwise fall back to whatever the
  // platform itself calls the league, from its most recent pulled season.
  const nameRows = await query(
    `SELECT COALESCE(l.display_name, ls.league_name) AS name
     FROM leagues l LEFT JOIN league_seasons ls ON ls.league_id = l.league_id
     WHERE l.slug = ?
     ORDER BY ls.season DESC LIMIT 1`,
    [activeSlug]
  );

  return Response.json({
    leagues,
    league: activeSlug,
    seasons: seasons.map((r) => r.season),
    managers: managers.map((r) => r.manager_name),
    leagueName: nameRows[0]?.name ?? null,
  });
}
