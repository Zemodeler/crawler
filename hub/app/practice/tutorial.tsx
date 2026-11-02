"use client";
/**
 * Tutorial sheets in Practice: the module's exercise sheets and official
 * solutions, converted once by the assistant, then practised exercise by
 * exercise beside the lecture slides they come from.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection } from "../../lib/ai/settings.ts";
import { ERROR_COPY, type AiError, type Progress } from "../../lib/ai/types.ts";
import type { LocalFile } from "../../lib/course-fs.ts";
import {
  exerciseKey,
  importLegacyProgress,
  lectureChoices,
  loadProgress,
  loadTutorials,
  pairSheets,
  saveProgress,
  saveTutorials,
  tally,
  upsertSheet,
  type SheetPair,
  type TutorialFile,
  type TutorialProgress,
  type TutorialSheet,
} from "../../lib/tutorial.ts";
import { exerciseKeysFor, topicsForSheets } from "../../lib/practice-view.ts";
import { convertSheet } from "../../lib/tutorial-generate.ts";
import { TutorialSession } from "./tutorial-session.tsx";

type Run = { title: string; keys: string[]; start: number };

type View = { name: "home" } | { name: "setup" } | { name: "session"; run: Run };

const CONVERT_TEXT: Record<Progress["phase"], string> = {
  connecting: "Connecting to your assistant…",
  streaming: "Reading the sheet and writing out the exercises…",
  validating: "Checking the slide links…",
  repairing: "Fixing the format…",
};

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

  useEffect(() => {
    let live = true;
    loadTutorials(course, hosted)
      .then((file) => {
        if (!live) return;
        fileRef.current = file;
        setData(file);
      })
      .catch((e) => live && setLoadError((e as Error).message || "Could not read your tutorial sheets."));
    return () => {
      live = false;
    };
  }, [course, hosted]);

  /** Changes the sheets from the latest copy and saves them, one save after another. */
  function update(change: (file: TutorialFile) => TutorialFile): Promise<void> {
    const next = change(fileRef.current || { version: 1, sheets: [] });
    fileRef.current = next;
    setData(next);
    const run = saving.current.then(async () => {
      try {
        await saveTutorials(course, hosted, fileRef.current!);
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
          moduleName={moduleName}
          files={files}
          converted={new Set(data.sheets.map((s) => s.id))}
          hasSheets={data.sheets.length > 0}
          onConverted={(sheet) => update((file) => upsertSheet(file, sheet))}
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
            {sheets.map((sheet) => (
              <article className="pr-paper" key={sheet.id}>
                <div>
                  <p className="eyebrow">
                    {sheet.label} · {plural(sheet.exercises.length, "exercise")}
                  </p>
                  <h3 className="tu-sheet-title">{sheet.title || sheet.label}</h3>
                  <p className="pr-meta">{marksSummary([sheet], progress)}</p>
                </div>
                <div className="pr-actions">
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
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- setup */

type RowStatus =
  | { state: "waiting" }
  | { state: "converting"; text: string }
  | { state: "done"; count: number; notes: string[] }
  | { state: "failed"; title: string; detail: string; connect: boolean };

function Setup({
  moduleName,
  files,
  converted,
  hasSheets,
  onConverted,
  onBack,
}: {
  moduleName: string;
  files: LocalFile[];
  converted: Set<string>;
  hasSheets: boolean;
  onConverted: (sheet: TutorialSheet) => Promise<void>;
  onBack: () => void;
}) {
  const pairs = useMemo(() => pairSheets(files), [files]);
  const lectures = useMemo(() => lectureChoices(files), [files]);
  const [lecture, setLecture] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string; connect?: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const name = (path?: string) => (path ? path.split("/").pop() || path : "");
  const lectureOf = (pair: SheetPair) => lecture[pair.id] ?? pair.lecturePath ?? "";
  const on = (pair: SheetPair) => ticked[pair.id] ?? !converted.has(pair.id);
  const chosen = pairs.filter(on);
  const setRow = (id: string, row: RowStatus) => setStatus((s) => ({ ...s, [id]: row }));

  async function convert(list: SheetPair[]) {
    setError(null);
    if (!list.length) return;
    if (!(await hasAnyConnection().catch(() => false))) {
      setError({ title: ERROR_COPY.no_credentials.title, detail: "Tutorial sheets are converted by your AI assistant.", connect: true });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus((s) => ({ ...s, ...Object.fromEntries(list.map((p) => [p.id, { state: "waiting" } as RowStatus])) }));
    try {
      const client = await createConfiguredAiClient();
      for (const pair of list) {
        if (controller.signal.aborted) break;
        setRow(pair.id, { state: "converting", text: CONVERT_TEXT.connecting });
        const target: SheetPair = { ...pair };
        if (lectureOf(pair)) target.lecturePath = lectureOf(pair);
        else delete target.lecturePath;
        try {
          const result = await convertSheet({
            client,
            module: moduleName,
            pair: target,
            files,
            signal: controller.signal,
            onProgress: (p) => setRow(pair.id, { state: "converting", text: CONVERT_TEXT[p.phase] }),
          });
          await onConverted(result.sheet);
          setRow(pair.id, {
            state: "done",
            count: result.sheet.exercises.length,
            notes: [
              result.dropped ? `${plural(result.dropped, "exercise")} left out because the answer could not be read.` : "",
              result.droppedRefs
                ? `${plural(result.droppedRefs, "slide link")} removed because ${result.droppedRefs === 1 ? "it" : "they"} did not match the slides.`
                : "",
              result.unread.length ? `Could not read ${result.unread.map((p) => name(p)).join(", ")}.` : "",
            ].filter(Boolean),
          });
        } catch (e) {
          const err = e as AiError;
          if (err.code === "aborted" || controller.signal.aborted) {
            setRow(pair.id, { state: "waiting" });
            break;
          }
          const copy = ERROR_COPY[err.code] || ERROR_COPY.unknown;
          setRow(pair.id, {
            state: "failed",
            title: copy.title,
            detail: [err.message, err.hint].filter(Boolean).join(" "),
            connect: err.code === "no_credentials" || err.code === "invalid_key",
          });
        }
      }
    } catch (e) {
      const err = e as AiError;
      const copy = ERROR_COPY[err.code] || ERROR_COPY.unknown;
      setError({ title: copy.title, detail: [err.message, err.hint].filter(Boolean).join(" ") });
    } finally {
      // After Cancel, rows that were never reached go back to having no status.
      if (controller.signal.aborted)
        setStatus((s) => Object.fromEntries(Object.entries(s).filter(([, row]) => row.state !== "waiting")));
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <div className="tu-setup">
      {hasSheets && (
        <button type="button" className="pr-quiet" disabled={busy} onClick={onBack}>
          ← Back to my sheets
        </button>
      )}
      <h1>Find my tutorial sheets</h1>
      <p className="pr-lede">
        Each solutions file is matched with its exercise sheet and the week&apos;s lecture by their names. Check the lecture is right, then
        convert the sheets you want. Your assistant reads each one and links every exercise to the slides it comes from.
      </p>

      {!files.length ? (
        <p className="pr-note">Loading this module&apos;s files…</p>
      ) : !pairs.length ? (
        <p className="pr-note">
          No tutorial solutions were found in this module. They are found by their names: a file with &ldquo;solutions&rdquo; or
          &ldquo;answers&rdquo; in its name, such as &ldquo;Exercise 3 solutions.pdf&rdquo;.
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
                const row = status[pair.id];
                return (
                  <tr key={pair.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Convert ${pair.label}`}
                        checked={on(pair)}
                        disabled={busy}
                        onChange={(e) => setTicked((t) => ({ ...t, [pair.id]: e.target.checked }))}
                      />
                    </td>
                    <td>
                      <b>{pair.label}</b>
                      {converted.has(pair.id) && <small className="tu-converted">Converted</small>}
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
                    <td className="tu-status" aria-live="polite">
                      {row?.state === "waiting" && <span className="pr-meta">Waiting</span>}
                      {row?.state === "converting" && <span className="tu-working">{row.text}</span>}
                      {row?.state === "done" && (
                        <>
                          <span className="tu-done">Done: {plural(row.count, "exercise")}</span>
                          {row.notes.map((note) => (
                            <small key={note}>{note}</small>
                          ))}
                        </>
                      )}
                      {row?.state === "failed" && (
                        <>
                          <span className="tu-failed">{row.title}</span>
                          {row.detail && <small>{row.detail}</small>}
                          {row.connect && <a href="/connect">Set up your AI connection</a>}
                          <button type="button" className="pr-quiet tu-small" disabled={busy} onClick={() => convert([pair])}>
                            Retry
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
          <button type="button" className="pr-primary" disabled={busy || !chosen.length} onClick={() => convert(chosen)}>
            {busy ? "Converting…" : `Convert ${plural(chosen.length, "sheet")}`}
          </button>
          {busy && (
            <button type="button" className="pr-quiet" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          )}
          <span aria-live="polite">
            {busy
              ? "One sheet at a time. Each can take a minute or two."
              : chosen.length
                ? "Each sheet, its solutions and its lecture will be sent to your assistant."
                : "Tick at least one sheet."}
          </span>
        </div>
      )}
    </div>
  );
}
