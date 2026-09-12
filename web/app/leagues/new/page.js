"use client";

import { useEffect, useState } from "react";
import { useJson } from "../../../lib/useJson";
import PointsGrid from "../../components/PointsGrid";
import { CUP_NAMES, DEFAULT_POINT_TABLES, DEFAULT_CUP_WEEKS, normalizeCupWeeks } from "../../../lib/scoring";

// A blank (all-"") point-table draft sized for `mode` -- what a fresh
// CupConfigBox starts with, and what it resets to on a mode switch (the two
// modes have differently-sized placement tables, so carrying draft values
// over from one to the other would leave stale/misaligned entries).
function blankPointTable(mode) {
  return DEFAULT_POINT_TABLES[mode].map(() => "");
}

function ModeSelect({ mode, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        type="button"
        className={`week-chip${mode === "solo" ? " selected" : ""}`}
        onClick={() => onChange("solo")}
      >
        Solo
      </button>
      <button
        type="button"
        className={`week-chip${mode === "doubleDash" ? " selected" : ""}`}
        onClick={() => onChange("doubleDash")}
      >
        Double Dash
      </button>
    </div>
  );
}

// One cup's (or, in uniform mode, the whole season's) mode + point-table
// configuration. `config` is { mode, pointTable } where pointTable is a
// sparse array of strings the same length as DEFAULT_POINT_TABLES[mode] --
// same shape/resolution rules as web/lib/scoring.js's normalizeScoringConfig,
// just held here as editable draft state (strings, for controlled inputs)
// before being packed back into that canonical shape by buildScoringConfig.
function CupConfigBox({ title, config, onChange }) {
  return (
    <div className="panel" style={{ background: "var(--bg)", marginBottom: 12 }}>
      {title && (
        <strong style={{ display: "block", marginBottom: 8, fontSize: 14 }}>
          {title}
        </strong>
      )}
      <div style={{ marginBottom: 10 }}>
        <ModeSelect
          mode={config.mode}
          onChange={(mode) => {
            if (mode === config.mode) return;
            onChange({ mode, pointTable: blankPointTable(mode) });
          }}
        />
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 8px" }}>
        Points awarded for each weekly placement. Leave a box blank to keep the built-in default for
        that placement.
      </p>
      <PointsGrid
        defaults={DEFAULT_POINT_TABLES[config.mode]}
        draft={config.pointTable}
        onChange={(i, v) => {
          const next = [...config.pointTable];
          next[i] = v;
          onChange({ ...config, pointTable: next });
        }}
      />
    </div>
  );
}

// Just the 15/16-week toggle -- scoped per season now (stored on
// `league_seasons`, see db.py's cup_weeks comment), same as scoring. Split
// out from the scoring-format picker below (they used to be one combined
// component, back when cup length actually was league-wide) purely to keep
// each picker focused; both Add League's GrandPrixSettings (configuring
// only ever "the initial season") and Manage Leagues' EditScoringForm
// (reloading per whichever season its own dropdown has selected) compose
// this the same way.
function CupWeeksPicker({ cupWeeks, onChange }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Grand Prix length</label>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className={`week-chip${cupWeeks === 15 ? " selected" : ""}`}
          onClick={() => onChange(15)}
        >
          15 weeks
        </button>
        <button
          type="button"
          className={`week-chip${cupWeeks === 16 ? " selected" : ""}`}
          onClick={() => onChange(16)}
        >
          16 weeks
        </button>
      </div>
    </div>
  );
}

// The cup scoring-format picker (uniform vs. per-cup, plus each cup's
// mode/point table) for ONE season -- deliberately separate from
// CupWeeksPicker above, since scoring is configured per season (see db.py's
// league_seasons.scoring_config) while cup length isn't. Add League
// composes this together with CupWeeksPicker (see GrandPrixSettings below)
// since there's only ever "the initial season" to configure there; Manage
// Leagues' Edit Scoring shows CupWeeksPicker once and this scoped to
// whichever season its own season dropdown currently has selected.
function ScoringFormatSettings({
  uniform,
  onUniformChange,
  uniformConfig,
  onUniformConfigChange,
  perCupConfig,
  onPerCupConfigChange,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Cup scoring format</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`week-chip${uniform ? " selected" : ""}`}
            onClick={() => onUniformChange(true)}
          >
            Same for all 4 cups
          </button>
          <button
            type="button"
            className={`week-chip${!uniform ? " selected" : ""}`}
            onClick={() => onUniformChange(false)}
          >
            Different per cup
          </button>
        </div>
      </div>

      {uniform ? (
        <CupConfigBox config={uniformConfig} onChange={onUniformConfigChange} />
      ) : (
        CUP_NAMES.map((name, i) => (
          <CupConfigBox
            key={name}
            title={name}
            config={perCupConfig[i]}
            onChange={(next) => {
              const copy = [...perCupConfig];
              copy[i] = next;
              onPerCupConfigChange(copy);
            }}
          />
        ))
      )}

      <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "8px 0 0" }}>
        These become the default scoring shown on the Grand Prix page for this season -- anyone
        viewing can still switch modes, sort by a specific week, or view as a chart, and
        &quot;Reset to Default&quot; there brings the view back to this.
      </p>
    </div>
  );
}

// Add League's combined picker -- cup length + this (the initial) season's
// scoring format together, shown before either platform's own "Add League"
// submit button. Just CupWeeksPicker + ScoringFormatSettings composed
// together; no season picker needed here since registration only ever
// configures one (implicit) season -- see Manage Leagues' EditScoringForm
// below for the season-aware version used to edit an already-registered
// league.
function GrandPrixSettings({
  cupWeeks,
  onCupWeeksChange,
  uniform,
  onUniformChange,
  uniformConfig,
  onUniformConfigChange,
  perCupConfig,
  onPerCupConfigChange,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <CupWeeksPicker cupWeeks={cupWeeks} onChange={onCupWeeksChange} />
      <ScoringFormatSettings
        uniform={uniform}
        onUniformChange={onUniformChange}
        uniformConfig={uniformConfig}
        onUniformConfigChange={onUniformConfigChange}
        perCupConfig={perCupConfig}
        onPerCupConfigChange={onPerCupConfigChange}
      />
    </div>
  );
}

// Packs the GrandPrixSettings widget's controlled state into the
// scoringConfig JSON shape the server expects (see web/lib/scoring.js) --
// mirrors normalizeScoringConfig's own cleanup (a fully-blank point table
// collapses to null) so an all-defaults submission round-trips to exactly
// what a league that never configured anything would already look like.
function buildScoringConfig({ uniform, uniformConfig, perCupConfig }) {
  function clean(config) {
    const hasAny = config.pointTable.some((v) => v !== "" && v != null);
    return { mode: config.mode, pointTable: hasAny ? config.pointTable : null };
  }
  return uniform
    ? { uniform: true, ...clean(uniformConfig) }
    : { uniform: false, cups: perCupConfig.map(clean) };
}

// The reverse of buildScoringConfig -- turns a stored (or absent) SEASON's
// scoringConfig back into ScoringFormatSettings' controlled state, e.g. when
// Manage Leagues' "Edit Scoring" opens for a league/season that already has
// defaults set, or when its season dropdown switches to a different season.
// A stored pointTable entry is `number | null`; drafts want strings (blank
// for null) since they're controlled <input> values. No cupWeeks in this
// shape -- that's tracked separately (see CupWeeksPicker/EditScoringForm),
// which is why cupWeeks gets its own useState reloaded via
// handleSeasonChange rather than being folded into this state object.
function scoringConfigToState(scoringConfig) {
  function toDraft(cfg) {
    const mode = cfg?.mode === "doubleDash" ? "doubleDash" : "solo";
    const stored = Array.isArray(cfg?.pointTable) ? cfg.pointTable : null;
    const pointTable = DEFAULT_POINT_TABLES[mode].map((_, i) => {
      const v = stored?.[i];
      return v === null || v === undefined ? "" : String(v);
    });
    return { mode, pointTable };
  }

  const uniform = scoringConfig?.uniform !== false;
  return {
    uniform,
    uniformConfig: uniform ? toDraft(scoringConfig) : toDraft(null),
    perCupConfig: CUP_NAMES.map((_, i) => toDraft(!uniform ? scoringConfig?.cups?.[i] : null)),
  };
}

function SleeperForm({ onDone, cupWeeks, scoringConfig }) {
  const [sleeperLeagueId, setSleeperLeagueId] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Registration itself stays open (see the page's Sleeper intro text
  // below) -- but the Grand Prix length/scoring picked above IS the same
  // commissioner-only decision gated everywhere else on this site, so
  // submitting it here needs the passphrase too (see api/leagues/route.js's
  // handleSleeper). Left blank, the league still registers fine, just with
  // plain defaults instead of whatever was picked above -- there's nothing
  // to lose by trying, so this field is optional rather than required.
  const [scoringPassphrase, setScoringPassphrase] = useState("");
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
          cupWeeks,
          scoringConfig,
          scoringPassphrase,
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

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="scoringPassphraseSleeper" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          Grand Prix settings passphrase{" "}
          <span style={{ color: "var(--text-dim)" }}>
            (optional -- only needed to save the length/scoring picked above; leave blank to
            register with plain defaults and set them later via Manage Leagues)
          </span>
        </label>
        <input
          id="scoringPassphraseSleeper"
          type="password"
          value={scoringPassphrase}
          onChange={(e) => setScoringPassphrase(e.target.value)}
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

function EspnForm({ onDone, cupWeeks, scoringConfig }) {
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
          cupWeeks,
          scoringConfig,
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

// Edits a registered league's Grand Prix defaults: a season dropdown (from
// league.seasons, defaulting to the most recent), plus CupWeeksPicker and
// ScoringFormatSettings BOTH scoped to whichever season is selected,
// reloading their draft state from league.cupWeeksBySeason/
// scoringConfigBySeason whenever the selection changes -- cup length and
// scoring are both configured per season now (see db.py's league_seasons.
// cup_weeks/scoring_config), so switching seasons here must never carry
// over another season's unsaved edits, and saving must never silently
// change a different season's Contests page. Saving always requires the
// passphrase (see api/leagues/[slug]/route.js's PATCH comment for why this
// hard-fails on a wrong one, unlike Add League's Sleeper path, which
// soft-fails to keep registration open).
function EditScoringForm({ league, onDone, onCancel }) {
  const seasons = league.seasons || [];
  const [season, setSeason] = useState(() => (seasons.length ? seasons[seasons.length - 1] : null));
  const [cupWeeks, setCupWeeks] = useState(() =>
    normalizeCupWeeks(season != null ? league.cupWeeksBySeason?.[season] : null)
  );
  const [state, setState] = useState(() =>
    scoringConfigToState(season != null ? league.scoringConfigBySeason?.[season] : null)
  );
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  function handleSeasonChange(nextSeason) {
    setSeason(nextSeason);
    setCupWeeks(normalizeCupWeeks(league.cupWeeksBySeason?.[nextSeason]));
    setState(scoringConfigToState(league.scoringConfigBySeason?.[nextSeason]));
  }

  async function handleSave() {
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/leagues/${encodeURIComponent(league.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          season,
          cupWeeks,
          scoringConfig: buildScoringConfig(state),
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

  // No season configured yet at all -- happens for a league registered
  // before this feature existed, or one that just hasn't had a pipeline run
  // pull any of its seasons yet (see db.py's set_league_season_info, which
  // is what actually creates a league_seasons row). Nothing to scope a
  // scoring edit to without at least one season on record.
  if (seasons.length === 0) {
    return (
      <div>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          No seasons found yet for this league -- run the pipeline at least once (or wait for the
          next scheduled sync) before setting per-season scoring here.
        </p>
        <button type="button" className="week-chip" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Season picked first -- both CupWeeksPicker and ScoringFormatSettings
          below are scoped to whichever season this selects (see the
          function-level comment), so picking the season up front makes that
          scoping clear rather than implying either setting is global. */}
      <div style={{ marginBottom: 14 }}>
        <label htmlFor={`season-${league.slug}`} style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
          Season
        </label>
        <select
          id={`season-${league.slug}`}
          value={season ?? ""}
          onChange={(e) => handleSeasonChange(Number(e.target.value))}
          style={{ width: "100%" }}
        >
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <CupWeeksPicker cupWeeks={cupWeeks} onChange={setCupWeeks} />

      <ScoringFormatSettings
        uniform={state.uniform}
        onUniformChange={(uniform) => setState((s) => ({ ...s, uniform }))}
        uniformConfig={state.uniformConfig}
        onUniformConfigChange={(uniformConfig) => setState((s) => ({ ...s, uniformConfig }))}
        perCupConfig={state.perCupConfig}
        onPerCupConfigChange={(perCupConfig) => setState((s) => ({ ...s, perCupConfig }))}
      />

      <div style={{ marginBottom: 14 }}>
        <label htmlFor={`scoringPassphrase-${league.slug}`} style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
          Passphrase
        </label>
        <input
          id={`scoringPassphrase-${league.slug}`}
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          required
          style={{ width: "100%" }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="week-chip selected" onClick={handleSave} disabled={status === "submitting"}>
          {status === "submitting" ? "Saving..." : "Save"}
        </button>
        <button type="button" className="week-chip" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <div className="error-state" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function ManageLeagues({ leagues, deleteEnabled, onChanged }) {
  const [editingSlug, setEditingSlug] = useState(null); // "<slug>:rename" | "<slug>:delete" | "<slug>:scoring" | null

  if (!leagues || leagues.length === 0) return null;

  return (
    <div className="panel" style={{ maxWidth: 520, marginTop: 20 }}>
      <h2>Manage Leagues</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {leagues.map((league) => {
          const editing =
            editingSlug === `${league.slug}:rename`
              ? "rename"
              : editingSlug === `${league.slug}:delete`
                ? "delete"
                : editingSlug === `${league.slug}:scoring`
                  ? "scoring"
                  : null;
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
              ) : editing === "scoring" ? (
                <EditScoringForm
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
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="week-chip" onClick={() => setEditingSlug(`${league.slug}:rename`)}>
                      Rename
                    </button>
                    <button type="button" className="week-chip" onClick={() => setEditingSlug(`${league.slug}:scoring`)}>
                      Edit Scoring
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

  // Grand Prix settings state, shared across both platform forms (only one
  // is visible at a time, but there's no reason switching Sleeper/ESPN
  // should discard what's already been picked here) -- see GrandPrixSettings
  // and buildScoringConfig above.
  const [cupWeeks, setCupWeeks] = useState(DEFAULT_CUP_WEEKS);
  const [uniform, setUniform] = useState(true);
  const [uniformConfig, setUniformConfig] = useState({ mode: "solo", pointTable: blankPointTable("solo") });
  const [perCupConfig, setPerCupConfig] = useState(() =>
    CUP_NAMES.map(() => ({ mode: "solo", pointTable: blankPointTable("solo") }))
  );
  const scoringConfig = buildScoringConfig({ uniform, uniformConfig, perCupConfig });

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
          It&apos;ll show up in the league switcher once the next data sync runs (every 5
          minutes during the season, or sooner if the site owner triggers one manually) and pulls
          its {result.years ? `${result.years.join(", ")} season(s)` : "full history"} automatically.
        </p>
        {result.scoringSaved === false && (
          <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
            The Grand Prix length/scoring picked above wasn&apos;t saved (missing or incorrect
            passphrase) -- the league registered with plain defaults instead. Set real values
            later via Manage Leagues&apos; &quot;Edit Scoring.&quot;
          </p>
        )}
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

        {/* Grand Prix length + scoring format, chosen before either
            platform's own "Add League" submit button -- per spec, these
            apply regardless of which platform the league is being
            registered on. */}
        <GrandPrixSettings
          cupWeeks={cupWeeks}
          onCupWeeksChange={setCupWeeks}
          uniform={uniform}
          onUniformChange={setUniform}
          uniformConfig={uniformConfig}
          onUniformConfigChange={setUniformConfig}
          perCupConfig={perCupConfig}
          onPerCupConfigChange={setPerCupConfig}
        />

        {platform === "sleeper" ? (
          <SleeperForm onDone={setResult} cupWeeks={cupWeeks} scoringConfig={scoringConfig} />
        ) : (
          <EspnForm onDone={setResult} cupWeeks={cupWeeks} scoringConfig={scoringConfig} />
        )}
      </div>

      <ManageLeagues leagues={config?.leagues} deleteEnabled={config?.deleteEnabled} onChanged={refetch} />
    </>
  );
}
