"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  addDeadline, fetchAssessments, fetchDeadlines, fetchTree, loadModule, moduleCode, moduleColor,
  removeDeadline, saveActiveModule, setDeadlineDone, type Assessment, type Deadline, type LibraryYear,
} from "../../lib/library.ts";
import { isHosted } from "../../lib/ai/settings.ts";
import { parseCSV } from "../../lib/course-format.ts";
import {
  buildFocus, countdown, fileName, isExamLike, pickSources, practiceHref, rankSources,
  type ExamFile, type ReviewRecord,
} from "../../lib/exam-focus.ts";
import { dayKey, formatDue, latestDate, placeDate, StatusPill, KIND_LABEL } from "../calendar/deadline-ui.tsx";

/** How many deadlines the "Next deadlines" list shows before the rest fold away. */
const COMPACT_DEADLINES = 5;

/** What the hub has saved about one module, read once for the exam cards. */
type ModuleData = {
  files: ExamFile[];
  opened: Record<string, number>;
  reviews: Record<string, ReviewRecord>;
  /** Module-relative CSV path -> cards in it; empty until the module's decks have been read. */
  cardCounts: Record<string, number>;
};

/** Files opened and cards reviewed, as the reader and flashcards pages saved them. */
function savedProgress(key: string): Pick<ModuleData, "opened" | "reviews"> {
  const read = (storageKey: string): Record<string, unknown> => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "{}") || {}; } catch { return {}; }
  };
  return {
    opened: (read(`studyhub:${key}`).opened as ModuleData["opened"]) || {},
    reviews: (read(`studyhub:flashcards:${key}`).reviews as ModuleData["reviews"]) || {},
  };
}

/** Cards per deck, counted the way the flashcards page reads a deck: rows with a question and an answer. */
function countCards(files: { path: string; ext: string; text?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (f.ext !== "csv" || !f.text) continue;
    const rows = parseCSV(f.text.charCodeAt(0) === 0xfeff ? f.text.slice(1) : f.text);
    const heads = rows[0]?.map((h) => h.trim().toLowerCase()) || [];
    const q = heads.indexOf("question");
    const a = heads.indexOf("answer");
    if (q < 0 || a < 0) continue;
    counts[f.path] = rows.slice(1).filter((r) => r[q]?.trim() && r[a]?.trim()).length;
  }
  return counts;
}

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
  /** Per module (`<year>/<folder>`): what the exam cards need to say what to focus on. */
  const [moduleData, setModuleData] = useState<Record<string, ModuleData>>({});
  /** Exam card id -> the files the student ticked instead of the automatic pick. */
  const [manual, setManual] = useState<Record<string, string[]>>({});
  /** Exam card ids whose source picker is open. */
  const [picking, setPicking] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isHosted()) { queueMicrotask(() => setState("unhosted")); return; }
    let active = true;
    Promise.all([fetchTree(), fetchAssessments(), fetchDeadlines()]).then(([tree, components, items]) => {
      if (!active) return;
      const latest = [...tree.years].sort((a, b) => b.year.localeCompare(a.year))[0] || null;
      setYear(latest);
      setAssessments(components); setDeadlines(items); setNow(Date.now()); setState("ready");
      // Only modules with an exam, test or quiz coming up need their files and cards read.
      for (const folder of latest?.modules || []) {
        const code = moduleCode(folder);
        if (!items.some((d) => d.year === latest!.year && d.module === code && d.status !== "cancelled" && !d.done && isExamLike(d))) continue;
        const key = `${latest!.year}/${folder}`;
        const prefix = `${key}/`;
        const files = tree.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), modified: f.modified }));
        setModuleData((all) => ({ ...all, [key]: { files, ...savedProgress(key), cardCounts: {} } }));
        // Deck sizes need the CSV text; the cards fill in when it arrives.
        loadModule(tree, latest!.year, folder).then((local) => {
          if (active) setModuleData((all) => all[key] ? { ...all, [key]: { ...all[key], cardCounts: countCards(local) } } : all);
        }).catch(() => { /* the focus list works without deck sizes */ });
      }
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
  const exams = upcoming.filter(isExamLike);

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
  function examCard(d: Deadline) {
    const folder = modules.find((m) => moduleCode(m) === d.module) || d.module;
    const key = `${year!.year}/${folder}`;
    const components = assessments.filter((a) => a.module === d.module && a.year === year?.year && !a.resit);
    const component = components[componentFor(d, components)];
    const weight = d.weight ?? component?.weight ?? null;
    const data = moduleData[key];
    const text = `${d.title} ${component?.description || ""}`;
    const auto = data ? pickSources(data.files, text, { exam: true }).map((f) => f.path) : [];
    const chosen = manual[d.id];
    const sources = chosen ?? auto;
    const first = placeDate(d)?.getTime();
    const last = latestDate(d)?.getTime();
    const left = first !== undefined && last !== undefined ? countdown(first, last, d.due?.allDay ?? true, now) : null;
    const focus = data ? buildFocus({ files: data.files, text, opened: data.opened, reviews: data.reviews, cardCounts: data.cardCounts, exam: true }) : [];
    const shown = sources.slice(0, 3).map(fileName).join(", ") + (sources.length > 3 ? ` and ${sources.length - 3} more` : "");
    const toggle = (path: string, on: boolean) => setManual((all) => {
      const current = all[d.id] ?? auto;
      return { ...all, [d.id]: on ? [...new Set([...current, path])] : current.filter((p) => p !== path) };
    });
    const href = (target: "flashcards" | "generate") =>
      practiceHref(target, { module: key, sources, exam: d.title, auto: chosen === undefined });
    return <li key={d.id} className="exam-card">
      <div className="exam-card-head">
        <span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />
        <div className="exam-card-title">
          <h4>{d.title}</h4>
          <small>{d.module} / {d.due || d.window ? formatDue(d) : "date TBC"}</small>
        </div>
        <div className="exam-card-when">
          <span className={`exam-countdown${left?.urgent ? " urgent" : ""}`}>{left ? left.label : "Date TBC"}</span>
          <span className="weight">{weight === null ? "Weight not listed" : `${weight}% of module`}</span>
        </div>
      </div>
      {["needs-check", "conflict", "tbc"].includes(d.status) && <StatusPill status={d.status} deadline={d} />}
      <div className="exam-focus">
        <h5>What to focus on</h5>
        {!data ? <p className="quiet">Reading your module...</p> : focus.length
          ? <ul>{focus.map((item) => <li key={`${item.kind}:${item.label}`}>{item.label}{item.detail && <small>{item.detail}</small>}</li>)}</ul>
          : <p className="quiet">No study packs, flashcards or course files for this module yet.</p>}
      </div>
      <p className="exam-sources">
        {sources.length ? <>Using: {shown}</> : "Using: all of this module's files"}
        {" · "}
        <button type="button" className="text-link" aria-expanded={!!picking[d.id]} disabled={!data}
          onClick={() => setPicking((all) => ({ ...all, [d.id]: !all[d.id] }))}>Change</button>
      </p>
      {picking[d.id] && data && <fieldset className="exam-picker">
        <legend>Practise from these files</legend>
        {rankSources(data.files, text, { exam: true }).map((f) => <label key={f.path}>
          <input type="checkbox" checked={sources.includes(f.path)} onChange={(e) => toggle(f.path, e.target.checked)} />
          <span>{f.path}</span>
        </label>)}
        {!data.files.length && <p className="quiet">No course files found.</p>}
        {chosen !== undefined && <button type="button" className="text-link"
          onClick={() => setManual((all) => { const rest = { ...all }; delete rest[d.id]; return rest; })}>Use the automatic pick again</button>}
      </fieldset>}
      <div className="exam-actions">
        {/* A full page load: the flashcards and generate pages read their query string on mount. */}
        <a className="btn btn-primary" href={href("flashcards")} onClick={() => saveActiveModule(key)}>Practise for this</a>
        <a className="text-link" href={href("generate")} onClick={() => saveActiveModule(key)}>Build study packs from these files</a>
      </div>
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
      <div><p className="eyebrow">{year?.year || "Study Hub"}</p><h2>Assessments &amp; exam practice</h2></div>
    </header>
    <main className="calendar-main">
      {state === "loading" && <p className="calendar-message">Reading your assessments...</p>}
      {state === "unhosted" && <p className="calendar-message">Open Study Hub from the desktop app to see your assessments.</p>}
      {state === "error" && <p role="alert">Could not read your assessments. Reopen this page to try again.</p>}
      {error && <p role="alert">{error}</p>}
      <p role="status" className="quiet">{notice}</p>
      {state === "ready" && <>
        <section aria-labelledby="exams-title">
          <h3 id="exams-title" className="list-heading">Upcoming exams &amp; tests</h3>
          {exams.length
            ? <ul className="exam-cards">{exams.map(examCard)}</ul>
            : <p className="quiet">No exams, tests or quizzes coming up. They appear here with a countdown, what to focus on and a way to practise.</p>}
        </section>
        <section aria-labelledby="todo-title">
          <h3 id="todo-title" className="list-heading">Next deadlines</h3>
          {upcoming.length ? <ul className="deadline-rows">{upcoming.slice(0, COMPACT_DEADLINES).map(row)}</ul> : <p className="quiet">No upcoming deadlines.</p>}
          {upcoming.length > COMPACT_DEADLINES && <details><summary>{upcoming.length - COMPACT_DEADLINES} more deadlines</summary>
            <ul className="deadline-rows">{upcoming.slice(COMPACT_DEADLINES).map(row)}</ul></details>}
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
