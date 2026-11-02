"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  addDeadline, fetchAssessments, fetchDeadlines, fetchTree, getModuleProfile, loadModule, moduleCode, moduleColor,
  removeDeadline, saveActiveModule, setDeadlineDone, type Assessment, type Deadline, type LibraryTree, type LibraryYear,
} from "../../lib/library.ts";
import { isHosted } from "../../lib/ai/settings.ts";
import { parseCSV } from "../../lib/course-format.ts";
import {
  buildFocus, countdown, fileName, isExamLike, pickSources, practiceHref, rankSources,
  type ExamFile, type ReviewRecord,
} from "../../lib/exam-focus.ts";
import { loadStore } from "../../lib/practice.ts";
import { LEVEL_LABEL, buildReadiness, examReadiness, type ExamReadiness, type TopicReadiness } from "../../lib/readiness.ts";
import type { SubjectId } from "../../lib/subject-profiles.ts";
import { loadProgress, loadTutorials } from "../../lib/tutorial.ts";
import {
  KIND_TITLE, anchorId, bigCountdown, buildTimeline, cardsBar, exercisesBar, papersBar, stackSegments, topicTarget,
  weakestTopics, type BarView, type TimelineDot,
} from "../../lib/assessment-view.ts";
import { dayKey, formatDue, latestDate, placeDate, StatusPill, KIND_LABEL } from "../calendar/deadline-ui.tsx";

/** How many coursework and lab rows show before the rest fold away. */
const COMPACT_DEADLINES = 8;

/** What the hub has saved about one module, read once for its exam cards. */
type ModuleData = {
  files: ExamFile[];
  opened: Record<string, number>;
  reviews: Record<string, ReviewRecord>;
  /** Module-relative CSV path -> cards in it. */
  cardCounts: Record<string, number>;
  /** Every topic with its card, exercise and paper evidence. */
  topics: TopicReadiness[];
  subject: SubjectId;
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

/**
 * Everything one exam card needs from a module: its files, deck sizes, card
 * reviews, tutorial exercises and marks, practice attempts and subject, joined
 * once into per-topic readiness. A source that cannot be read leaves that kind
 * of evidence out; it never stops the page.
 */
async function readModule(tree: LibraryTree, year: string, folder: string): Promise<ModuleData> {
  const key = `${year}/${folder}`;
  const prefix = `${key}/`;
  const files = tree.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), modified: f.modified }));
  const saved = savedProgress(key);
  // Deck sizes need the CSV text.
  const local = await loadModule(tree, year, folder).catch(() => []);
  const [tutorials, profile] = await Promise.all([
    loadTutorials(key, true).catch(() => ({ version: 1 as const, sheets: [] })),
    getModuleProfile(key, local).catch(() => null),
  ]);
  const subject: SubjectId = profile?.profile ?? "general";
  const cardCounts = countCards(local);
  const topics = buildReadiness({
    files, cardCounts, reviews: saved.reviews, sheets: tutorials.sheets, progress: loadProgress(key), attempts: loadStore(key).attempts, subject,
  });
  return { files, ...saved, cardCounts, topics, subject };
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

/** One kind of evidence as a labelled bar, or a dash when the module has none of it. */
function ReadinessBar({ kind, bar }: { kind: keyof typeof KIND_TITLE; bar: BarView }) {
  const title = KIND_TITLE[kind];
  const empty = bar.value === null;
  return <div className="asx-bar-row">
    <span className="asx-bar-label">{title}</span>
    {empty
      ? <span className="asx-bar asx-bar-empty" role="img" aria-label={`${title}: nothing to practise from yet`} />
      : <span className={`asx-bar${bar.value! < 40 ? " low" : ""}`} role="meter" aria-label={title} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={bar.value!} aria-valuetext={bar.text}><span style={{ width: `${bar.value}%` }} /></span>}
    <span className="asx-bar-text">{bar.text}</span>
  </div>;
}

/** The three bars, kept separate on purpose: there is no combined score. */
function ReadinessBars({ readiness }: { readiness: ExamReadiness }) {
  return <div className="asx-bars">
    <ReadinessBar kind="cards" bar={cardsBar(readiness.cards)} />
    <ReadinessBar kind="exercises" bar={exercisesBar(readiness.exercises)} />
    <ReadinessBar kind="papers" bar={papersBar(readiness.papers)} />
  </div>;
}

/** A topic's three bars in miniature, each with its figure as text for a screen reader and a tooltip. */
function MiniBars({ topic }: { topic: TopicReadiness }) {
  const kinds = [
    ["cards", "C", cardsBar(topic.cards)],
    ["exercises", "E", exercisesBar(topic.exercises)],
    ["papers", "P", papersBar(topic.papers)],
  ] as const;
  return <span className="asx-mini">{kinds.map(([kind, letter, bar]) => {
    const text = `${KIND_TITLE[kind]}: ${bar.value === null ? "nothing yet" : bar.text}`;
    return <span key={kind} className={`asx-mini-bar${bar.value === null ? " asx-bar-empty" : bar.value < 40 ? " low" : ""}`} role="img" aria-label={text} title={text}>
      <span style={{ width: `${bar.value ?? 0}%` }} /><small aria-hidden="true">{letter}</small>
    </span>;
  })}</span>;
}

function LevelPill({ level }: { level: TopicReadiness["level"] }) {
  return <span className={`asx-level asx-level-${level}`}>{LEVEL_LABEL[level]}</span>;
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
  /** Per module (`<year>/<folder>`): what the exam cards need; absent until the module has been read. */
  const [moduleData, setModuleData] = useState<Record<string, ModuleData>>({});
  /** Exam card id -> the files the student ticked instead of the automatic pick. */
  const [manual, setManual] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!isHosted()) { queueMicrotask(() => setState("unhosted")); return; }
    let active = true;
    Promise.all([fetchTree(), fetchAssessments(), fetchDeadlines()]).then(([tree, components, items]) => {
      if (!active) return;
      const latest = [...tree.years].sort((a, b) => b.year.localeCompare(a.year))[0] || null;
      setYear(latest);
      setAssessments(components); setDeadlines(items); setNow(Date.now()); setState("ready");
      // Only modules with an exam, test or quiz coming up need their files and progress read.
      for (const folder of latest?.modules || []) {
        const code = moduleCode(folder);
        if (!items.some((d) => d.year === latest!.year && d.module === code && d.status !== "cancelled" && !d.done && isExamLike(d))) continue;
        const key = `${latest!.year}/${folder}`;
        readModule(tree, latest!.year, folder).catch((): ModuleData => {
          const prefix = `${key}/`;
          const files = tree.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), modified: f.modified }));
          return { files, ...savedProgress(key), cardCounts: {}, topics: [], subject: "general" };
        }).then((data) => { if (active) setModuleData((all) => ({ ...all, [key]: data })); });
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
  const upcomingIds = new Set(upcoming.map((d) => d.id));
  // Done items, and exams that have passed, fold away together.
  const done = items.filter((d) => d.done || (!upcomingIds.has(d.id) && isExamLike(d))).sort(order);
  const exams = upcoming.filter(isExamLike);
  const coursework = upcoming.filter((d) => !isExamLike(d));

  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save your change. Try again."); }
    finally { setBusy(false); }
  }
  function moduleFolder(d: Deadline) {
    return modules.find((m) => moduleCode(m) === d.module) || d.module;
  }
  function whenText(d: Deadline) {
    return d.due || d.window ? formatDue(d) : "date TBC";
  }
  /** Scrolls to a deadline's card or row and puts keyboard focus there. */
  function jumpTo(id: string) {
    const target = document.getElementById(anchorId(id));
    if (!target) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
    target.focus({ preventScroll: true });
  }
  function row(d: Deadline, anchor = false) {
    const folder = moduleFolder(d);
    return <li key={d.id} className="deadline-row assessment-deadline" {...(anchor ? { id: anchorId(d.id), tabIndex: -1 } : {})}>
      <input type="checkbox" checked={!!d.done} disabled={busy} aria-label={`Mark ${d.title} as ${d.done ? "not done" : "done"}`}
        onChange={(e) => { const checked = e.target.checked; void mutate(async () => {
          const updated = await setDeadlineDone(d.id, checked);
          setDeadlines((all) => all.map((item) => item.id === updated.id ? updated : item));
        }); }} />
      <span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />
      <span className="deadline-title">{d.title}<small>{d.module} / {whenText(d)}</small>
        {d.userNote && <small className="assessment-note">{d.userNote}</small>}</span>
      {d.weight !== undefined && <span className="weight">{d.weight}%</span>}
      {["needs-check", "conflict", "tbc"].includes(d.status) && <StatusPill status={d.status} deadline={d} />}
      {d.id.startsWith("user:") && <button className="text-link" disabled={busy} aria-label={`Remove ${d.title}`}
        onClick={() => void mutate(async () => { await removeDeadline(d.id); setDeadlines((all) => all.filter((item) => item.id !== d.id)); })}>Remove</button>}
    </li>;
  }

  /** Everything the hero and the exam card both show about one exam, test or quiz. */
  function examModel(d: Deadline) {
    const folder = moduleFolder(d);
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
    const readiness = data ? examReadiness(data.topics, text, data.subject) : null;
    const next = readiness?.next ?? null;
    const link = (target: "practice" | "generate", topic?: { view: NonNullable<typeof next>["view"]; topic: string; mode?: string }) =>
      practiceHref(target, { module: key, sources, exam: d.title, auto: chosen === undefined, ...(topic ?? { view: next?.view ?? "papers", topic: next?.topic, mode: next?.mode }) });
    return { d, folder, key, text, weight, data, sources, chosen, auto, left, readiness, next, link };
  }
  type ExamModel = ReturnType<typeof examModel>;

  /** The exam's one primary button. A full page load on purpose: Practice reads its query string on mount. */
  function primaryButton(m: ExamModel) {
    return <a className="btn btn-primary asx-primary" href={m.link("practice")} onClick={() => saveActiveModule(m.key)}>
      {m.next ? `Start: ${m.next.label}` : "Practise for this"}
    </a>;
  }
  function topicLink(m: ExamModel, topic: TopicReadiness) {
    const target = topicTarget(topic);
    return <a className="asx-topic-link" href={m.link("practice", { ...target, topic: topic.name })} onClick={() => saveActiveModule(m.key)}>{topic.name}</a>;
  }
  function loadingCard() {
    return <div className="asx-skeleton" aria-busy="true">
      <p className="quiet">Reading your module...</p>
      <span className="asx-skeleton-line" /><span className="asx-skeleton-line" /><span className="asx-skeleton-line short" />
    </div>;
  }
  function countdownPill(m: ExamModel) {
    return <span className={`exam-countdown${m.left?.urgent ? " urgent" : ""}`}>{m.left ? m.left.label : "Date TBC"}</span>;
  }
  const weightText = (m: ExamModel) => m.weight === null ? "Weight not listed" : `${m.weight}% of module`;

  function hero(d: Deadline) {
    const m = examModel(d);
    const big = m.left ? bigCountdown(m.left.label) : { big: "Date TBC", small: "" };
    const weakest = m.readiness ? weakestTopics(m.readiness.topics) : [];
    return <article className="asx-hero" aria-labelledby="hero-title">
      <div className={`asx-hero-count${m.left?.urgent ? " urgent" : ""}`}>
        <span className={`asx-big${big.small ? "" : " word"}`}>{big.big}</span>{big.small && <span className="asx-unit">{big.small}</span>}
      </div>
      <div className="asx-hero-main">
        <h4 id="hero-title"><span className="module-dot" style={{ background: moduleColor(modules, m.folder) }} aria-hidden="true" />{d.title}</h4>
        <p className="asx-meta">{d.module} / {whenText(d)} · {weightText(m)}</p>
        {["needs-check", "conflict", "tbc"].includes(d.status) && <StatusPill status={d.status} deadline={d} />}
        {m.readiness ? <>
          <ReadinessBars readiness={m.readiness} />
          {weakest.length > 0 && <div className="asx-weakest">
            <h5>Weakest topics</h5>
            <ul>{weakest.map((t) => <li key={t.key}>{topicLink(m, t)}<LevelPill level={t.level} /></li>)}</ul>
          </div>}
          <div className="asx-actions">{primaryButton(m)}</div>
        </> : loadingCard()}
      </div>
    </article>;
  }

  function examCard(d: Deadline) {
    const m = examModel(d);
    const { data, readiness } = m;
    const toggle = (path: string, on: boolean) => setManual((all) => {
      const current = all[d.id] ?? m.auto;
      return { ...all, [d.id]: on ? [...new Set([...current, path])] : current.filter((p) => p !== path) };
    });
    const unopened = data ? buildFocus({ files: data.files, text: m.text, opened: data.opened, reviews: data.reviews, cardCounts: data.cardCounts, exam: true }).find((i) => i.kind === "files") : undefined;
    const shown = m.sources.slice(0, 3).map(fileName).join(", ") + (m.sources.length > 3 ? ` and ${m.sources.length - 3} more` : "");
    return <li key={d.id} className="asx-card" id={anchorId(d.id)} tabIndex={-1}>
      <div className="exam-card-head">
        <span className="module-dot" style={{ background: moduleColor(modules, m.folder) }} aria-hidden="true" />
        <div className="exam-card-title">
          <h4>{d.title}</h4>
          <small>{d.module} / {whenText(d)}</small>
        </div>
        <div className="exam-card-when">
          {countdownPill(m)}
          <span className="weight">{weightText(m)}</span>
        </div>
      </div>
      {["needs-check", "conflict", "tbc"].includes(d.status) && <StatusPill status={d.status} deadline={d} />}
      {!data || !readiness ? loadingCard() : <>
        <ReadinessBars readiness={readiness} />
        {readiness.topics.length === 0 && <p className="quiet asx-empty-note">
          No study packs yet. <a className="text-link" href={m.link("generate")} onClick={() => saveActiveModule(m.key)}>Build them from this module&apos;s files</a>
        </p>}
        {unopened && <p className="quiet asx-note">{unopened.label}{unopened.detail && <small>{unopened.detail}</small>}</p>}
        {readiness.topics.length > 0 && <details className="asx-fold">
          <summary>Topics <span className="weight">{readiness.topics.length}</span></summary>
          <ul className="asx-topics">{readiness.topics.map((t) => <li key={t.key}>
            {topicLink(m, t)}<LevelPill level={t.level} /><MiniBars topic={t} />
          </li>)}</ul>
        </details>}
        <details className="asx-fold">
          <summary>Practice sources <span className="weight">{m.sources.length ? `${m.sources.length} ${m.sources.length === 1 ? "file" : "files"}` : "all files"}</span></summary>
          <p className="exam-sources">{m.sources.length ? <>Using: {shown}</> : "Using: all of this module's files"}</p>
          <fieldset className="exam-picker">
            <legend>Practise from these files</legend>
            {rankSources(data.files, m.text, { exam: true }).map((f) => <label key={f.path}>
              <input type="checkbox" checked={m.sources.includes(f.path)} onChange={(e) => toggle(f.path, e.target.checked)} />
              <span>{f.path}</span>
            </label>)}
            {!data.files.length && <p className="quiet">No course files found.</p>}
            {m.chosen !== undefined && <button type="button" className="text-link"
              onClick={() => setManual((all) => { const rest = { ...all }; delete rest[d.id]; return rest; })}>Use the automatic pick again</button>}
          </fieldset>
        </details>
        <div className="exam-actions">
          {primaryButton(m)}
          <a className="text-link" href={m.link("generate")} onClick={() => saveActiveModule(m.key)}>Build study packs from these files</a>
        </div>
      </>}
    </li>;
  }

  /** The next eight weeks as a strip: deadlines as dots in module colours, with the undated ones in their own slot. */
  function timeline() {
    const byId = new Map(upcoming.map((d) => [d.id, d]));
    const tl = buildTimeline(upcoming.map((d) => ({ id: d.id, at: dated(d) ? placeDate(d)?.getTime() ?? null : null })), now);
    const dot = (id: string, style?: CSSProperties) => {
      const d = byId.get(id)!;
      return <button key={id} type="button" className="asx-dot" style={{ ...style, ["--dot" as string]: moduleColor(modules, moduleFolder(d)) }}
        aria-label={`${d.title}, ${d.module}, ${whenText(d)}`} title={`${d.title} · ${d.module} · ${whenText(d)}`} onClick={() => jumpTo(id)} />;
    };
    const slot = (title: string, ids: string[]) => ids.length > 0 && <div className="asx-slot">
      <span className="asx-slot-title">{title}</span>
      <span className="asx-slot-dots">{ids.map((id) => dot(id))}</span>
    </div>;
    const shown = new Set([...tl.dots.map((x) => x.id), ...tl.later, ...tl.undated]);
    const legend = [...new Set([...shown].map((id) => moduleFolder(byId.get(id)!)))];
    return <div className="asx-timeline-wrap">
      <div className="asx-timeline" role="group" aria-label="Deadlines over the next 8 weeks">
        <div className="asx-track" style={{ ["--lanes" as string]: tl.lanes }}>
          {tl.ticks.map((t) => <span key={t.week} className="asx-tick" style={{ left: `${t.pos * 100}%` }}><small>{t.label}</small></span>)}
          {tl.dots.map((x: TimelineDot) => dot(x.id, { left: `${x.pos * 100}%`, top: `${x.lane * 24}px` }))}
        </div>
        {slot("Later", tl.later)}
        {slot("Date TBC", tl.undated)}
      </div>
      {legend.length > 0 && <p className="asx-legend">{legend.map((folder) => <span key={folder}>
        <span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />{moduleCode(folder)}</span>)}</p>}
      {!upcoming.length && <p className="quiet">No upcoming deadlines.</p>}
    </div>;
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
        <section aria-labelledby="next-title" className="asx-section">
          <h3 id="next-title" className="list-heading">Next up</h3>
          {exams.length
            ? hero(exams[0])
            : <div className="asx-empty"><strong>No exams coming up</strong>
              <p className="quiet">Exams, tests and quizzes appear here with a countdown, how ready you are for each kind of practice, and one button to start.</p></div>}
        </section>
        <section aria-labelledby="timeline-title" className="asx-section">
          <h3 id="timeline-title" className="list-heading">The next 8 weeks</h3>
          {timeline()}
        </section>
        {exams.length > 0 && <section aria-labelledby="exams-title" className="asx-section">
          <h3 id="exams-title" className="list-heading">Exams and tests</h3>
          <ul className="asx-cards">{exams.map(examCard)}</ul>
        </section>}
        <section aria-labelledby="todo-title" className="asx-section">
          <h3 id="todo-title" className="list-heading">Coursework and labs</h3>
          {coursework.length ? <ul className="deadline-rows">{coursework.slice(0, COMPACT_DEADLINES).map((d) => row(d, true))}</ul> : <p className="quiet">No coursework or labs coming up.</p>}
          {coursework.length > COMPACT_DEADLINES && <details><summary>{coursework.length - COMPACT_DEADLINES} more</summary>
            <ul className="deadline-rows">{coursework.slice(COMPACT_DEADLINES).map((d) => row(d, true))}</ul></details>}
          <details><summary>Done ({done.length})</summary><ul className="deadline-rows">{done.map((d) => row(d))}</ul></details>
        </section>
        {!modules.length && <p className="quiet">No modules yet. Your assessments appear here after your library syncs.</p>}
        {modules.length > 0 && <section aria-labelledby="modules-title" className="asx-section">
          <h3 id="modules-title" className="list-heading">By module</h3>
          {modules.map((folder) => {
            const code = moduleCode(folder);
            const components = assessments.filter((a) => a.module === code && a.year === year?.year && !a.resit);
            const moduleDeadlines = items.filter((d) => d.module === code).sort(order);
            const assignments = moduleDeadlines.map((d) => ({ deadline: d, component: componentFor(d, components) }));
            const other = assignments.filter((a) => a.component === -1);
            const stack = stackSegments(components.map((c) => ({ label: c.description, weight: c.weight })));
            return <details className="panel assessment-module" key={folder}>
              <summary><span className="module-dot" style={{ background: moduleColor(modules, folder) }} aria-hidden="true" />{folder}
                <span className="weight">{moduleDeadlines.length} {moduleDeadlines.length === 1 ? "deadline" : "deadlines"}</span></summary>
              {!components.length && <><p className="quiet">No assessment breakdown found on your course site yet</p>
                <p className="weight">Known deadline weights: {moduleDeadlines.reduce((sum, d) => sum + (d.weight || 0), 0)}%</p></>}
              {stack.segments.length > 0 && <div className="asx-stack" role="group" aria-label={`How ${folder} is assessed`}>
                {stack.segments.map((s, i) => <div key={`${s.label}-${i}`} className={`asx-seg asx-seg-${i % 4}${s.listed ? "" : " unlisted"}`}
                  style={{ flexBasis: `${s.share}%` }} title={`${s.label} ${s.percent}%`}>
                  <span>{s.compact ? <><span className="asx-sr">{s.label} </span>{s.percent}%</> : `${s.label} ${s.percent}%`}</span>
                </div>)}
              </div>}
              {components.map((c, index) => <div className="assessment-component" key={`${c.seq}-${index}`}>
                <h4>{c.description} {c.type && <small className="quiet">{c.type}</small>} <span className="weight">{c.weight === null ? "Weight TBC" : `${c.weight}%`}</span></h4>
                <ul className="deadline-rows">{assignments.filter((a) => a.component === index).map((a) => row(a.deadline))}</ul>
              </div>)}
              {other.length > 0 && <div className="assessment-component"><h4>Other deadlines</h4><ul className="deadline-rows">{other.map((a) => row(a.deadline))}</ul></div>}
            </details>;
          })}
        </section>}
        {modules.length > 0 && <details className="panel assessment-module asx-add">
          <summary>Add a deadline</summary>
          <p className="quiet">For marking and tasks your course site does not list as dates. Dates and times are in London time.</p>
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
        </details>}
      </>}
    </main>
  </div>;
}
