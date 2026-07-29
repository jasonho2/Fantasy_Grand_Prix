"use client";

import { useEffect, useState } from "react";
import { useJson } from "../../../lib/useJson";

function SleeperForm({ onDone }) {
  const [sleeperLeagueId, setSleeperLeagueId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | error
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "sleeper",
          sleeperLeagueId: sleeperLeagueId.trim(),
          displayName: displayName.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      onDone(body);
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
        Sleeper&apos;s API is public and needs no login or credentials, so anyone can add a
        Sleeper league here.
      </p>

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
          Found in your league&apos;s Sleeper URL: sleeper.com/leagues/<strong>this-part</strong>
          /... -- use the current season&apos;s league, past seasons are found automatically.
        </p>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="displayNameSleeper" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          Display name <span style={{ color: "var(--text-dim)" }}>(optional)</span>
        </label>
        <input
          id="displayNameSleeper"
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
  );
}

function EspnForm({ onDone }) {
  const [espnLeagueId, setEspnLeagueId] = useState("");
  const [espnS2, setEspnS2] = useState("");
  const [espnSwid, setEspnSwid] = useState("");
  const [years, setYears] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "espn",
          espnLeagueId: espnLeagueId.trim(),
          espnS2: espnS2.trim(),
          espnSwid: espnSwid.trim(),
          years: years.trim(),
          displayName: displayName.trim(),
          passphrase,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      onDone(body);
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
        ESPN leagues need real account cookies, so this is gated by a passphrase -- ask whoever
        runs this site for it. Those cookies are stored and used by the automated pipeline the
        same way a league added via config.json would be.
      </p>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="espnLeagueId" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          ESPN League ID
        </label>
        <input
          id="espnLeagueId"
          type="text"
          inputMode="numeric"
          placeholder="e.g. 1083280"
          value={espnLeagueId}
          onChange={(e) => setEspnLeagueId(e.target.value)}
          required
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ marginBottom: 14, display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="espnS2" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
            espn_s2 cookie <span style={{ color: "var(--text-dim)" }}>(private leagues only)</span>
          </label>
          <input
            id="espnS2"
            type="text"
            value={espnS2}
            onChange={(e) => setEspnS2(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="espnSwid" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          SWID cookie <span style={{ color: "var(--text-dim)" }}>(private leagues only, include the braces)</span>
        </label>
        <input
          id="espnSwid"
          type="text"
          placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
          value={espnSwid}
          onChange={(e) => setEspnSwid(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="years" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          Years <span style={{ color: "var(--text-dim)" }}>(optional -- ESPN can&apos;t auto-detect history like Sleeper)</span>
        </label>
        <input
          id="years"
          type="text"
          placeholder="e.g. 2024,2025,2026 or 2024-2026 -- defaults to the current year"
          value={years}
          onChange={(e) => setYears(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="displayNameEspn" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          Display name <span style={{ color: "var(--text-dim)" }}>(optional)</span>
        </label>
        <input
          id="displayNameEspn"
          type="text"
          placeholder="Defaults to the league's name on ESPN"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="passphrase" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          Passphrase
        </label>
        <input
          id="passphrase"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          required
          style={{ width: "100%" }}
        />
      </div>

      {error && <div className="error-state" style={{ marginBottom: 14 }}>{error}</div>}

      <button type="submit" className="week-chip selected" disabled={status === "submitting"}>
        {status === "submitting" ? "Checking..." : "Add League"}
      </button>
    </form>
  );
}

function RenameForm({ league, onDone, onCancel }) {
  const [displayName, setDisplayName] = useState(league.displayName || "");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/leagues/${encodeURIComponent(league.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      onDone(body);
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
        autoFocus
        style={{ flex: "1 1 200px" }}
      />
      <button type="submit" className="week-chip selected" disabled={status === "submitting"}>
        {status === "submitting" ? "Saving..." : "Save"}
      </button>
      <button type="button" className="week-chip" onClick={onCancel}>
        Cancel
      </button>
      {error && <div className="error-state" style={{ width: "100%" }}>{error}</div>}
    </form>
  );
}

function DeleteForm({ league, onDone, onCancel }) {
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/leagues/${encodeURIComponent(league.slug)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      onDone(league.slug);
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <p style={{ width: "100%", margin: 0, color: "var(--loss)", fontSize: 13 }}>
        This permanently deletes every team, matchup, weekly score, and contest result for{" "}
        <strong>{league.displayName || league.slug}</strong>. This can&apos;t be undone.
      </p>
      <input
        type="password"
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        required
        autoFocus
        style={{ flex: "1 1 200px" }}
      />
      <button type="submit" className="week-chip" disabled={status === "submitting"} style={{ borderColor: "var(--loss)", color: "var(--loss)" }}>
        {status === "submitting" ? "Deleting..." : "Confirm Delete"}
      </button>
      <button type="button" className="week-chip" onClick={onCancel}>
        Cancel
      </button>
      {error && <div className="error-state" style={{ width: "100%" }}>{error}</div>}
    </form>
  );
}

function ManageLeagues({ leagues, deleteEnabled, onChanged }) {
  const [editingSlug, setEditingSlug] = useState(null); // "<slug>:rename" | "<slug>:delete" | null

  if (!leagues || leagues.length === 0) return null;

  return (
    <div className="panel" style={{ maxWidth: 520, marginTop: 20 }}>
      <h2>Manage Leagues</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {leagues.map((league) => {
          const editing = editingSlug === `${league.slug}:rename` ? "rename" : editingSlug === `${league.slug}:delete` ? "delete" : null;
          return (
            <div key={league.slug} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              {editing === "rename" ? (
                <RenameForm
                  league={league}
                  onCancel={() => setEditingSlug(null)}
                  onDone={() => {
                    setEditingSlug(null);
                    onChanged();
                  }}
                />
              ) : editing === "delete" ? (
                <DeleteForm
                  league={league}
                  onCancel={() => setEditingSlug(null)}
                  onDone={() => {
                    setEditingSlug(null);
                    onChanged();
                  }}
                />
              ) : (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <strong>{league.displayName || league.slug}</strong>{" "}
                    <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({league.platform})</span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="week-chip" onClick={() => setEditingSlug(`${league.slug}:rename`)}>
                      Rename
                    </button>
                    <button
                      type="button"
                      className="week-chip"
                      onClick={() => setEditingSlug(`${league.slug}:delete`)}
                      disabled={!deleteEnabled}
                      title={!deleteEnabled ? "League deletion isn't enabled on this deployment" : undefined}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AddLeaguePage() {
  const { data: config, refetch } = useJson("/api/leagues");
  const [platform, setPlatform] = useState("sleeper");
  const [result, setResult] = useState(null);

  // Once we know whether ESPN self-service is enabled on this deployment,
  // don't leave the tab sitting on a form that can only ever 401.
  useEffect(() => {
    if (config && !config.espnEnabled && platform === "espn") setPlatform("sleeper");
  }, [config, platform]);

  if (result) {
    return (
      <div className="panel" style={{ maxWidth: 520, background: "rgba(62,207,142,0.08)", borderColor: "var(--win)" }}>
        <strong>{result.displayName}</strong> is registered.
        <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
          It&apos;ll show up in the league switcher once the next data sync runs (every 30
          minutes during the season, or sooner if the site owner triggers one manually) and pulls
          its {result.years ? `${result.years.join(", ")} season(s)` : "full history"} automatically.
        </p>
        <button
          type="button"
          className="week-chip"
          onClick={() => {
            setResult(null);
            refetch();
          }}
        >
          Add another
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="panel" style={{ maxWidth: 520 }}>
        <h2>Add a League</h2>

        <div className="controls" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`week-chip${platform === "sleeper" ? " selected" : ""}`}
            onClick={() => setPlatform("sleeper")}
          >
            Sleeper
          </button>
          <button
            type="button"
            className={`week-chip${platform === "espn" ? " selected" : ""}`}
            onClick={() => setPlatform("espn")}
            disabled={config && !config.espnEnabled}
            title={config && !config.espnEnabled ? "ESPN self-service isn't enabled on this deployment" : undefined}
          >
            ESPN{config && !config.espnEnabled ? " (disabled)" : ""}
          </button>
        </div>

        {platform === "sleeper" ? <SleeperForm onDone={setResult} /> : <EspnForm onDone={setResult} />}
      </div>

      <ManageLeagues leagues={config?.leagues} deleteEnabled={config?.deleteEnabled} onChanged={refetch} />
    </>
  );
}
