import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";

// Weekly recap read/write API -- see db.py's weekly_recaps table comment.
//
// GET /api/recaps?league=<slug>&season=<year>&limit=<n>
//   league required. season optional: given, returns just that season's
//   recaps (newest week first) -- what the Contests page uses to show the
//   latest recap above the active cup's leaderboard. Omitted, returns every
//   recap ever written for this league across all seasons, newest first --
//   what the dedicated Weekly Report page uses. limit optional, applied
//   after sorting either way.
//
// POST /api/recaps  { league, season, week, title, body, apiKey }
//   Upserts (creates or replaces) the recap for that league/season/week.
//   Gated behind a dedicated RECAP_API_KEY env var -- deliberately NOT
//   ADD_LEAGUE_PASSPHRASE, even though both are simple shared-secret
//   speed bumps: this key is meant to live in an automated weekly task's
//   own stored instructions (see the scheduled recap-generation task),
//   not typed by a human each time the way the commissioner passphrase is,
//   so it gets its own credential rather than reusing the human-facing one.
// Also requires the target league to have recaps_enabled set -- a valid
// key alone doesn't bypass a league's own opt-in choice, so pointing the
// automation at a league that never enabled this feature (or that had it
// switched back off) still fails closed.
function apiKeyOk(submitted) {
  const expected = process.env.RECAP_API_KEY;
  if (!expected) return false; // not configured -- posting recaps is disabled
  const a = Buffer.from(String(submitted ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
  return timingSafeEqual(a, b);
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const league = searchParams.get("league");
  const seasonParam = searchParams.get("season");
  const limitParam = searchParams.get("limit");

  if (!league) {
    return Response.json({ error: "league query param is required" }, { status: 400 });
  }

  const season = seasonParam ? Number(seasonParam) : null;
  if (seasonParam && !Number.isInteger(season)) {
    return Response.json({ error: "season must be an integer" }, { status: 400 });
  }
  const limit = limitParam ? Number(limitParam) : null;
  if (limitParam && (!Number.isInteger(limit) || limit < 1)) {
    return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
  }

  const rows = season != null
    ? await query(
        `SELECT r.season, r.week, r.title, r.body, r.created_at
         FROM weekly_recaps r
         JOIN leagues l ON l.league_id = r.league_id
         WHERE l.slug = ? AND r.season = ?
         ORDER BY r.week DESC`,
        [league, season]
      ).catch(() => [])
    : await query(
        `SELECT r.season, r.week, r.title, r.body, r.created_at
         FROM weekly_recaps r
         JOIN leagues l ON l.league_id = r.league_id
         WHERE l.slug = ?
         ORDER BY r.season DESC, r.week DESC`,
        [league]
      ).catch(() => []); // tolerate a not-yet-migrated DB that lacks weekly_recaps

  const recaps = limit ? rows.slice(0, limit) : rows;
  return Response.json({ recaps });
}

export async function POST(request) {
  if (!process.env.RECAP_API_KEY) {
    return Response.json(
      { error: "Recap posting isn't configured on this deployment." },
      { status: 501 }
    );
  }

  const body = await request.json().catch(() => null);
  if (!apiKeyOk(body?.apiKey)) {
    return Response.json({ error: "Incorrect or missing apiKey." }, { status: 401 });
  }

  const league = typeof body?.league === "string" ? body.league : null;
  const season = Number(body?.season);
  const week = Number(body?.week);
  const title = typeof body?.title === "string" ? body.title.trim() : null;
  const recapBody = typeof body?.body === "string" ? body.body.trim() : "";

  if (!league || !Number.isInteger(season) || !Number.isInteger(week) || !recapBody) {
    return Response.json(
      { error: "league, season, week, and a non-empty body are required." },
      { status: 400 }
    );
  }

  try {
    const leagueRows = await query(
      "SELECT league_id, recaps_enabled FROM leagues WHERE slug = ?",
      [league]
    );
    if (leagueRows.length === 0) {
      return Response.json({ error: "No league with that slug." }, { status: 404 });
    }
    // Fails closed on a not-yet-migrated DB (recaps_enabled missing/NULL
    // reads as falsy here) the same as on a league that explicitly never
    // opted in -- see leagues.recaps_enabled's SCHEMA_SQL comment.
    if (!leagueRows[0].recaps_enabled) {
      return Response.json(
        { error: "This league does not have recaps_enabled -- nothing was posted." },
        { status: 403 }
      );
    }
    const leagueId = leagueRows[0].league_id;

    await query(
      `INSERT INTO weekly_recaps (league_id, season, week, title, body)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(league_id, season, week) DO UPDATE SET
            title = excluded.title, body = excluded.body, created_at = datetime('now')`,
      [leagueId, season, week, title, recapBody]
    );
    return Response.json({ league, season, week, title });
  } catch (err) {
    console.error(`POST /api/recaps failed for ${league} season ${season} week ${week}:`, err);
    return Response.json({ error: `Failed to save recap: ${err.message || err}` }, { status: 500 });
  }
}
