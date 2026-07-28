import { query } from "@/lib/db";

// Powers the season/manager filter dropdowns shared across pages.
export async function GET() {
  const seasons = await query("SELECT DISTINCT season FROM teams ORDER BY season DESC");
  const managers = await query("SELECT DISTINCT manager_name FROM managers ORDER BY manager_name");

  return Response.json({
    seasons: seasons.map((r) => r.season),
    managers: managers.map((r) => r.manager_name),
  });
}
