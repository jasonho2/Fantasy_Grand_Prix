"use client";

import { useEffect, useRef, useState } from "react";
import { REFRESH_COOLDOWN_SECONDS } from "../../lib/refreshConfig";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 120000; // stop actively polling after ~2 minutes and just say so

// SQLite's datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" -- not ISO
// 8601 -- same normalization Nav.js's formatDataAsOf does before handing it
// to Date, so both the cooldown countdown and "did lastPulledAt actually
// move" comparisons below use a real timestamp instead of a raw string.
function parseLastPulledAt(value) {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Manually triggers a pipeline run (see api/refresh/route.js) for days the
// Sun/Mon/Thu cron doesn't cover -- e.g. a rescheduled Wednesday game -- or
// just wanting an immediate pull without waiting on the 5-minute schedule.
// Rendered in Nav next to "Data as of", only when /api/meta reports
// refreshEnabled (i.e. the deployment has REFRESH_PASSPHRASE,
// GITHUB_DISPATCH_TOKEN, and GITHUB_REPO all configured).
//
// `lastPulledAt` is the same value Nav's "Data as of" text already shows;
// `onRefreshed` is that same useJson call's `refetch`, used here to re-poll
// /api/meta after triggering until lastPulledAt actually moves, which is
// how this confirms the run really happened -- GitHub's dispatch API
// returns no run id to track directly.
export default function RefreshButton({ league, lastPulledAt, onRefreshed }) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | polling | success | error
  const [error, setError] = useState(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  const triggeredAtRef = useRef(null); // lastPulledAt (parsed) captured right before triggering
  const pollTimerRef = useRef(null);
  const pollDeadlineRef = useRef(null);

  // Client-side cooldown countdown, ticking every second purely off
  // lastPulledAt -- proactive UI only, so it can't itself stop a
  // determined bypass (hitting the API route directly). The real
  // enforcement is server-side (see api/refresh/route.js), which is fine
  // with this being client-side-only here.
  useEffect(() => {
    const last = parseLastPulledAt(lastPulledAt);
    if (!last) {
      setCooldownRemaining(0);
      return;
    }
    function tick() {
      const elapsed = (Date.now() - last.getTime()) / 1000;
      setCooldownRemaining(Math.max(0, Math.ceil(REFRESH_COOLDOWN_SECONDS - elapsed)));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastPulledAt]);

  // While polling, this is what actually ends it -- watching the
  // lastPulledAt PROP for a value newer than what it was right before
  // triggering. Each poll tick below calls onRefreshed() (Nav's
  // /api/meta refetch), which -- once that fetch resolves and Nav
  // re-renders -- flows a fresh lastPulledAt back down as a prop here.
  useEffect(() => {
    if (status !== "polling") return undefined;
    const triggeredAt = triggeredAtRef.current;
    const current = parseLastPulledAt(lastPulledAt);
    if (triggeredAt != null && current != null && current.getTime() > triggeredAt.getTime()) {
      clearTimeout(pollTimerRef.current);
      setStatus("success");
      const t = setTimeout(() => setStatus("idle"), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [lastPulledAt, status]);

  // Belt-and-suspenders cleanup on unmount (e.g. navigating away mid-poll).
  useEffect(() => () => clearTimeout(pollTimerRef.current), []);

  function schedulePoll() {
    pollTimerRef.current = setTimeout(async () => {
      if (Date.now() > pollDeadlineRef.current) {
        setStatus("error");
        setError('Still waiting on GitHub -- check the Actions tab, or "Data as of" above in a bit.');
        return;
      }
      await onRefreshed?.();
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase, league }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429 && body.retryAfterSeconds) {
          throw new Error(
            `Already refreshed recently -- try again in about ${Math.ceil(body.retryAfterSeconds / 60)} min.`
          );
        }
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      triggeredAtRef.current = parseLastPulledAt(lastPulledAt) ?? new Date(0);
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      setPassphrase("");
      setOpen(false);
      setStatus("polling");
      schedulePoll();
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  if (status === "polling") {
    return <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>Refreshing...</span>;
  }
  if (status === "success") {
    return <span style={{ fontSize: 11, color: "var(--win)", whiteSpace: "nowrap" }}>Refreshed</span>;
  }

  const onCooldown = cooldownRemaining > 0 && status === "idle";

  if (!open) {
    return (
      <button
        type="button"
        className="week-chip"
        style={{ fontSize: 11, padding: "2px 8px" }}
        onClick={() => setOpen(true)}
        disabled={onCooldown}
        title={
          onCooldown
            ? `Refreshed recently -- available again in about ${Math.ceil(cooldownRemaining / 60)} min`
            : "Manually trigger a data refresh"
        }
      >
        {onCooldown ? `Refresh (wait ${Math.ceil(cooldownRemaining / 60)}m)` : "Refresh Now"}
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input
        type="password"
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        required
        autoFocus
        style={{ fontSize: 11, padding: "2px 6px", width: 110 }}
      />
      <button
        type="submit"
        className="week-chip selected"
        style={{ fontSize: 11, padding: "2px 8px" }}
        disabled={status === "submitting"}
      >
        {status === "submitting" ? "..." : "Go"}
      </button>
      <button
        type="button"
        className="week-chip"
        style={{ fontSize: 11, padding: "2px 8px" }}
        onClick={() => {
          setOpen(false);
          setError(null);
          setStatus("idle");
        }}
      >
        Cancel
      </button>
      {error && <span style={{ fontSize: 11, color: "var(--loss)" }}>{error}</span>}
    </form>
  );
}
