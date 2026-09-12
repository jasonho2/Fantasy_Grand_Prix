import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { normalizeCupWeeks, normalizeScoringConfig } from "@/lib/scoring";

// Rename (open), edit Grand Prix scoring defaults (passphrase-gated), and
// delete (passphrase-gated) an existing league.
//
// PATCH /api/leagues/<slug>  { displayName? }  and/or  { season, cupWeeks?, scoringConfig?, passphrase }
// DELETE /api/leagues/<slug> { passphrase }
//
// Renaming is a purely cosmetic/display preference -- no credentials or
// destructive action involved, so it stays open the same way Sleeper
// self-service registration is. Editing Grand Prix scoring is NOT open,
// unlike a plain rename: it's the same commissioner-only decision gated
// everywhere else on this site, and this is that decision's dedicated,
// sole-purpose form -- so unlike registration's softer "wrong passphrase
// silently falls back to defaults" behavior, a wrong/missing passphrase
// here hard-fails with 401, exactly like DELETE below. A request can
// include the displayName field, the scoring field group, or both; the
// scoring group requires `season` (which season this edits -- see db.py's
// league_seasons.cup_weeks/scoring_config for why BOTH cup length and
// scoring are per-season, not per-league: changing either for one season
// must never silently change a different season's Contests page too) plus
// `passphrase`, in addition to at least one of cupWeeks/scoringConfig.
// cupWeeks/scoringConfig use the same shape/validation as registration
// (see web/lib/scoring.js and api/leagues/route.js's
// upsertLeague/upsertSeasonDefaults) -- this is how a season's Grand Prix
// defaults get set for the first time, or changed later.
//
// Deleting is destructive and irreversible (every team/matchup/weekly
// score/contest result for that league, gone), and this site still has no
// login to otherwise restrict it to "your own" league -- so it reuses the
// same ADD_LEAGUE_PASSPHRASE gate as ESPN registration and scoring edits.
// If that env var isn't set, deletion (and scoring edits) are disabled
// outright, same reasoning as the ESPN add-league path.

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
  const season = Number(body?.season);

  if (!displayName && !hasScoring) {
    return Response.json(
      { error: "Nothing to update -- send a non-empty displayName and/or cupWeeks/scoringConfig." },
      { status: 400 }
    );
  }
  if (hasScoring && !Number.isInteger(season)) {
    return Response.json(
      { error: "Editing Grand Prix scoring requires a season (which year's config this changes)." },
      { status: 400 }
    );
  }
  // Editing scoring is gated the same way DELETE is below -- unlike
  // renaming, which stays open (see file-level comment). Checked before
  // touching the database so a wrong passphrase can't even partially apply
  // (e.g. renaming while also silently rejecting the scoring half).
  if (hasScoring && !passphraseOk(body?.passphrase)) {
    return Response.json(
      { error: "Incorrect passphrase, or scoring edits aren't enabled on this deployment." },
      { status: 401 }
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
      // Both cup_weeks and scoringConfig are scoped to the specific
      // `season` this request named -- upserted together into
      // league_seasons (not written to leagues.cup_weeks/scoring_config,
      // both superseded, see db.py) so editing one season's Grand Prix
      // settings never touches any other season's Contests page. No
      // fallback here (unlike registration's upsertLeague/
      // upsertSeasonDefaults, which log-and-no-op on a not-yet-migrated
      // DB): this is a deliberate, explicit edit action, so if either
      // column doesn't exist yet on this DB, surfacing a real error is
      // more useful than silently pretending the edit took effect.
      await query(
        `INSERT INTO league_seasons (league_id, season, cup_weeks, scoring_config)
         VALUES ((SELECT league_id FROM leagues WHERE slug = ?), ?, ?, ?)
         ON CONFLICT(league_id, season) DO UPDATE SET
              cup_weeks = excluded.cup_weeks, scoring_config = excluded.scoring_config`,
        [slug, season, cupWeeks, JSON.stringify(scoringConfig)]
      );
      result.season = season;
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
