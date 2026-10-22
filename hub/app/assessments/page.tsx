"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  addDeadline, fetchAssessments, fetchDeadlines, fetchTree, moduleCode, moduleColor,
  removeDeadline, setDeadlineDone, type Assessment, type Deadline, type LibraryYear,
} from "../../lib/library.ts";
import { isHosted } from "../../lib/ai/settings.ts";
import { dayKey, formatDue, latestDate, placeDate, StatusPill, KIND_LABEL } from "../calendar/deadline-ui.tsx";

/** Prefer specific title words; use the component's assessment type as a fallback. */
function componentFor(deadline: Deadline, components: Assessment[]): number {
  const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !["the", "and", "of", "a", "assessment"].includes(w)) || [];
  const title = new Set(words(deadline.title));
  const scores = components.map((c) => {
    const exam = c.type === "ECO" || /examin?ation|exam/i.test(c.description);
    const lab = c.type === "PRA" || /lab/i.test(c.description);
    const kindMatch = (deadline.kind === "exam" && exam) || (deadline.kind === "lab" && lab) ||
      (["coursework", "quiz"].includes(deadline.kind) && c.type === "CWK");
    // An explicit exam/lab type must not be assigned to an unrelated component.
    if ((deadline.kind === "exam" && !exam) || (deadline.kind === "lab" && !lab)) return 0;
    return words(c.description).filter((w) => title.has(w)).length * 10 + (kindMatch ? 1 : 0);
  });
  const best = Math.max(0, ...scores);
  const match = scores.indexOf(best);
  return best > 0 && scores.lastIndexOf(best) === match ? match : -1;
}

export default function AssessmentsPage() {
  const [year, setYear] = useState<LibraryYear | null>(null);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unhosted" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!isHosted()) { queueMicrotask(() => setState("unhosted")); return; }
    let active = true;
    Promise.all([fetchTree(), fetchAssessments(), fetchDeadlines()]).then(([tree, components, items]) => {
      if (!active) return;
      setYear([...tree.years].sort((a, b) => b.year.localeCompare(a.year))[0] || null);
      setAssessments(components); setDeadlines(items); setNow(Date.now()); setState("ready");
    }).catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);

  const modules = year?.modules || [];
  const codes = modules.map(moduleCode);
  const items = deadlines.filter((d) => d.year === year?.year && codes.includes(d.module) && d.status !== "cancelled");
  const dated = (d: Deadline) => d.status !== "tbc" || !!d.window;
  const order = (a: Deadline, b: Deadline) =>
    (dated(a) ? placeDate(a)?.getTime() ?? Infinity : Infinity) -
    (dated(b) ? placeDate(b)?.getTime() ?? Infinity : Infinity) || a.title.localeCompare(b.title);
  const upcoming = items.filter((d) => !d.done && (!dated(d) || !placeDate(d) ||
    (d.due?.allDay ? dayKey(new Date(d.due.iso)) >= dayKey(new Date(now)) : (latestDate(d)?.getTime() ?? Infinity) >= now))).sort(order);
  const done = items.filter((d) => d.done).sort(order);

  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save your change. Try again."); }
    finally { setBusy(false); }
  }
  function row(d: Deadline) {
    const folder = modules.find((m) => moduleCode(m) === d.module) || d.module;
    return <li key={d.id} className="deadline-row assessment-deadline">
      <input type="checkbox" checked={!!d.done} disabled={busy} aria-label={`Mark ${d.title} as ${d.done ? "not done" : "done"}`}
        onChange={(e) => { const checked = e.target.checked; void mutate(async () => {
          const updated = await setDeadlineDone(d.id, checked);
          setDeadlines((all) => all.map((item) => item.id === updated.id ? updated : item));
        }); }} />
      <span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />
      <span className="deadline-title">{d.title}<small>{d.module} / {d.due || d.window ? formatDue(d) : "date TBC"}</small>
        {d.userNote && <small className="assessment-note">{d.userNote}</small>}</span>
      {d.weight !== undefined && <span className="weight">{d.weight}%</span>}
      {["needs-check", "conflict", "tbc"].includes(d.status) && <StatusPill status={d.status} deadline={d} />}
      {d.id.startsWith("user:") && <button className="text-link" disabled={busy} aria-label={`Remove ${d.title}`}
        onClick={() => void mutate(async () => { await removeDeadline(d.id); setDeadlines((all) => all.filter((item) => item.id !== d.id)); })}>Remove</button>}
    </li>;
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void mutate(async () => {
      const time = String(data.get("time") || "");
      const weight = String(data.get("weight") || "");
      const deadline = await addDeadline({
        module: String(data.get("module")), year: year!.year, title: String(data.get("title")),
        kind: String(data.get("kind")) as Deadline["kind"], date: `${data.get("date")}${time ? `T${time}` : ""}`,
        ...(weight ? { weight: Number(weight) } : {}), note: String(data.get("note") || ""),
      });
      setDeadlines((all) => [...all, deadline]); form.reset(); setNotice("Deadline added.");
    });
  }

  return <div className="calendar-page assessments-page">
    <header className="topbar">
      {/* A full load: client navigation back to the hub does not render it. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="back-link" href="/">Study Hub</a>
      <div><p className="eyebrow">{year?.year || "Study Hub"}</p><h2>What you are assessed on</h2></div>
      <a className="text-link" href="/calendar">Calendar</a>
    </header>
    <main className="calendar-main">
      {state === "loading" && <p className="calendar-message">Reading your assessments...</p>}
      {state === "unhosted" && <p className="calendar-message">Open Study Hub from the desktop app to see your assessments.</p>}
      {state === "error" && <p role="alert">Could not read your assessments. Reopen this page to try again.</p>}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="quiet">{notice}</p>
      {state === "ready" && <>
        <section aria-labelledby="todo-title">
          <h3 id="todo-title" className="list-heading">To do</h3>
          {upcoming.length ? <ul className="deadline-rows">{upcoming.map(row)}</ul> : <p className="quiet">No upcoming deadlines.</p>}
          <details><summary>Done ({done.length})</summary><ul className="deadline-rows">{done.map(row)}</ul></details>
        </section>
        {!modules.length && <p className="quiet">No modules yet. Your assessments appear here after your library syncs.</p>}
        {modules.map((folder) => {
          const code = moduleCode(folder);
          const components = assessments.filter((a) => a.module === code && a.year === year?.year && !a.resit);
          const moduleDeadlines = items.filter((d) => d.module === code).sort(order);
          const assignments = moduleDeadlines.map((d) => ({ deadline: d, component: componentFor(d, components) }));
          const other = assignments.filter((a) => a.component === -1);
          return <section className="panel assessment-module" key={folder} aria-label={folder}>
            <h3><span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />{folder}</h3>
            {!components.length && <><p className="quiet">No assessment breakdown found on QMplus yet</p>
              <p className="weight">Known deadline weights: {moduleDeadlines.reduce((sum, d) => sum + (d.weight || 0), 0)}%</p></>}
            {components.map((c, index) => <div className="assessment-component" key={`${c.seq}-${index}`}>
              <h4>{c.description} {c.type && <small className="quiet">{c.type}</small>} <span className="weight">{c.weight === null ? "Weight TBC" : `${c.weight}%`}</span></h4>
              {c.weight !== null && <progress max={100} value={c.weight} aria-label={`${c.description}: ${c.weight}% of module`} />}
              <ul className="deadline-rows">{assignments.filter((a) => a.component === index).map((a) => row(a.deadline))}</ul>
            </div>)}
            {other.length > 0 && <div className="assessment-component"><h4>Other deadlines</h4><ul className="deadline-rows">{other.map((a) => row(a.deadline))}</ul></div>}
          </section>;
        })}
        {modules.length > 0 && <section className="panel assessment-module" aria-labelledby="add-title">
          <h3 id="add-title">Add a deadline</h3><p className="quiet">For marking and tasks QMplus does not list as dates. Dates and times are in London time.</p>
          <form className="assessment-form" onSubmit={submit}>
            <label>Module<select name="module" required>{modules.map((m) => <option key={m} value={moduleCode(m)}>{m}</option>)}</select></label>
            <label>Title<input name="title" required maxLength={500} /></label>
            <label>Kind<select name="kind">{Object.entries(KIND_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>Date<input name="date" type="date" required /></label>
            <label>Time (optional)<input name="time" type="time" /></label>
            <label>Weight % (optional)<input name="weight" type="number" min="0" max="100" step="any" /></label>
            <label className="assessment-note-field">Note (optional)<textarea name="note" maxLength={4000} /></label>
            <button className="primary small" type="submit" disabled={busy}>{busy ? "Saving..." : "Add deadline"}</button>
          </form>
        </section>}
      </>}
    </main>
  </div>;
}
