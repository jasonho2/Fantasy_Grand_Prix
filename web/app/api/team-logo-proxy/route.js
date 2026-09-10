import { query } from "@/lib/db";

// ESPN moved custom-uploaded team logos to a newer image domain
// (mystique-api.fantasy.espn.com) that requires the same espn_s2/SWID
// session cookies the pipeline already uses to read private-league data --
// unlike the older g.espncdn.com CDN, it 401s on a bare hotlinked <img src>
// from any other origin. This route re-fetches that image server-side using
// the league's stored cookies (same espn_s2/espn_swid columns api/leagues
// writes) and streams the bytes back same-origin, so the browser's <img>
// tag never talks to ESPN directly. api/team-logos/route.js rewrites any
// mystique-api URL to point here instead of the raw ESPN URL.
//
// GET /api/team-logo-proxy?league=<slug>&url=<original ESPN image URL>
const ALLOWED_HOST = "mystique-api.fantasy.espn.com";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const league = params.get("league");
  const rawUrl = params.get("url");
  if (!league || !rawUrl) {
    return Response.json({ error: "league and url query params are required" }, { status: 400 });
  }

  // Strictly allowlist the host we'll fetch -- this route takes an
  // attacker-choosable URL as input, so without this it'd be an open proxy
  // that forwards a visitor's request (and this league's ESPN cookies!) to
  // anywhere on the internet.
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return Response.json({ error: "url is not a valid URL" }, { status: 400 });
  }
  if (target.hostname !== ALLOWED_HOST) {
    return Response.json({ error: "url host is not allowed" }, { status: 400 });
  }

  const rows = await query(
    "SELECT espn_s2 AS espnS2, espn_swid AS espnSwid FROM leagues WHERE slug = ?",
    [league]
  ).catch(() => []);
  const { espnS2, espnSwid } = rows[0] || {};
  const cookieHeader = [espnS2 && `espn_s2=${espnS2}`, espnSwid && `SWID=${espnSwid}`]
    .filter(Boolean)
    .join("; ");

  const espnRes = await fetch(target.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  }).catch(() => null);

  // Let the <img>'s own onError fallback (TeamLogo.js) handle any failure --
  // no cookies on file for this league, expired cookies, or ESPN itself
  // erroring -- rather than serving a broken-image response.
  if (!espnRes || !espnRes.ok) {
    return Response.json({ error: "Failed to fetch image from ESPN" }, { status: 502 });
  }

  const buffer = await espnRes.arrayBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": espnRes.headers.get("content-type") || "image/jpeg",
      // These are static per-team profile pictures -- safe to cache
      // aggressively client- and CDN-side; a changed logo just needs a
      // hard refresh to show, same as any other cached image.
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  });
}
