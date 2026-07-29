import { query } from "@/lib/db";

// Self-service "add a league" -- Sleeper only, deliberately. This site has
// no login, so an open form that accepted ESPN credentials would let
// anyone who finds the URL submit cookies that then get stored and used by
// the automated pipeline. Sleeper's API is public read-only and needs no
// credentials at all, so there's nothing sensitive being accepted here.
// ESPN leagues still go through config.json (see pipeline.py's docstring).
//
// This only registers the league (writes one row to `leagues`) -- it
// doesn't pull any data itself. The next scheduled pipeline run (or a
// manually triggered one) picks up any Sleeper league it finds in this
// table that isn't already covered by config.json and pulls its full
// history automatically (see pipeline.py's run_pipeline).
//
// POST /api/leagues  { sleeperLeagueId: string, displayName?: string }

function slugify(base) {
  return base
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  const sleeperLeagueId = typeof body?.sleeperLeagueId === "string" ? body.sleeperLeagueId.trim() : "";
  const requestedDisplayName =
    typeof body?.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null;

  if (!sleeperLeagueId) {
    return Response.json({ error: "sleeperLeagueId is required" }, { status: 400 });
  }
  if (!/^\d+$/.test(sleeperLeagueId)) {
    return Response.json({ error: "That doesn't look like a Sleeper league ID (should be all digits)." }, { status: 400 });
  }

  // Verify the league actually exists on Sleeper before registering it --
  // also lets us default the display name to Sleeper's own league name.
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

  // Ensure slug uniqueness. If the "conflicting" row is actually this same
  // Sleeper league re-submitted (e.g. someone resubmits the form), reuse
  // its existing slug instead of minting a new one.
  let slug = baseSlug;
  for (let i = 2; i < 50; i++) {
    const existing = await query("SELECT sleeper_league_id FROM leagues WHERE slug = ?", [slug]);
    if (existing.length === 0 || existing[0].sleeper_league_id === sleeperLeagueId) break;
    slug = `${baseSlug}-${i}`;
  }

  await query(
    `INSERT INTO leagues (platform, slug, display_name, sleeper_league_id)
     VALUES ('sleeper', ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
        display_name = excluded.display_name,
        sleeper_league_id = excluded.sleeper_league_id`,
    [slug, displayName, sleeperLeagueId]
  );

  return Response.json({ slug, displayName: displayName || slug });
}
