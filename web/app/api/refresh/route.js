import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { REFRESH_COOLDOWN_SECONDS } from "@/lib/refreshConfig";

// Manually triggers the same "Pull fantasy data" GitHub Actions workflow
// the 5-minute Sun/Mon/Thu cron already runs (.github/workflows/pull-data.yml,
// which already has workflow_dispatch: {} enabled) -- for days the cron
// doesn't cover (e.g. a rescheduled Wednesday game) or just wanting an
// immediate pull without waiting on the schedule. A manual run pulls every
// configured league in one go, exactly like a scheduled run does -- there's
// no way to scope it to just one league/page's data, since it's all one
// `pipeline.py` invocation.
//
// Gated behind a shared passphrase (REFRESH_PASSPHRASE env var), same
// lightweight-speed-bump pattern as ADD_LEAGUE_PASSPHRASE in
// api/leagues/route.js -- not real auth, just enough to keep a public
// button from being triggered by anyone who happens to find the site.
// Disabled outright (reported via /api/meta's refreshEnabled) unless
// REFRESH_PASSPHRASE, GITHUB_DISPATCH_TOKEN, and GITHUB_REPO are all set.
//
// POST /api/refresh
//   body: { passphrase, league }   (league = the slug to cooldown-check
//                                   against; the triggered run itself
//                                   still pulls every configured league)
function passphraseOk(submitted) {
  const expected = process.env.REFRESH_PASSPHRASE;
  if (!expected) return false; // not configured -- manual refresh is disabled
  const a = Buffer.from(String(submitted ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal-length buffers
  return timingSafeEqual(a, b);
}

export async function POST(request) {
  const dispatchToken = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO; // "owner/repo"
  if (!process.env.REFRESH_PASSPHRASE || !dispatchToken || !repo) {
    return Response.json(
      { error: "Manual refresh isn't configured on this deployment." },
      { status: 501 }
    );
  }

  const body = await request.json().catch(() => ({}));
  if (!passphraseOk(body?.passphrase)) {
    return Response.json({ error: "Incorrect passphrase." }, { status: 401 });
  }

  const league = body?.league;
  if (!league) {
    return Response.json({ error: "league is required" }, { status: 400 });
  }

  // Defense-in-depth cooldown -- the button itself already disables
  // client-side using the same window (see RefreshButton.js), computed
  // from the lastPulledAt it already has on hand with no extra round
  // trip. This server-side check is what actually stops a re-trigger if
  // that client-side check is bypassed (hitting this route directly) or
  // the client's clock is off.
  const rows = await query("SELECT last_pulled_at FROM leagues WHERE slug = ?", [league]).catch(
    () => [] // tolerate a not-yet-migrated DB that lacks last_pulled_at
  );
  const lastPulledAt = rows[0]?.last_pulled_at;
  if (lastPulledAt) {
    // SQLite's datetime('now') is UTC, "YYYY-MM-DD HH:MM:SS" -- same
    // normalization Nav.js's formatDataAsOf does before handing it to Date.
    const iso = lastPulledAt.includes("T") ? lastPulledAt : `${lastPulledAt.replace(" ", "T")}Z`;
    const elapsedSeconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (Number.isFinite(elapsedSeconds) && elapsedSeconds < REFRESH_COOLDOWN_SECONDS) {
      const retryAfterSeconds = Math.ceil(REFRESH_COOLDOWN_SECONDS - elapsedSeconds);
      return Response.json(
        { error: "Already refreshed recently.", retryAfterSeconds },
        { status: 429 }
      );
    }
  }

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/pull-data.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dispatchToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: process.env.GITHUB_REPO_BRANCH || "main" }),
    }
  ).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }));

  // GitHub returns 204 No Content on a successful dispatch, with no run id
  // to track -- workflow_dispatch just doesn't hand one back. That's why
  // the frontend confirms success by polling /api/meta's lastPulledAt for
  // a change instead of tracking this specific run.
  if (!dispatchRes.ok) {
    const detail = await dispatchRes.text().catch(() => "");
    console.error("GitHub workflow dispatch failed:", dispatchRes.status, detail);
    return Response.json(
      { error: "Failed to trigger the refresh workflow. Check server logs." },
      { status: 502 }
    );
  }

  return Response.json({ ok: true });
}
