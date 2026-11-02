"use client";
/**
 * Tutorial sheets in Practice: the module's exercise sheets and official
 * solutions, converted once by the assistant, then practised exercise by
 * exercise beside the lecture slides they come from.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { hasAnyConnection } from "../../lib/ai/settings.ts";
import { ERROR_COPY } from "../../lib/ai/types.ts";
import { TUTORIALS_CHANGED, cancel, continueTask, isFinished, startTutorial, type Task } from "../../lib/background-tasks.ts";
import type { LocalFile } from "../../lib/course-fs.ts";
import {
  exerciseKey,
  importLegacyProgress,
  isPartial,
  lectureChoices,
  loadProgress,
  loadTutorials,
  addableFiles,
  pairFor,
  pairSheets,
  saveProgress,
  setupRows,
  saveTutorials,
  tally,
  type SheetPair,
  type TutorialFile,
  type TutorialProgress,
  type TutorialSheet,
} from "../../lib/tutorial.ts";
import { exerciseKeysFor, topicsForSheets } from "../../lib/practice-view.ts";
import { askToNotify, finishedLine, latestTask, liveLine, useNow, useTasks } from "../shell/activity.tsx";
import { TutorialSession } from "./tutorial-session.tsx";

type Run = { title: string; keys: string[]; start: number };

type View = { name: "home" } | { name: "setup" } | { name: "session"; run: Run };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 got it · 1 partly · 2 to do" for a list of sheets. */
function marksSummary(sheets: TutorialSheet[], progress: TutorialProgress): string {
  const t = tally(sheets, progress);
  if (!t.done) return "Not started";
  return [
    t.right ? `${t.right} got it` : "",
    t.partly ? `${t.partly} partly` : "",
    t.wrong ? `${t.wrong} missed` : "",
    t.total - t.done ? `${t.total - t.done} to do` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function Tutorials({
  course,
  hosted,
  files,
  topic = "",
  onOpenCards,
}: {
  course: string;
  hosted: boolean;
  files: LocalFile[];
  /** Show only the exercises on this topic, until the student asks for all of them. */
  topic?: string;
  /** Opens the Cards view, study tab, filtered to a topic. Without it there is no cross-link. */
  onOpenCards?: (topic: string) => void;
}) {
  const [data, setData] = useState<TutorialFile | null>(null);
  const [topicFilter, setTopicFilter] = useState(topic);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [view, setView] = useState<View>({ name: "home" });
  const [progress, setProgress] = useState<TutorialProgress>(() => loadProgress(course));
  const [progressWarning, setProgressWarning] = useState("");
  const [importNote, setImportNote] = useState("");
  const fileRef = useRef<TutorialFile | null>(null);
  const progressRef = useRef(progress);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const importInput = useRef<HTMLInputElement>(null);
  const moduleName = course.split("/").slice(1).join("/") || course;

  const tasks = useTasks();
  const now = useNow(tasks.some((t) => t.type === "tutorial" && t.course === course && !isFinished(t)));

  useEffect(() => {
    let live = true;
    const load = (first: boolean) =>
      loadTutorials(course, hosted)
        .then((file) => {
          if (!live) return;
          fileRef.current = file;
          setData(file);
        })
        .catch((e) => live && first && setLoadError((e as Error).message || "Could not read your tutorial sheets."));
    load(true);
    // The background runner saved a sheet, or part of one: show it without a reload.
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ course: string }>).detail?.course === course) void saving.current.then(() => load(false));
    };
    window.addEventListener(TUTORIALS_CHANGED, onChanged);
    return () => {
      live = false;
      window.removeEventListener(TUTORIALS_CHANGED, onChanged);
    };
  }, [course, hosted]);

  /**
   * Changes the sheets and saves them, one save after another. The change is
   * shown at once, then applied again to the copy on disk read just before
   * writing, so a sheet the background runner saved meanwhile is never lost.
   */
  function update(change: (file: TutorialFile) => TutorialFile): Promise<void> {
    const shown = change(fileRef.current || { version: 1, sheets: [] });
    fileRef.current = shown;
    setData(shown);
    const run = saving.current.then(async () => {
      try {
        const latest = await loadTutorials(course, hosted).catch(() => null);
        const next = latest ? change(latest) : fileRef.current!;
        await saveTutorials(course, hosted, next);
        fileRef.current = next;
        setData(next);
        setSaveError("");
      } catch (e) {
        setSaveError((e as Error).message || "Could not save your tutorial sheets.");
      }
    });
    saving.current = run;
    return run;
  }

  function updateProgress(change: (p: TutorialProgress) => TutorialProgress) {
    const next = change(progressRef.current);
    progressRef.current = next;
    setProgress(next);
    setProgressWarning(saveProgress(course, next) ? "" : "Your browser would not save your marks (storage may be full or blocked).");
  }

  async function importProgress(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !fileRef.current) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!backup || typeof backup !== "object" || Array.isArray(backup)) throw new Error("not an object");
      const { progress: merged, matched } = importLegacyProgress(backup, fileRef.current.sheets, progressRef.current);
      updateProgress(() => merged);
      setImportNote(
        matched
          ? `Imported ${plural(matched, "mark")} from your backup.`
          : "Nothing in that file matched these sheets. Convert the same weeks first, then import again.",
      );
    } catch {
      setImportNote("That file is not a progress backup. Choose the .json file the practice pages saved.");
    }
  }

  function start(title: string, keys: string[]) {
    if (!keys.length) return;
    const at = progressRef.current.current ? keys.indexOf(progressRef.current.current) : -1;
    setView({ name: "session", run: { title, keys, start: Math.max(0, at) } });
  }

  /** Picks a part-converted sheet up where it stopped. */
  function continueSheet(sheet: TutorialSheet) {
    const task = sheetTask(tasks, course, sheet.id);
    askToNotify();
    if (task && isFinished(task) && task.status !== "done") continueTask(task.id);
    else startTutorial(course, pairOf(sheet), sheet.label, hosted ? undefined : files);
  }

  const keysOf = (sheets: TutorialSheet[]) => sheets.flatMap((s) => s.exercises.map((e) => exerciseKey(s, e)));

  // Which topic each exercise is on, and whether that topic has cards: for the topic filter and the "revise the cards" link.
  const topics = useMemo(() => (data ? topicsForSheets(files, data.sheets, progress) : []), [files, data, progress]);

  if (loadError) return <p className="pr-error">{loadError}</p>;
  if (!data) return <p className="pr-meta">Loading your tutorial sheets…</p>;

  const banners = (
    <>
      {saveError && <p className="pr-error">{saveError}</p>}
      {progressWarning && <p className="pr-error">{progressWarning}</p>}
    </>
  );

  if (view.name === "session")
    return (
      <>
        {banners}
        <TutorialSession
          key={view.run.keys.join("|")}
          hosted={hosted}
          moduleName={moduleName}
          files={files}
          data={data}
          title={view.run.title}
          keys={view.run.keys}
          start={view.run.start}
          progress={progress}
          topics={topics}
          onRevise={onOpenCards}
          onProgress={updateProgress}
          onUpdate={update}
          onExit={() => setView({ name: "home" })}
        />
      </>
    );

  if (view.name === "setup")
    return (
      <>
        {banners}
        <Setup
          course={course}
          hosted={hosted}
          files={files}
          sheets={data.sheets}
          tasks={tasks}
          hasSheets={data.sheets.length > 0}
          onBack={() => setView({ name: "home" })}
        />
      </>
    );

  if (!data.sheets.length)
    return (
      <div className="pr-empty">
        <p className="eyebrow">Tutorial sheets</p>
        <h1>Work through your tutorial sheets</h1>
        <p>Your tutorial sheets with the official answers, linked to the lecture slides, explained step by step.</p>
        <button type="button" className="pr-primary" onClick={() => setView({ name: "setup" })}>
          Find my tutorial sheets
        </button>
      </div>
    );

  // With a topic filter, only that topic's exercises are listed, counted and practised.
  const topicKeys = topicFilter ? exerciseKeysFor(topics, topicFilter) : null;
  const scope = topicKeys && topicKeys.length ? new Set(topicKeys) : null;
  const shown = scope
    ? data.sheets
        .map((s) => ({ ...s, exercises: s.exercises.filter((e) => scope.has(exerciseKey(s, e))) }))
        .filter((s) => s.exercises.length)
    : data.sheets;
  const overall = tally(shown, progress);
  const missed = shown.flatMap((s) =>
    s.exercises.filter((e) => ["wrong", "partly"].includes(progress.marks[exerciseKey(s, e)] || "")).map((e) => exerciseKey(s, e)),
  );
  const weeks = new Map<string, TutorialSheet[]>();
  for (const sheet of shown) {
    const heading = sheet.week === null ? "Other sheets" : `Week ${sheet.week}`;
    weeks.set(heading, [...(weeks.get(heading) || []), sheet]);
  }
  const width = (n: number) => `${overall.total ? (n / overall.total) * 100 : 0}%`;

  return (
    <div className="tu-home">
      {banners}
      {topicFilter && (
        <p className="pr-note pv-filter" role="status">
          {scope
            ? `Showing only the ${plural(scope.size, "exercise")} on ${topicFilter}.`
            : files.length
              ? `No tutorial exercises are filed under ${topicFilter}, so every sheet is shown.`
              : `Finding the exercises on ${topicFilter}…`}{" "}
          {scope && (
            <button type="button" className="pv-link" onClick={() => setTopicFilter("")}>
              Show all sheets
            </button>
          )}
        </p>
      )}
      <div className="tu-overall">
        <div className="tu-overall-head">
          <h2>{scope ? topicFilter : "Your progress"}</h2>
          <span className="pr-meta">
            {overall.done} of {plural(overall.total, "exercise")} marked
          </span>
        </div>
        <div
          className="tu-bar"
          role="img"
          aria-label={`${overall.right} got it, ${overall.partly} partly, ${overall.wrong} missed, out of ${overall.total}`}
        >
          <i className="right" style={{ width: width(overall.right) }} />
          <i className="partly" style={{ width: width(overall.partly) }} />
          <i className="wrong" style={{ width: width(overall.wrong) }} />
        </div>
        <p className="tu-legend">
          <span className="right">{overall.right} got it</span>
          <span className="partly">{overall.partly} partly</span>
          <span className="wrong">{overall.wrong} missed</span>
          <span>{overall.total - overall.done} to do</span>
        </p>
        <div className="pr-actions">
          <button type="button" className="pr-primary" onClick={() => start(scope ? topicFilter : "Every sheet", keysOf(shown))}>
            {scope ? `Practise ${topicFilter}` : "Practise everything"}
          </button>
          <button type="button" className="pr-quiet" disabled={!missed.length} onClick={() => start("The ones you missed", missed)}>
            {missed.length ? `Review the ${plural(missed.length, "one")} I missed` : "Review the ones I missed"}
          </button>
          <button type="button" className="pr-quiet" onClick={() => setView({ name: "setup" })}>
            Add or update sheets
          </button>
          <button type="button" className="pr-quiet" onClick={() => importInput.current?.click()}>
            Import progress
          </button>
          <input ref={importInput} type="file" hidden accept=".json,application/json" onChange={importProgress} />
        </div>
        {importNote && <p className="pr-note">{importNote}</p>}
      </div>

      {[...weeks].map(([heading, sheets]) => (
        <section key={heading} className="tu-week">
          <h2>{heading}</h2>
          <div className="pr-list">
            {sheets.map((sheet) => {
              const task = sheet.pending ? sheetTask(tasks, course, sheet.id) : undefined;
              const working = task && !isFinished(task);
              return (
              <article className="pr-paper" key={sheet.id}>
                <div>
                  <p className="eyebrow">
                    {sheet.label} · {plural(sheet.exercises.length, "exercise")}
                  </p>
                  <h3 className="tu-sheet-title">{sheet.title || sheet.label}</h3>
                  <p className="pr-meta">{marksSummary([sheet], progress)}</p>
                  {sheet.pending && (
                    <p className="tu-partial-line">
                      Partly converted: {sheet.pending.done} of {sheet.pending.total} parts
                      {working && <span className="tu-working"> · {liveLine(task, tasks, now)}</span>}
                    </p>
                  )}
                </div>
                <div className="pr-actions">
                  {sheet.pending && !working && (
                    <button type="button" className="pr-quiet" onClick={() => continueSheet(sheet)}>
                      Continue
                    </button>
                  )}
                  <button
                    type="button"
                    className="pr-primary"
                    disabled={!sheet.exercises.length}
                    onClick={() => start(`${sheet.label}${sheet.title ? ` · ${sheet.title}` : ""}`, keysOf([sheet]))}
                  >
                    Practise
                  </button>
                </div>
              </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- setup */

/** The runner's latest task converting this sheet. */
const sheetTask = (tasks: Task[], course: string, id: string) =>
  latestTask(tasks, course, (t) => t.type === "tutorial" && t.spec.pair.id === id);

/** A converted (possibly partial) sheet's files, as the pair that converts it again. */
function pairOf(sheet: TutorialSheet): SheetPair {
  return {
    id: sheet.id,
    label: sheet.label,
    week: sheet.week,
    part: sheet.part,
    ...(sheet.sheetPath ? { sheetPath: sheet.sheetPath } : {}),
    solutionPath: sheet.solutionPath,
    ...(sheet.lecturePath ? { lecturePath: sheet.lecturePath } : {}),
  };
}

/** "Continue from part 3 of 5" for a sheet whose conversion stopped part-way. */
const partialLabel = (sheet: TutorialSheet | undefined) =>
  sheet?.pending ? `Continue from part ${sheet.pending.done + 1} of ${sheet.pending.total}` : "";

function Setup({
  course,
  hosted,
  files,
  sheets,
  tasks,
  hasSheets,
  onBack,
}: {
  course: string;
  hosted: boolean;
  files: LocalFile[];
  sheets: TutorialSheet[];
  tasks: Task[];
  hasSheets: boolean;
  onBack: () => void;
}) {
  const found = useMemo(() => pairSheets(files), [files]);
  const lectures = useMemo(() => lectureChoices(files), [files]);
  const converted = useMemo(() => new Set(sheets.filter((s) => !isPartial(s)).map((s) => s.id)), [sheets]);
  /** Files added by hand on this visit; once converted they come back from `sheets`. */
  const [added, setAdded] = useState<SheetPair[]>([]);
  // Sheets being converted that are not found by name come back as rows too, so leaving the page loses nothing.
  const fromTasks = useMemo(
    () => tasks.flatMap((t) => (t.type === "tutorial" && t.course === course ? [t.spec.pair] : [])),
    [tasks, course],
  );
  const pairs = useMemo(() => setupRows(found, sheets, [...added, ...fromTasks], files), [found, sheets, added, fromTasks, files]);
  const addable = useMemo(() => addableFiles(files, pairs), [files, pairs]);
  const [pick, setPick] = useState("");
  const [lecture, setLecture] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<{ title: string; detail?: string; connect?: boolean } | null>(null);

  const name = (path?: string) => (path ? path.split("/").pop() || path : "");
  const lectureOf = (pair: SheetPair) => lecture[pair.id] ?? pair.lecturePath ?? "";
  const taskOf = (pair: SheetPair) => sheetTask(tasks, course, pair.id);
  const inFlight = (pair: SheetPair) => {
    const task = taskOf(pair);
    return Boolean(task && !isFinished(task));
  };
  const on = (pair: SheetPair) => ticked[pair.id] ?? !converted.has(pair.id);
  const chosen = pairs.filter((p) => on(p) && !inFlight(p));
  const working = tasks.filter((t) => t.type === "tutorial" && t.course === course && !isFinished(t));
  const now = useNow(working.length > 0);
  const isAdded = (pair: SheetPair) => !converted.has(pair.id) && added.some((a) => a.id === pair.id);

  function addFile() {
    const file = addable.find((f) => f.path === pick);
    if (!file) return;
    const pair = pairFor(file, files);
    setAdded((list) => [...list.filter((a) => a.id !== pair.id), pair]);
    setTicked((t) => ({ ...t, [pair.id]: true }));
    setPick("");
  }

  function removeAdded(pair: SheetPair) {
    setAdded((list) => list.filter((a) => a.id !== pair.id));
    const drop = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== pair.id));
    setTicked(drop);
    setLecture(drop);
  }

  /** Readable files grouped by folder, for the "Add another file" list. */
  const addGroups = useMemo(() => {
    const groups = new Map<string, LocalFile[]>();
    for (const file of addable) {
      const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "Module folder";
      groups.set(folder, [...(groups.get(folder) || []), file]);
    }
    return [...groups];
  }, [addable]);

  /** Hands each sheet to the background runner, which carries on if the student leaves the page. */
  async function convert(list: SheetPair[]) {
    setError(null);
    if (!list.length) return;
    askToNotify();
    if (!(await hasAnyConnection().catch(() => false))) {
      setError({ title: ERROR_COPY.no_credentials.title, detail: "Tutorial sheets are converted by your AI assistant.", connect: true });
      return;
    }
    for (const pair of list) {
      const target: SheetPair = { ...pair };
      if (lectureOf(pair)) target.lecturePath = lectureOf(pair);
      else delete target.lecturePath;
      startTutorial(course, target, pair.label, hosted ? undefined : files);
    }
    const started = new Set(list.map((p) => p.id));
    setTicked((t) => Object.fromEntries(Object.entries(t).filter(([id]) => !started.has(id))));
  }

  function again(task: Task) {
    askToNotify();
    continueTask(task.id);
  }

  return (
    <div className="tu-setup">
      {hasSheets && (
        <button type="button" className="pr-quiet" onClick={onBack}>
          ← Back to my sheets
        </button>
      )}
      <h1>Find my tutorial sheets</h1>
      <p className="pr-lede">
        Each solutions file is matched with its exercise sheet and the week&apos;s lecture by their names, and extra exercise sets are
        listed too. Check the lecture is right, then convert the sheets you want. Your assistant reads each one and links every exercise
        to the slides it comes from. Missing a file? Add it below the table.
      </p>

      {!files.length ? (
        <p className="pr-note">Loading this module&apos;s files…</p>
      ) : !pairs.length ? (
        <p className="pr-note">
          No tutorial solutions were found in this module by name. They are found by a name with &ldquo;solutions&rdquo; or
          &ldquo;answers&rdquo; in it, such as &ldquo;Exercise 3 solutions.pdf&rdquo;, or one like &ldquo;Extra exercises.pdf&rdquo;. If yours
          are named differently, add them below.
        </p>
      ) : (
        <div className="tu-table-wrap">
          <table className="tu-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="tu-visually-hidden">Convert</span>
                </th>
                <th scope="col">Sheet</th>
                <th scope="col">Solutions</th>
                <th scope="col">Questions</th>
                <th scope="col">Lecture</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((pair) => {
                const task = taskOf(pair);
                const busy = inFlight(pair);
                const partial = sheets.find((s) => s.id === pair.id && isPartial(s));
                const err = task?.error;
                return (
                  <tr key={pair.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Convert ${pair.label}`}
                        checked={!busy && on(pair)}
                        disabled={busy}
                        onChange={(e) => setTicked((t) => ({ ...t, [pair.id]: e.target.checked }))}
                      />
                    </td>
                    <td>
                      <b>{pair.label}</b>
                      {converted.has(pair.id) && <small className="tu-converted">Converted</small>}
                      {partial?.pending && (
                        <small className="tu-converted tu-partial">
                          Partly converted: {partial.pending.done} of {partial.pending.total} parts
                        </small>
                      )}
                      {isAdded(pair) && (
                        <button
                          type="button"
                          className="pr-quiet tu-small tu-remove"
                          disabled={busy}
                          aria-label={`Remove ${pair.label}`}
                          onClick={() => removeAdded(pair)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                    <td className="tu-file">{name(pair.solutionPath)}</td>
                    <td className="tu-file">{pair.sheetPath ? name(pair.sheetPath) : "—"}</td>
                    <td>
                      <select
                        aria-label={`Lecture for ${pair.label}`}
                        value={lectureOf(pair)}
                        disabled={busy}
                        onChange={(e) => setLecture((l) => ({ ...l, [pair.id]: e.target.value }))}
                      >
                        <option value="">None</option>
                        {lectures.map((l) => (
                          <option key={l.path} value={l.path}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="tu-status">
                      {task && busy && <span className="tu-working">{liveLine(task, tasks, now)}</span>}
                      {task?.status === "done" && (
                        <>
                          <span className="tu-done">Done: {plural(task.result?.count ?? 0, "exercise")}</span>
                          {task.result?.notes.map((note) => (
                            <small key={note}>{note}</small>
                          ))}
                        </>
                      )}
                      {task && isFinished(task) && task.status !== "done" && (
                        <>
                          <span className={task.status === "failed" ? "tu-failed" : "pr-meta"}>{finishedLine(task)}</span>
                          {task.status === "failed" && err && <small>{[err.message, err.hint].filter(Boolean).join(" ")}</small>}
                          {(err?.code === "no_credentials" || err?.code === "invalid_key") && <a href="/connect">Set up your AI connection</a>}
                          <button type="button" className="pr-quiet tu-small" onClick={() => again(task)}>
                            {partialLabel(partial) || "Retry"}
                          </button>
                        </>
                      )}
                      {!task && partial && (
                        <button type="button" className="pr-quiet tu-small" onClick={() => convert([pair])}>
                          {partialLabel(partial)}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {files.length > 0 && addable.length > 0 && (
        <div className="tu-add">
          <label htmlFor="tu-add-file">Add another file</label>
          <p className="pr-meta">
            Any exercise file not listed above, such as extra exercises. Choose the file with the answers: it usually repeats the questions.
          </p>
          <div className="tu-add-row">
            <select id="tu-add-file" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a file…</option>
              {addGroups.map(([folder, list]) => (
                <optgroup key={folder} label={folder}>
                  {list.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="button" className="pr-quiet" disabled={!pick} onClick={addFile}>
              Add
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="pr-error" role="alert">
          <b>{error.title}</b>
          {error.detail && <p>{error.detail}</p>}
          {error.connect && <a href="/connect">Set up your AI connection</a>}
        </div>
      )}
      {pairs.length > 0 && (
        <div className="pr-actions">
          <button type="button" className="pr-primary" disabled={!chosen.length} onClick={() => convert(chosen)}>
            {`Convert ${plural(chosen.length, "sheet")}`}
          </button>
          {working.length > 0 && (
            <button type="button" className="pr-quiet" onClick={() => working.forEach((t) => cancel(t.id))}>
              Cancel
            </button>
          )}
          <span aria-live="polite">
            {working.length
              ? "You can leave this page: conversion carries on and you will be told when it is done."
              : chosen.length
                ? "Each sheet, its solutions and its lecture will be sent to your assistant."
                : "Tick at least one sheet."}
          </span>
        </div>
      )}
    </div>
  );
}
