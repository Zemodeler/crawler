"use client";

import { useEffect, useState } from "react";

import { listModules, removeModule, saveModules, type ModuleChoice } from "../lib/setup.ts";

/**
 * Which modules the sync downloads, newest year first. This year's modules
 * start ticked. With `onSaved` it is the setup step (a Continue button);
 * without it, a settings section that also removes old modules' folders.
 */
export default function ModulePicker({ onSaved, saveLabel = "Continue" }: { onSaved?: () => void; saveLabel?: string }) {
  const [modules, setModules] = useState<ModuleChoice[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = () =>
    listModules()
      .then(({ modules }) => {
        setModules(modules);
        setPicked(Object.fromEntries(modules.map((m) => [m.shortname, m.enabled])));
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await saveModules(picked);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: ModuleChoice) => {
    if (!window.confirm(`Delete ${m.name} (${m.year}) from this computer? Its files, notes and study packs in that folder go, and it stops syncing.`)) return;
    setBusy(true);
    setError("");
    try {
      await removeModule(m.key, m.shortname);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!modules) return error ? <p className="form-error" role="alert">{error}</p> : <p className="quiet">Loading your modules…</p>;

  const years = [...new Set(modules.map((m) => m.year))].sort((a, b) => (a === "Undated" ? 1 : b === "Undated" ? -1 : b.localeCompare(a)));
  const count = Object.values(picked).filter(Boolean).length;

  return (
    <div className="module-picker">
      <div className="welcome-actions">
        <button className="text-link" disabled={busy} onClick={() => { setSaved(false); setPicked(Object.fromEntries(modules.map((m) => [m.shortname, m.recommended]))); }}>
          This year only
        </button>
        <button className="text-link" disabled={busy} onClick={() => { setSaved(false); setPicked(Object.fromEntries(modules.map((m) => [m.shortname, false]))); }}>
          None
        </button>
      </div>
      {years.map((year) => (
        <fieldset key={year}>
          <legend>{year === "Undated" ? "No year given" : year}</legend>
          {modules.filter((m) => m.year === year).map((m) => (
            <div key={m.shortname} className="module-choice">
              <label>
                <input
                  type="checkbox"
                  checked={picked[m.shortname] ?? false}
                  disabled={busy}
                  onChange={(e) => { setSaved(false); setPicked({ ...picked, [m.shortname]: e.target.checked }); }}
                />{" "}
                {m.name}
                {m.recommended ? <small className="quiet"> · this year</small> : null}
                {!m.isModule ? <small className="quiet"> · not a module</small> : null}
              </label>
              {!onSaved && m.onDisk && (
                <button className="text-link" disabled={busy} onClick={() => remove(m)}>Remove from this computer</button>
              )}
            </div>
          ))}
        </fieldset>
      ))}
      <div className="welcome-actions">
        <button className="primary large" disabled={busy || (onSaved && count === 0)} onClick={save}>
          {saved && !onSaved ? "Saved" : saveLabel}
        </button>
        <span className="quiet">{count} selected</span>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
