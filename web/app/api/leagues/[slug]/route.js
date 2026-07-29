import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";

// Rename (open) and delete (passphrase-gated) an existing league.
//
// PATCH /api/leagues/<slug>  { displayName }
// DELETE /api/leagues/<slug> { passphrase }
//
// Renaming is purely cosmetic -- no credentials or destructive action
// involved, so it's open the same way Sleeper self-service registration is.
// Deleting is destructive and irreversible (every team/matchup/weekly
// score/contest result for that league, gone), and this site still has no
// login to otherwise restrict it to "your own" league -- so it reuses the
// same ADD_LEAGUE_PASSPHRASE gate as ESPN registration. If that env var
// isn't set, deletion is disabled outright, same reasoning as the ESPN
// add-league path.

function passphraseOk(submitted) {
  const expected = process.env.ADD_LEAGUE_PASSPHRASE;
  if (!expected) return false;
  const a = Buffer.from(String(submitted ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function PATCH(request, context) {
  const { slug } = await context.params;
  const body = await request.json().catch(() => null);
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";

  if (!displayName) {
    return Response.json({ error: "A non-empty display name is required." }, { status: 400 });
  }

  try {
    const existing = await query("SELECT league_id FROM leagues WHERE slug = ?", [slug]);
    if (existing.length === 0) {
      return Response.json({ error: "No league with that slug." }, { status: 404 });
    }
    await query("UPDATE leagues SET display_name = ? WHERE slug = ?", [displayName, slug]);
    return Response.json({ slug, displayName });
  } catch (err) {
    console.error(`PATCH /api/leagues/${slug} failed:`, err);
    return Response.json({ error: `Rename failed: ${err.message || err}` }, { status: 500 });
  }
}

export async function DELETE(request, context) {
  const { slug } = await context.params;
  const body = await request.json().catch(() => ({}));

  if (!passphraseOk(body?.passphrase)) {
    return Response.json(
      { error: "Incorrect passphrase, or league deletion isn't enabled on this deployment." },
      { status: 401 }
    );
  }

  try {
    const rows = await query("SELECT league_id FROM leagues WHERE slug = ?", [slug]);
    if (rows.length === 0) {
      return Response.json({ error: "No league with that slug." }, { status: 404 });
    }
    const leagueId = rows[0].league_id;

    // Ordered to respect foreign keys. `players` is deliberately never
    // touched here -- it's a global table (deduped by platform + platform
    // player id) shared across every league on that platform, not owned by
    // any single one.
    await query(
      "DELETE FROM weekly_player_points WHERE team_id IN (SELECT team_id FROM teams WHERE league_id = ?)",
      [leagueId]
    );
    await query("DELETE FROM matchups WHERE league_id = ?", [leagueId]);
    await query("DELETE FROM contest_windows WHERE league_id = ?", [leagueId]);
    await query("DELETE FROM teams WHERE league_id = ?", [leagueId]);
    await query("DELETE FROM managers WHERE league_id = ?", [leagueId]);
    await query("DELETE FROM league_seasons WHERE league_id = ?", [leagueId]);
    await query("DELETE FROM leagues WHERE league_id = ?", [leagueId]);

    return Response.json({ slug, deleted: true });
  } catch (err) {
    console.error(`DELETE /api/leagues/${slug} failed:`, err);
    return Response.json({ error: `Delete failed: ${err.message || err}` }, { status: 500 });
  }
}
