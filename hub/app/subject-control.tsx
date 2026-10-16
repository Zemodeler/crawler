"use client";

import { useEffect, useMemo, useState } from "react";
import { getModuleProfile, setModuleProfile, suggestModuleProfile, type ModuleProfile } from "../lib/library.ts";
import { getProfile, PROFILES, type SubjectId } from "../lib/subject-profiles.ts";
import type { DirectoryHandle, LocalFile } from "../lib/course-fs.ts";

export function useModuleSubject(target: string | DirectoryHandle | null, files: LocalFile[], name = "") {
  const [loaded, setLoaded] = useState<{ target: typeof target; files: LocalFile[]; choice: ModuleProfile } | null>(null);
  const setChoice = (choice: ModuleProfile) => setLoaded((previous) =>
    previous?.target === target && previous.files === files ? { ...previous, choice } : previous);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (target) getModuleProfile(target, files).then((value) => { if (active) { setLoaded({ target, files, choice: value }); setError(""); } }).catch((e) => { if (active) { setLoaded(null); setError(e.message); } });
    return () => { active = false; };
  }, [target, files]);
  const suggestion = useMemo(() => name ? suggestModuleProfile(name, files) : null, [name, files]);
  const current = target ? (loaded?.target === target && loaded.files === files ? loaded.choice : null) : suggestion;
  return { choice: current, setChoice, error, setError, profile: getProfile(current?.profile ?? "general") };
}

export function SubjectControl({ target, subject, disabled = false }: {
  target: string | DirectoryHandle | null; subject: ReturnType<typeof useModuleSubject>; disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<SubjectId | null>(null);
  const { choice, profile, error } = subject;
  const selected = picked ?? profile.id;
  const save = async () => {
    if (!target || !choice) return;
    setSaving(true);
    try {
      await setModuleProfile(target, selected, !choice.confirmed && selected === choice.profile ? "suggested" : "student");
      subject.setChoice({ profile: selected, confirmed: true, reason: "Saved subject choice." });
      subject.setError("");
    } catch (e) { subject.setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <div className="field">
    <label htmlFor="module-subject">Subject</label>
    <p>{choice ? <><b>{profile.label}</b> — {profile.description}</> : "Loading subject…"}</p>
    {choice && !choice.confirmed && <p>Suggested: {profile.label}. {choice.reason} Confirm this subject before converting.</p>}
    <div className="inline-row">
      <select id="module-subject" value={selected} disabled={disabled || saving || !choice} onChange={(e) => setPicked(e.target.value as SubjectId)}>
        {Object.values(PROFILES).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <button className="btn btn-ghost" disabled={!target || !choice || disabled || saving} onClick={save}>{saving ? "Saving…" : choice?.confirmed ? "Save subject" : "Confirm subject"}</button>
    </div>
    {picked && picked !== profile.id && <p>{getProfile(picked).description}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
