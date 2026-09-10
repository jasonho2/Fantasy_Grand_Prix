import { query } from "@/lib/db";

// One row per team for a league/season: team name -> profile picture URL
// (ESPN's mTeam "logo" field; NULL for Sleeper-sourced teams, or for any
// team pulled before the logo_url column existed until the pipeline next
// runs for that league). Deliberately a separate, tiny endpoint rather than
// adding logo_url to every existing standings/matchups/contests query --
// those all key rows by team name already, so the frontend just fetches
// this once per league/season and joins client-side by team name, keeping
// the existing SQL untouched.
//
// GET /api/team-logos?league=<slug>&season=2025

// ESPN's newer custom-logo-upload domain 401s on a bare hotlinked <img src>
// without the league's espn_s2/SWID session cookies -- unlike the older
// g.espncdn.com CDN, which serves publicly. Any logo_url on this host gets
// rewritten to route through api/team-logo-proxy/route.js instead, which
// fetches it server-side with those cookies attached and streams the bytes
// back same-origin. Everything else (g.espncdn.com defaults/logo-packs,
// third-party hosts like postimg/Discord) already loads fine as-is.
const PROXY_HOST = "mystique-api.fantasy.espn.com";

function toDisplayUrl(logoUrl, league) {
  try {
    if (new URL(logoUrl).hostname === PROXY_HOST) {
      return `/api/team-logo-proxy?league=${encodeURIComponent(league)}&url=${encodeURIComponent(logoUrl)}`;
    }
  } catch {
    // Not a valid absolute URL -- fall through and use it as-is (frontend's
    // TeamLogo.js already tolerates a bad src via its onError fallback).
  }
  return logoUrl;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const league = params.get("league");
  const season = Number(params.get("season"));
  if (!league || !season) {
    return Response.json({ error: "league and season query params are required" }, { status: 400 });
  }

  const rows = await query(
    `SELECT t.team_name AS team, t.logo_url AS logoUrl
     FROM teams t
     JOIN leagues l ON l.league_id = t.league_id
     WHERE l.slug = ? AND t.season = ?`,
    [league, season]
  ).catch(() => []); // tolerate a not-yet-migrated DB that lacks logo_url

  const logos = {};
  for (const row of rows) {
    if (row.logoUrl) logos[row.team] = toDisplayUrl(row.logoUrl, league);
  }
  return Response.json({ logos });
}
