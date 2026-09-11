import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { normalizeCupWeeks, normalizeScoringConfig } from "@/lib/scoring";

// Rename (open), edit Grand Prix scoring defaults (open), and delete
// (passphrase-gated) an existing league.
//
// PATCH /api/leagues/<slug>  { displayName? }  and/or  { cupWeeks?, scoringConfig? }
// DELETE /api/leagues/<slug> { passphrase }
//
// Renaming and editing scoring defaults are both purely cosmetic/display
// preferences -- no credentials or destructive action involved, so they're
// open the same way Sleeper self-service registration is. A request can
// include either field group, both, or neither field from the other group;
// at least one recognized field is required. cupWeeks/scoringConfig use the
// same shape/validation as registration (see web/lib/scoring.js and
// api/leagues/route.js's upsertLeague) -- this is how a league registered
// before this feature existed (or whose owner skipped it at import time)
// gets real Grand Prix defaults set for the first time, and how they're
// changed later.
//
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
  // Scoring fields are edited as a pair (both always sent together by the
  // "Grand Prix settings" UI -- see leagues/new/page.js) so there's no
  // partial-update ambiguity between them; presence of either one in the
  // body means "update both."
  const hasScoring = body && (body.cupWeeks !== undefined || body.scoringConfig !== undefined);

  if (!displayName && !hasScoring) {
    return Response.json(
      { error: "Nothing to update -- send a non-empty displayName and/or cupWeeks/scoringConfig." },
      { status: 400 }
    );
  }

  try {
    const existing = await query("SELECT league_id FROM leagues WHERE slug = ?", [slug]);
    if (existing.length === 0) {
      return Response.json({ error: "No league with that slug." }, { status: 404 });
    }

    const result = { slug };
    if (displayName) {
      await query("UPDATE leagues SET display_name = ? WHERE slug = ?", [displayName, slug]);
      result.displayName = displayName;
    }
    if (hasScoring) {
      const cupWeeks = normalizeCupWeeks(body.cupWeeks);
      const scoringConfig = normalizeScoringConfig(body.scoringConfig);
      // No upsertLeague-style fallback here (unlike registration) -- if
      // these columns don't exist yet on this DB, surfacing a real error is
      // more useful than silently pretending the edit took effect.
      await query("UPDATE leagues SET cup_weeks = ?, scoring_config = ? WHERE slug = ?", [
        cupWeeks,
        JSON.stringify(scoringConfig),
        slug,
      ]);
      result.cupWeeks = cupWeeks;
      result.scoringConfig = scoringConfig;
    }
    return Response.json(result);
  } catch (err) {
    console.error(`PATCH /api/leagues/${slug} failed:`, err);
    return Response.json({ error: `Update failed: ${err.message || err}` }, { status: 500 });
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
