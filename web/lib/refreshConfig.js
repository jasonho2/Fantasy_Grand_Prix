// Shared between the manual-refresh API route and its frontend button so
// the two stay in sync: the button proactively disables itself client-side
// using this value (computed from the already-fetched lastPulledAt, no
// extra round trip), and the API route enforces the same window
// server-side as a defense-in-depth backstop in case the client-side check
// is bypassed (calling the API directly) or the two clocks disagree.
//
// A manually triggered pipeline run pulls every configured league in one
// go (same as a scheduled run), so there's no point letting someone
// re-trigger it moments after a run just started -- nothing new would be
// there to fetch yet.
export const REFRESH_COOLDOWN_SECONDS = 180;
