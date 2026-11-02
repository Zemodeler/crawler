"use client";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { createConfiguredAiClient } from "../../lib/ai/provider.ts";
import { hasAnyConnection, isHosted } from "../../lib/ai/settings.ts";
import { ERROR_COPY, type AiError } from "../../lib/ai/types.ts";
import { PRACTICE_CHANGED, cancel, continueTask, isFinished, startPaper, type PaperTaskSpec, type Task } from "../../lib/background-tasks.ts";
import { collectDirectory, loadHandles, type LocalFile } from "../../lib/course-fs.ts";
import { fetchTree, loadModule } from "../../lib/library.ts";
import { saveOwnNote, uploadOwnFile } from "../../lib/own-files.ts";
import {
  KIND_LABELS,
  buildAttempt,
  gradeBand,
  loadStore,
  progression,
  retryPaper,
  saveStore,
  topicScores,
  type Answer,
  type Attempt,
  type Paper,
  type PracticeKind,
  type PracticeStore,
  type SelfMark,
} from "../../lib/practice.ts";
import { COUNT_LIMITS, aiPick, autoPick, candidateSources, sourceRole, type AiPick } from "../../lib/practice-generate.ts";
import { focusBrief } from "../../lib/practice-view.ts";
import { askToNotify, continueLabel, finishedLine, latestTask, liveLine, useNow, useTasks } from "../shell/activity.tsx";
import { Marker, Result, Taker } from "./practice-session.tsx";
import Tutorials from "./tutorial.tsx";

type View =
  | { name: "papers" }
  | { name: "create" }
  | { name: "progress" }
  | { name: "tutorials" }
  | { name: "take"; paper: Paper; retry: boolean }
  | { name: "mark"; paper: Paper; answers: Record<string, Answer>; seconds: number; retry: boolean }
  | { name: "result"; attempt: Attempt };

const KIND_HELP: Record<PracticeKind, string> = {
  exam: "A mixed paper of multiple-choice and written questions, in the style of your past papers.",
  mcq: "Multiple-choice only, marked instantly. Quick to do and good for covering a lot of ground.",
  exercise: "Short written exercises with worked solutions, which you mark yourself.",
};

const PICK_KEY = (course: string) => `studyhub:practice-pick:${course}`;

/** The assistant's last choice for this module, kept while the module's files stay the same. */
function savedPick(course: string, files: string): AiPick | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PICK_KEY(course)) || "null");
    return saved?.files === files && Array.isArray(saved.paths) ? { paths: saved.paths, reason: String(saved.reason || "") } : null;
  } catch {
    return null;
  }
}

function keepPick(course: string, files: string, pick: AiPick) {
  try {
    localStorage.setItem(PICK_KEY(course), JSON.stringify({ files, ...pick }));
  } catch {
    /* only a convenience */
  }
}

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const bandClass = (percent: number) => `band-${gradeBand(percent).short.replace(":", "")}`;

/** The runner's latest task writing (or continuing) this paper. */
const paperTask = (tasks: Task[], course: string, paperId: string) =>
  latestTask(tasks, course, (t) => t.type === "paper" && t.spec.paperId === paperId);

/** "Exam paper – ECS509U": how a paper being written is named in the activity list and notifications. */
const taskLabel = (kind: PracticeKind, course: string) => {
  const folder = course.split("/").slice(1).join("/") || course;
  return `${KIND_LABELS[kind]} – ${folder.split(" - ")[0]}`;
};

/** What opened the Papers view with something already chosen: the sources and exam from Assessments, or a topic from the dashboard. */
export type PapersLaunch = { sources: string[]; auto: boolean; exam: string; topic: string };

export default function Practice({
  course,
  initialView = "papers",
  launch,
  topic = "",
  onOpenCards,
}: {
  course: string;
  /** Which screen opens first: the paper list, the New paper screen, or the tutorial sheets. */
  initialView?: "papers" | "create" | "tutorials";
  /** For the New paper screen: files to tick, the exam they were picked for, and a topic to focus the brief on. */
  launch?: PapersLaunch | null;
  /** For the tutorial sheets: show only the exercises on this topic. */
  topic?: string;
  /** Opens the Cards view, study tab, filtered to a topic (the cross-link from an exercise). */
  onOpenCards?: (topic: string) => void;
}) {
  const hosted = isHosted();
  const [store, setStore] = useState<PracticeStore>(() => loadStore(course));
  const storeRef = useRef(store);
  const [view, setView] = useState<View>({ name: initialView } as View);
  const [warning, setWarning] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [extra, setExtra] = useState<LocalFile[]>([]);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const tasks = useTasks();
  const now = useNow(tasks.some((t) => t.type === "paper" && t.course === course && !isFinished(t)));
  /** The paper task started from New paper on this visit: when it is done, its paper opens in the list. */
  const [launched, setLaunched] = useState("");

  // The background runner saved a paper or a draft: read the store again.
  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ course: string }>).detail?.course !== course) return;
      const next = loadStore(course);
      storeRef.current = next;
      setStore(next);
    };
    window.addEventListener(PRACTICE_CHANGED, onChanged);
    return () => window.removeEventListener(PRACTICE_CHANGED, onChanged);
  }, [course]);

  // The paper started here is finished: show it in the list, with what was left out.
  useEffect(() => {
    const task = tasks.find((t) => t.id === launched);
    if (!task || task.status !== "done") return;
    const next = loadStore(course);
    queueMicrotask(() => {
      storeRef.current = next;
      setStore(next);
      setLaunched("");
      setNotice(task.result?.notes.join(" ") || "");
      setView((v) => (v.name === "create" ? { name: "papers" } : v));
    });
  }, [tasks, launched, course]);

  function commit(next: PracticeStore) {
    storeRef.current = next;
    setStore(next);
    setWarning(saveStore(course, next) ? "" : "Your browser would not save this practice history (storage may be full or blocked). Download your study packs so nothing is lost.");
  }

  // The module's files, for choosing what a paper is written from.
  useEffect(() => {
    let live = true;
    (async () => {
      if (hosted) {
        const [year, ...rest] = course.split("/");
        const loaded = await loadModule(await fetchTree(), year, rest.join("/"));
        if (live) setFiles(loaded);
        return;
      }
      const { handles } = await loadHandles();
      const handle = handles.find((h) => h.name === course);
      if ((await handle?.queryPermission?.({ mode: "read" })) === "granted" && live)
        setFiles(await collectDirectory(handle!));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [course, hosted, reload]);

  const sources = useMemo(() => candidateSources([...files, ...extra]), [files, extra]);

  function finalize(paper: Paper, answers: Record<string, Answer>, seconds: number, retry: boolean) {
    const attempt = buildAttempt(paper, answers, seconds, Date.now(), retry);
    commit({ ...storeRef.current, attempts: [...storeRef.current.attempts, attempt] });
    setView({ name: "result", attempt });
  }

  function addPaper(paper: Paper) {
    commit({ ...storeRef.current, papers: [paper, ...storeRef.current.papers.filter((p) => p.id !== paper.id)] });
  }

  function retryMissed(attempt: Attempt) {
    const paper = retryPaper(attempt);
    if (!paper) return;
    addPaper(paper);
    setView({ name: "take", paper, retry: true });
  }

  const priorAttempt = (attempt: Attempt) =>
    store.attempts
      .filter((a) => a.paperId === attempt.paperId && a.createdAt < attempt.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);

  if (view.name === "take")
    return (
      <Taker
        key={view.paper.id}
        paper={view.paper}
        onExit={() => setView({ name: "papers" })}
        onFinish={(answers, seconds) =>
          view.paper.questions.some((q) => q.type === "short")
            ? setView({ name: "mark", paper: view.paper, answers, seconds, retry: view.retry })
            : finalize(view.paper, answers, seconds, view.retry)
        }
      />
    );
  if (view.name === "mark")
    return (
      <Marker
        questions={view.paper.questions.filter((q) => q.type === "short")}
        answers={view.answers}
        onDone={(marks: Record<string, SelfMark>) => {
          const answers = { ...view.answers };
          for (const [id, self] of Object.entries(marks)) answers[id] = { ...answers[id], self };
          finalize(view.paper, answers, view.seconds, view.retry);
        }}
      />
    );
  if (view.name === "result") {
    const { attempt } = view;
    const paper = store.papers.find((p) => p.id === attempt.paperId);
    return (
      <Result
        attempt={attempt}
        previous={priorAttempt(attempt)}
        onSaveNote={hosted ? async (name, text) => (await saveOwnNote(course, { title: name, text })).path : undefined}
        onRetryMissed={() => retryMissed(attempt)}
        onRetake={() => setView({ name: "take", paper: paper || { ...attempt, id: attempt.paperId, brief: "", sources: [] }, retry: false })}
        onBack={() => setView({ name: "papers" })}
      />
    );
  }

  return (
    <section className="pr-page">
      {view.name !== "tutorials" && (
        <div className="pr-tabs" role="tablist" aria-label="Papers">
          {(
            [
              ["papers", "Papers"],
              ["create", "New paper"],
              ["progress", "Progress"],
            ] as const
          ).map(([name, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={view.name === name}
              className={view.name === name ? "active" : ""}
              key={name}
              onClick={() => setView({ name } as View)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {warning && <p className="pr-error">{warning}</p>}
      {notice && view.name === "papers" && <p className="pr-note">{notice}</p>}

      {view.name === "papers" && (
        <Papers
          course={course}
          store={store}
          tasks={tasks}
          now={now}
          onContinue={(paper) => {
            const task = paperTask(tasks, course, paper.id);
            askToNotify();
            if (task && isFinished(task) && task.status !== "done") continueTask(task.id);
            else
              startPaper(
                course,
                {
                  kind: paper.kind,
                  count: paper.draft?.target ?? paper.questions.length,
                  brief: paper.brief,
                  module: course.split("/").slice(1).join("/") || course,
                  sourcePaths: paper.sources,
                  paperId: paper.id,
                },
                taskLabel(paper.kind, course),
                hosted ? undefined : sources,
              );
          }}
          onCreate={() => setView({ name: "create" })}
          onStart={(paper) => setView({ name: "take", paper, retry: false })}
          onOpen={(attempt) => setView({ name: "result", attempt })}
          onDelete={(paper) => {
            if (!window.confirm(`Delete "${paper.title}"? Your past attempts on it are kept.`)) return;
            // A draft still being written would only save itself again.
            const task = paperTask(tasks, course, paper.id);
            if (task && !isFinished(task)) cancel(task.id);
            commit({ ...storeRef.current, papers: storeRef.current.papers.filter((p) => p.id !== paper.id) });
          }}
        />
      )}
      {view.name === "create" && (
        <Create
          course={course}
          hosted={hosted}
          sources={sources}
          tasks={tasks}
          now={now}
          launched={launched}
          onLaunch={(spec) => {
            const task = startPaper(course, spec, taskLabel(spec.kind, course), hosted ? undefined : sources);
            setLaunched(task.id);
          }}
          preselect={launch?.sources ?? []}
          exam={launch?.exam ?? ""}
          initialBrief={focusBrief(launch?.topic ?? "")}
          onUpload={async (list) => {
            for (const file of list) {
              if (hosted) await uploadOwnFile(course, file);
              else {
                const ext = file.name.split(".").pop()?.toLowerCase() || "";
                const path = `Course Materials/My Files/${file.name}`;
                const text = ext === "txt" || ext === "md" ? await file.text() : undefined;
                setExtra((e) => [
                  ...e.filter((f) => f.path !== path),
                  { path, name: file.name, ext, file, text, category: "Source materials", topic: "" },
                ]);
              }
            }
            if (hosted) setReload((n) => n + 1);
          }}
        />
      )}
      {view.name === "progress" && (
        <Progression attempts={store.attempts} onOpen={(attempt) => setView({ name: "result", attempt })} />
      )}
      {view.name === "tutorials" && <Tutorials key={course} course={course} hosted={hosted} files={files} topic={topic} onOpenCards={onOpenCards} />}
    </section>
  );
}

/* ---------------------------------------------------------------- papers */

function Papers({
  course,
  store,
  tasks,
  now,
  onContinue,
  onCreate,
  onStart,
  onOpen,
  onDelete,
}: {
  course: string;
  store: PracticeStore;
  tasks: Task[];
  now: number;
  /** Writes the rest of a draft paper. */
  onContinue: (paper: Paper) => void;
  onCreate: () => void;
  onStart: (paper: Paper) => void;
  onOpen: (attempt: Attempt) => void;
  onDelete: (paper: Paper) => void;
}) {
  const stats = progression(store.attempts);
  const latest = [...store.attempts].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!store.papers.length)
    return (
      <div className="pr-empty">
        <p className="eyebrow">Practice papers</p>
        <h1>Exam practice from your own course</h1>
        <p>
          Generate a paper in the style of your past papers, sit it, get a grade, and receive a study pack of exactly what you got wrong.
          Nothing is created until you ask for it.
        </p>
        <button type="button" className="pr-primary" onClick={onCreate}>
          Make my first paper
        </button>
        {store.attempts.length > 0 && <p className="pr-note">Your earlier attempts are kept under Progress.</p>}
      </div>
    );
  return (
    <>
      {stats && latest && (
        <div className="pr-summary">
          <div>
            <b>{stats.latest}%</b>
            <span>last attempt{stats.sinceLast !== null ? `, ${stats.sinceLast >= 0 ? "+" : ""}${stats.sinceLast} on the one before` : ""}</span>
          </div>
          <div>
            <b>{stats.average}%</b>
            <span>average over {stats.count}</span>
          </div>
          <div>
            <b>{stats.best}%</b>
            <span>best</span>
          </div>
          <button type="button" className="pr-quiet" onClick={() => onOpen(latest)}>
            Review last attempt
          </button>
        </div>
      )}
      <div className="pr-list">
        {store.papers.map((paper) => {
          const attempts = store.attempts.filter((a) => a.paperId === paper.id);
          const best = attempts.length ? Math.max(...attempts.map((a) => a.percent)) : null;
          const task = paper.draft ? paperTask(tasks, course, paper.id) : undefined;
          const working = task && !isFinished(task) ? task : undefined;
          return (
            <article className="pr-paper" key={paper.id}>
              <div>
                <p className="eyebrow">
                  {KIND_LABELS[paper.kind]} · {paper.questions.length} questions · {date(paper.createdAt)}
                </p>
                {paper.draft && (
                  <p className="pr-draft">
                    Draft: {paper.questions.length} of {paper.draft.target} questions
                    {working && <span className="pr-working"> · {liveLine(working, tasks, now)}</span>}
                  </p>
                )}
                <h2>{paper.title}</h2>
                {paper.brief && <p className="pr-brief">&ldquo;{paper.brief}&rdquo;</p>}
                <p className="pr-meta">
                  {attempts.length ? `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}, best ${best}%` : "Not attempted yet"}
                </p>
              </div>
              <div className="pr-actions">
                <button type="button" className="pr-primary" disabled={!paper.questions.length} onClick={() => onStart(paper)}>
                  {attempts.length ? "Retake" : "Start"}
                </button>
                {paper.draft && !working && (
                  <button type="button" className="pr-quiet" onClick={() => onContinue(paper)}>
                    {task && task.status !== "done" ? continueLabel(task) : "Continue"}
                  </button>
                )}
                <button type="button" className="pr-quiet" onClick={() => onDelete(paper)}>
                  Delete
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- create */

function Create({
  course,
  hosted,
  sources,
  preselect,
  exam,
  initialBrief,
  tasks,
  now,
  launched,
  onLaunch,
  onUpload,
}: {
  course: string;
  hosted: boolean;
  sources: LocalFile[];
  tasks: Task[];
  now: number;
  /** The paper task started here on this visit. */
  launched: string;
  /** Hands the paper to the background runner. */
  onLaunch: (spec: PaperTaskSpec) => void;
  /** Module-relative paths to tick when the screen opens (from a link on Assessments); empty means the usual picks. */
  preselect: string[];
  /** The assessment those files were picked for. */
  exam: string;
  initialBrief: string;
  onUpload: (files: File[]) => Promise<void>;
}) {
  const [kind, setKind] = useState<PracticeKind>("exam");
  const [count, setCount] = useState(COUNT_LIMITS.exam.fallback);
  const [brief, setBrief] = useState(initialBrief);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [keepPreselect, setKeepPreselect] = useState(true);
  const [error, setError] = useState<{ title: string; detail?: string; connect?: boolean } | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [aiChoice, setAiChoice] = useState<(AiPick & { files: string }) | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [chooseNote, setChooseNote] = useState("");
  const chooseAbort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const fileKey = useMemo(() => sources.map((f) => f.path).join("\n"), [sources]);
  const auto = useMemo(() => autoPick(sources), [sources]);
  const chosenByAi = aiChoice?.files === fileKey ? aiChoice : null;
  const base = useMemo(() => (chosenByAi ? new Set(chosenByAi.paths) : auto), [chosenByAi, auto]);
  // The files a link asked for, kept to those this module really has; the picks only apply until the student asks the assistant instead.
  const preselected = useMemo(() => {
    if (!keepPreselect) return null;
    const known = new Set(sources.map((f) => f.path));
    const valid = preselect.filter((path) => known.has(path));
    return valid.length ? new Set(valid) : null;
  }, [keepPreselect, preselect, sources]);
  const on = (file: LocalFile) => picked[file.path] ?? (preselected ? preselected.has(file.path) : base.has(file.path));

  /** Lets the assistant look at the module's files and tick the ones to write from. */
  async function choose(fresh: boolean) {
    chooseAbort.current?.abort();
    setChooseNote("");
    if (!sources.length) return;
    if (fresh) setKeepPreselect(false);
    const saved = fresh ? null : savedPick(course, fileKey);
    if (saved) {
      setAiChoice({ ...saved, files: fileKey });
      return;
    }
    if (!(await hasAnyConnection().catch(() => false))) {
      if (fresh) setChooseNote("Connect an AI assistant first, under Settings, so it can choose for you.");
      return;
    }
    const controller = new AbortController();
    chooseAbort.current = controller;
    setChoosing(true);
    try {
      const pick = await aiPick({
        client: await createConfiguredAiClient(),
        kind,
        brief,
        module: course.split("/").slice(1).join("/") || course,
        sources,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      keepPick(course, fileKey, pick);
      setAiChoice({ ...pick, files: fileKey });
      if (fresh) setPicked({});
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = e as AiError;
      setChooseNote(
        `Your assistant could not choose the files: ${[err.message, err.hint].filter(Boolean).join(" ")} The files below were ticked by their names instead.`,
      );
    } finally {
      if (chooseAbort.current === controller) {
        chooseAbort.current = null;
        setChoosing(false);
      }
    }
  }

  // Once per set of files: the assistant's choice replaces the by-name guess.
  // The short wait lets a module's files finish arriving before it is asked.
  useEffect(() => {
    // Files a link already picked are not second-guessed by the assistant.
    if (preselect.some((path) => sources.some((f) => f.path === path))) return;
    const timer = setTimeout(() => void choose(false), 400);
    return () => {
      clearTimeout(timer);
      chooseAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // The paper being written for this module: the one started here, else any still running (after a page change).
  const current =
    tasks.find((t) => t.id === launched) ?? latestTask(tasks, course, (t) => t.type === "paper" && !isFinished(t));
  const busy = Boolean(current && !isFinished(current));
  const stopped = current && current.id === launched && isFinished(current) && current.status !== "done" ? current : undefined;

  const chosen = sources.filter(on);
  const pastPapers = sources.filter((f) => sourceRole(f) === "past-paper");
  const limits = COUNT_LIMITS[kind];

  function chooseKind(next: PracticeKind) {
    setKind(next);
    setCount(COUNT_LIMITS[next].fallback);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const list = [...(event.target.files || [])];
    event.target.value = "";
    setUploadError("");
    try {
      await onUpload(list);
    } catch (e) {
      setUploadError((e as Error).message || "Could not add that file.");
    }
  }

  async function run() {
    setError(null);
    askToNotify();
    if (!(await hasAnyConnection().catch(() => false))) {
      setError({ title: ERROR_COPY.no_credentials.title, detail: "Practice papers are written by your AI assistant.", connect: true });
      return;
    }
    onLaunch({
      kind,
      count,
      brief,
      module: course.split("/").slice(1).join("/") || course,
      sourcePaths: chosen.map((f) => f.path),
    });
  }

  const groups = [
    { role: "past-paper", title: "Past papers", note: "Questions copy their style, never their content." },
    { role: "own", title: "Your own files", note: "Anything you added to this module." },
    { role: "material", title: "Other course material", note: "Lectures, seminars and notes." },
  ] as const;

  return (
    <div className="pr-create">
      <h1>New paper</h1>

      <h2>What kind?</h2>
      <div className="pr-kinds" role="radiogroup" aria-label="Paper type">
        {(Object.keys(KIND_LABELS) as PracticeKind[]).map((k) => (
          <button type="button" role="radio" aria-checked={kind === k} className={kind === k ? "picked" : ""} key={k} onClick={() => chooseKind(k)}>
            <b>{KIND_LABELS[k]}</b>
            <span>{KIND_HELP[k]}</span>
          </button>
        ))}
      </div>

      <div className="pr-row">
        <label>
          <span>Questions</span>
          <input
            type="number"
            min={limits.min}
            max={limits.max}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>
        <label className="grow">
          <span>Anything you want? (optional)</span>
          <textarea
            rows={2}
            maxLength={600}
            value={brief}
            placeholder="e.g. harder than last year, focus on hypothesis testing, include worked calculations"
            onChange={(e) => setBrief(e.target.value)}
          />
        </label>
      </div>

      <div className="pr-section-head">
        <h2>Write it from</h2>
        <div className="pr-actions">
          <button type="button" className="pr-quiet" disabled={choosing || busy || !sources.length} onClick={() => choose(true)}>
            {choosing ? "Choosing…" : "Let my assistant choose"}
          </button>
          <button type="button" className="pr-quiet" onClick={() => input.current?.click()}>
            Add a past paper or file
          </button>
        </div>
        <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.pptx,.txt,.md" onChange={upload} />
      </div>
      {uploadError && <p className="pr-error">{uploadError}</p>}
      {!pastPapers.length && (
        <p className="pr-note">
          No past paper found in this module. Add one (PDF, Word or text) so the questions match your real exam, or write from the course material.
          {hosted ? " Files you add are kept in this module's My Files." : " Files you add here last until you leave this page."}
        </p>
      )}
      {sources.length === 0 ? (
        <p className="pr-note">There are no readable files yet.</p>
      ) : (
        <p className="pr-meta" aria-live="polite">
          {choosing
            ? "Your assistant is looking through the files to choose what to write from…"
            : preselected
              ? `Ticked for ${exam || "this paper"}, from the files that match it. Tick or untick any to change it.`
              : chosenByAi
              ? `Chosen by your assistant${chosenByAi.reason ? `: ${chosenByAi.reason}` : "."} Tick or untick any to change it.`
              : "The most useful files are ticked for you, by their names. Tick or untick any to change what the paper is written from."}
        </p>
      )}
      {chooseNote && <p className="pr-note">{chooseNote}</p>}
      {groups.map((group) => {
        const list = sources.filter((f) => sourceRole(f) === group.role);
        if (!list.length) return null;
        return (
          <fieldset className="pr-sources" key={group.role}>
            <legend>
              {group.title} <small>{group.note}</small>
            </legend>
            {list.map((file) => (
              <label className="fc-check" key={file.path}>
                <input type="checkbox" checked={on(file)} onChange={(e) => setPicked((p) => ({ ...p, [file.path]: e.target.checked }))} />
                {file.name}
              </label>
            ))}
          </fieldset>
        );
      })}

      {error && (
        <div className="pr-error" role="alert">
          <b>{error.title}</b>
          {error.detail && <p>{error.detail}</p>}
          {error.connect && <a href="/connect">Set up your AI connection</a>}
        </div>
      )}
      {stopped && (
        <div className={stopped.status === "failed" ? "pr-error" : "pr-note"} role="alert">
          <b>{finishedLine(stopped)}</b>
          {stopped.status === "failed" && stopped.error && (
            <p>{[stopped.error.message, stopped.error.hint].filter(Boolean).join(" ")}</p>
          )}
          {(stopped.error?.code === "no_credentials" || stopped.error?.code === "invalid_key") && (
            <a href="/connect">Set up your AI connection</a>
          )}
          {stopped.type === "paper" && stopped.spec.paperId && <p>The questions written so far are kept as a draft under Papers.</p>}
          <button
            type="button"
            className="pr-quiet"
            onClick={() => {
              askToNotify();
              continueTask(stopped.id);
            }}
          >
            {continueLabel(stopped)}
          </button>
        </div>
      )}
      <div className="pr-actions">
        <button type="button" className="pr-primary" disabled={busy || !chosen.length} onClick={run}>
          {busy ? "Writing your paper…" : `Generate ${KIND_LABELS[kind].toLowerCase()}`}
        </button>
        {busy && current && (
          <button type="button" className="pr-quiet" onClick={() => cancel(current.id)}>
            Cancel
          </button>
        )}
        {busy && current && <span className="pr-working">{liveLine(current, tasks, now)}</span>}
        <span aria-live="polite">
          {busy
            ? "You can leave this page: it carries on and you will be told when it is done."
            : chosen.length
              ? `${chosen.length} file${chosen.length === 1 ? "" : "s"} will be sent to your assistant.`
              : "Choose at least one file."}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- progress */

function Progression({ attempts, onOpen }: { attempts: Attempt[]; onOpen: (attempt: Attempt) => void }) {
  const ordered = useMemo(() => [...attempts].sort((a, b) => a.createdAt - b.createdAt), [attempts]);
  const stats = progression(attempts);
  const topics = useMemo(() => topicScores(ordered), [ordered]);
  if (!stats)
    return (
      <div className="pr-empty">
        <h1>No attempts yet</h1>
        <p>Every paper you finish is kept here, so you can see your marks rise over time.</p>
      </div>
    );

  const W = 640;
  const H = 220;
  const pad = { l: 38, r: 12, t: 12, b: 24 };
  const x = (i: number) => (ordered.length === 1 ? (W + pad.l - pad.r) / 2 : pad.l + (i * (W - pad.l - pad.r)) / (ordered.length - 1));
  const y = (percent: number) => pad.t + ((100 - percent) * (H - pad.t - pad.b)) / 100;
  const line = ordered.map((a, i) => `${x(i)},${y(a.percent)}`).join(" ");

  return (
    <>
      <div className="pr-summary">
        <div>
          <b>{stats.count}</b>
          <span>attempts</span>
        </div>
        <div>
          <b>{stats.average}%</b>
          <span>average</span>
        </div>
        <div>
          <b>{stats.best}%</b>
          <span>best</span>
        </div>
        <div>
          <b>{stats.overall === null ? "–" : `${stats.overall > 0 ? "+" : ""}${stats.overall}`}</b>
          <span>{stats.overall === null ? "trend after 4 attempts" : "points since you started"}</span>
        </div>
      </div>

      <h2>Your marks over time</h2>
      <svg className="pr-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scores for ${stats.count} attempts, latest ${stats.latest} percent`}>
        {[0, 40, 50, 60, 70, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} className={g === 70 || g === 40 ? "pr-grid key" : "pr-grid"} />
            <text x={pad.l - 6} y={y(g) + 4} textAnchor="end">
              {g}
            </text>
          </g>
        ))}
        <polyline points={line} className="pr-line" />
        {ordered.map((a, i) => (
          <circle key={a.id} cx={x(i)} cy={y(a.percent)} r={5} className="pr-dot">
            <title>
              {a.title}: {a.percent}% on {date(a.createdAt)}
            </title>
          </circle>
        ))}
      </svg>
      <p className="pr-meta">Lines mark the 40% pass and the 70% first. Attempts are shown oldest to newest.</p>

      {topics.length > 1 && (
        <>
          <h2>Where to focus</h2>
          <div className="pr-topics">
            {topics.slice(0, 6).map((t) => (
              <div key={t.topic}>
                <span>{t.topic}</span>
                <div className="pr-bar" role="img" aria-label={`${t.topic}: ${t.percent}%`}>
                  <i style={{ width: `${t.percent}%` }} className={t.percent >= 70 ? "good" : t.percent >= 40 ? "mid" : "low"} />
                </div>
                <b>{t.percent}%</b>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Every attempt</h2>
      <div className="pr-attempts">
        {[...ordered].reverse().map((a, i, all) => {
          const before = all[i + 1];
          const delta = before ? a.percent - before.percent : null;
          return (
            <button type="button" key={a.id} onClick={() => onOpen(a)}>
              <span className={`pr-chip ${bandClass(a.percent)}`}>{a.percent}%</span>
              <span className="pr-attempt-title">
                {a.title}
                <small>
                  {KIND_LABELS[a.kind]} · {date(a.createdAt)} · {a.score}/{a.total} marks{a.retry ? " · retry of missed" : ""}
                </small>
              </span>
              <span className={`pr-delta ${delta === null ? "" : delta >= 0 ? "up" : "down"}`}>
                {delta === null ? "" : `${delta >= 0 ? "+" : ""}${delta}`}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
