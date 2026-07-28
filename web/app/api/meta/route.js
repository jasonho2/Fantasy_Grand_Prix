import { query } from "@/lib/db";

// Powers the season/manager filter dropdowns shared across pages, and the
// league name used for nav labeling (e.g. the Contests "<league> Grand Prix" link).
export async function GET() {
  const seasons = await query("SELECT DISTINCT season FROM teams ORDER BY season DESC");
  const managers = await query("SELECT DISTINCT manager_name FROM managers ORDER BY manager_name");
  const leagueRows = await query(
    "SELECT league_name FROM leagues ORDER BY season DESC LIMIT 1"
  ).catch(() => []); // tolerate a not-yet-migrated DB that lacks the leagues table

  return Response.json({
    seasons: seasons.map((r) => r.season),
    managers: managers.map((r) => r.manager_name),
    leagueName: leagueRows[0]?.league_name ?? null,
  });
}
