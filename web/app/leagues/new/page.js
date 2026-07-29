"use client";

import { useState } from "react";
import Link from "next/link";

export default function AddLeaguePage() {
  const [sleeperLeagueId, setSleeperLeagueId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeperLeagueId: sleeperLeagueId.trim(), displayName: displayName.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setResult(body);
      setStatus("done");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 520 }}>
      <h2>Add a League</h2>
      <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
        Sleeper leagues only, for now -- Sleeper&apos;s API is public and needs no login or
        credentials, so it&apos;s the only platform this form can add safely without one.{" "}
        <Link href="/standings">Already have an ESPN league set up?</Link> That one&apos;s added
        differently, via the pipeline&apos;s config file.
      </p>

      {status === "done" ? (
        <div className="panel" style={{ background: "rgba(62,207,142,0.08)", borderColor: "var(--win)" }}>
          <strong>{result.displayName}</strong> is registered.
          <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
            It&apos;ll show up in the league switcher once the next data sync runs (every 30
            minutes during the season, or sooner if the site owner triggers one manually) and
            pulls its full history automatically.
          </p>
          <button
            type="button"
            className="week-chip"
            onClick={() => {
              setStatus("idle");
              setSleeperLeagueId("");
              setDisplayName("");
              setResult(null);
            }}
          >
            Add another
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="sleeperLeagueId" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              Sleeper League ID
            </label>
            <input
              id="sleeperLeagueId"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 1071896401286336512"
              value={sleeperLeagueId}
              onChange={(e) => setSleeperLeagueId(e.target.value)}
              required
              style={{ width: "100%" }}
            />
            <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 4 }}>
              Found in your league&apos;s Sleeper URL: sleeper.com/leagues/
              <strong>this-part</strong>/... -- use the current season&apos;s league, past
              seasons are found automatically.
            </p>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="displayName" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              Display name <span style={{ color: "var(--text-dim)" }}>(optional)</span>
            </label>
            <input
              id="displayName"
              type="text"
              placeholder="Defaults to the league's name on Sleeper"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          {error && <div className="error-state" style={{ marginBottom: 14 }}>{error}</div>}

          <button type="submit" className="week-chip selected" disabled={status === "submitting"}>
            {status === "submitting" ? "Checking..." : "Add League"}
          </button>
        </form>
      )}
    </div>
  );
}
