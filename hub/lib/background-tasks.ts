/**
 * Long AI work that outlives the page it was started on.
 *
 * The navigation rail does full page loads, so nothing in memory survives a
 * page switch. Each task is therefore kept in localStorage, and every page
 * load calls resumeOnLoad(), which runs again whatever was left running.
 * Converters save their partial results after each batch and each model call
 * carries a stable job key, so a resumed task skips finished batches and
 * reattaches to the host job that was already running instead of paying for
 * it twice.
 *
 * Tasks run one at a time, first in first out.
 */

import { createConfiguredAiClient } from "./ai/provider.ts";
import { isHosted } from "./ai/settings.ts";
import { countItems } from "./ai/host.ts";
import { AiError, ERROR_COPY, type AiClient, type AiErrorCode, type GenerateRequest, type Progress, type ProgressBatch } from "./ai/types.ts";
import type { LocalFile } from "./course-fs.ts";
import { fetchTree, loadModule } from "./library.ts";
import { generatePaper } from "./practice-generate.ts";
import { loadStore, saveStore, type Paper, type PracticeKind, type PracticeStore } from "./practice.ts";
import { convertSheet } from "./tutorial-generate.ts";
import { loadTutorials, saveTutorials, upsertSheet, type SheetPair, type TutorialFile, type TutorialSheet } from "./tutorial.ts";

export const TASKS_KEY = "studyhub:ai-tasks";
export const TUTORIALS_CHANGED = "studyhub:tutorials-changed";
export const PRACTICE_CHANGED = "studyhub:practice-changed";

const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
const MAX_TASKS = 20;
const PERSIST_EVERY_MS = 1_000;

/* ------------------------------------------------------------------- types */

export type TaskType = "tutorial" | "paper";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export type TaskProgress = {
  phase: Progress["phase"];
  /** 1-based batch of a long run, and how many there are. */
  batch?: number;
  batches?: number;
  /** Exercises or questions written so far (saved ones plus those counted in the answer streaming in). */
  items?: number;
  /** Questions the paper should have; unknown for a tutorial sheet. */
  itemsTotal?: number;
  /** Characters of the current model answer so far. */
  chars?: number;
  /** When this run of the task began (ms). */
  startedAt: number;
};

export type TaskError = { code: AiErrorCode; title?: string; message: string; hint?: string };

export type TutorialTaskSpec = { pair: SheetPair };
export type PaperTaskSpec = {
  kind: PracticeKind;
  count: number;
  brief: string;
  /** The module's display name, for the prompt. */
  module: string;
  /** Module-relative paths of the source files. */
  sourcePaths: string[];
  /** The paper being written: set once its first draft is saved, or given to continue a draft. */
  paperId?: string;
};

type TaskBase = {
  id: string;
  /** "year/module". */
  course: string;
  label: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  progress?: TaskProgress;
  error?: TaskError;
  /** count: exercises or questions in the result; notes: what was left out, in plain English. */
  result?: { count: number; notes: string[] };
  /** How many times the task was retried; part of its job keys so a retry never reuses a finished job. */
  attempt?: number;
};

export type Task = (TaskBase & { type: "tutorial"; spec: TutorialTaskSpec }) | (TaskBase & { type: "paper"; spec: PaperTaskSpec });

export type TaskListener = (tasks: Task[]) => void;

/** What the runner needs from its surroundings; every field has a browser default. */
export type TaskDeps = {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now: () => number;
  hosted: () => boolean;
  createClient: () => Promise<AiClient>;
  /** Every file of a module ("year/module"). */
  loadFiles: (course: string) => Promise<LocalFile[]>;
  loadTutorials: (course: string, hosted: boolean) => Promise<TutorialFile>;
  saveTutorials: (course: string, hosted: boolean, file: TutorialFile) => Promise<void>;
  loadStore: (course: string) => PracticeStore;
  saveStore: (course: string, store: PracticeStore) => boolean;
  convertSheet: typeof convertSheet;
  generatePaper: typeof generatePaper;
  /** Fires a window event such as TUTORIALS_CHANGED. */
  dispatch: (name: string, detail: { course: string }) => void;
  newId: () => string;
};

export type TaskRunner = ReturnType<typeof createTaskRunner>;

/* ----------------------------------------------------------------- helpers */

const FINISHED = new Set<TaskStatus>(["done", "failed", "cancelled", "interrupted"]);
export const isFinished = (task: Pick<Task, "status">) => FINISHED.has(task.status);

const moduleName = (course: string) => course.split("/").slice(1).join("/") || course;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultDispatch(name: string, detail: { course: string }) {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* no window */
  }
}

async function defaultLoadFiles(course: string): Promise<LocalFile[]> {
  const [year, ...rest] = course.split("/");
  return loadModule(await fetchTree(), year, rest.join("/"));
}

function isTask(value: unknown): value is Task {
  const task = value as Task | null;
  return (
    Boolean(task) &&
    typeof task!.id === "string" &&
    (task!.type === "tutorial" || task!.type === "paper") &&
    typeof task!.course === "string" &&
    typeof task!.status === "string" &&
    typeof task!.createdAt === "number" &&
    Boolean(task!.spec)
  );
}

function toTaskError(error: unknown): TaskError {
  const code: AiErrorCode = error instanceof AiError && ERROR_COPY[error.code] ? error.code : "unknown";
  const message = (error as Error)?.message || ERROR_COPY.unknown.title;
  const hint = (error as AiError)?.hint;
  return { code, title: ERROR_COPY[code].title, message, ...(hint ? { hint } : {}) };
}

/* ------------------------------------------------------------------ runner */

export function createTaskRunner(overrides: Partial<TaskDeps> = {}) {
  const deps: TaskDeps = {
    storage: overrides.storage !== undefined ? overrides.storage : defaultStorage(),
    now: Date.now,
    hosted: isHosted,
    createClient: createConfiguredAiClient,
    loadFiles: defaultLoadFiles,
    loadTutorials,
    saveTutorials,
    loadStore,
    saveStore,
    convertSheet,
    generatePaper,
    dispatch: defaultDispatch,
    newId: () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };

  const listeners = new Set<TaskListener>();
  /** Files handed to start*() in browser-only mode, which has no library to load them from. Never persisted. */
  const filesFor = new Map<string, LocalFile[]>();
  let active: { id: string; controller: AbortController } | null = null;
  let resumed = false;
  let lastPersist = 0;
  let idle: Promise<void> = Promise.resolve();

  function read(): Task[] {
    try {
      const parsed = JSON.parse(deps.storage?.getItem(TASKS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(isTask) : [];
    } catch {
      return [];
    }
  }

  /** Drops finished tasks older than a day, then the oldest finished ones beyond MAX_TASKS. */
  function prune(list: Task[]): Task[] {
    const cutoff = deps.now() - KEEP_FINISHED_MS;
    let kept = list.filter((t) => !isFinished(t) || (t.endedAt ?? t.createdAt) >= cutoff);
    while (kept.length > MAX_TASKS) {
      const finished = kept.filter(isFinished).sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt))[0];
      if (!finished) break;
      kept = kept.filter((t) => t !== finished);
    }
    return kept;
  }

  let tasks: Task[] = prune(read());
  // Browser-only mode has no host job to come back to: whatever a previous page left running is lost.
  if (!deps.hosted() && tasks.some((t) => !isFinished(t))) {
    tasks = tasks.map((t) => (isFinished(t) ? t : interrupted(t)));
    write();
  }

  function interrupted(task: Task): Task {
    return {
      ...task,
      status: "interrupted",
      endedAt: deps.now(),
      error: {
        code: "unknown",
        title: ERROR_COPY.unknown.title,
        message: "The page was closed or reloaded while this was running.",
        hint: "Continue to pick up where it stopped.",
      },
    };
  }

  function write() {
    tasks = prune(tasks);
    lastPersist = deps.now();
    try {
      deps.storage?.setItem(TASKS_KEY, JSON.stringify(tasks));
    } catch {
      /* storage full or blocked: the tasks still run in this page */
    }
  }

  function notify() {
    const snapshot = list();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* a listener's problem is not the runner's */
      }
    }
  }

  function change(id: string, patch: (task: Task) => Task, persist: "now" | "throttled" = "now") {
    tasks = tasks.map((t) => (t.id === id ? patch(t) : t));
    if (persist === "now" || deps.now() - lastPersist >= PERSIST_EVERY_MS) write();
    notify();
  }

  const find = (id: string) => tasks.find((t) => t.id === id);

  function list(): Task[] {
    return structuredClone(tasks);
  }

  function subscribe(listener: TaskListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function add(task: Task, files?: LocalFile[]): Task {
    if (files) filesFor.set(task.id, files);
    tasks = [...tasks, task];
    write();
    notify();
    pump();
    return structuredClone(task);
  }

  function base(course: string, label: string): Omit<TaskBase, "status"> & { status: "queued" } {
    return { id: deps.newId(), course, label, status: "queued", createdAt: deps.now() };
  }

  /** `files` is needed only in browser-only mode, where the runner cannot load the module itself. */
  function startTutorial(course: string, pair: SheetPair, label: string, files?: LocalFile[]): Task {
    return add({ ...base(course, label), type: "tutorial", spec: { pair: { ...pair } } }, files);
  }

  function startPaper(course: string, spec: PaperTaskSpec, label: string, files?: LocalFile[]): Task {
    return add({ ...base(course, label), type: "paper", spec: { ...spec, sourcePaths: [...spec.sourcePaths] } }, files);
  }

  function cancel(id: string) {
    const task = find(id);
    if (!task || isFinished(task)) return;
    if (active?.id === id) active.controller.abort();
    change(id, (t) => ({ ...t, status: "cancelled", endedAt: deps.now() }));
  }

  /** Runs a failed, cancelled or interrupted task again; it keeps whatever batches were saved. */
  function retry(id: string) {
    const task = find(id);
    if (!task || !isFinished(task) || task.status === "done") return;
    const again: Task = { ...task, status: "queued", attempt: (task.attempt ?? 0) + 1 };
    delete again.error;
    delete again.endedAt;
    delete again.progress;
    // To the back of the queue.
    tasks = [...tasks.filter((t) => t.id !== id), again];
    write();
    notify();
    pump();
  }

  function dismiss(id: string) {
    if (!find(id)) return;
    cancel(id);
    tasks = tasks.filter((t) => t.id !== id);
    filesFor.delete(id);
    write();
    notify();
  }

  /** Once per page load: runs again whatever an earlier page left queued or running. */
  function resumeOnLoad() {
    if (resumed) return;
    resumed = true;
    if (!deps.hosted()) {
      if (tasks.some((t) => !isFinished(t) && t.id !== active?.id && !filesFor.has(t.id))) {
        tasks = tasks.map((t) => (isFinished(t) || t.id === active?.id || filesFor.has(t.id) ? t : interrupted(t)));
        write();
        notify();
      }
      return;
    }
    let changed = false;
    tasks = tasks.map((t) => {
      if (t.status !== "running" || t.id === active?.id) return t;
      changed = true;
      return { ...t, status: "queued" };
    });
    if (changed) {
      write();
      notify();
    }
    pump();
  }

  function pump() {
    if (active) return;
    const next = tasks.find((t) => t.status === "queued");
    if (!next) return;
    const controller = new AbortController();
    active = { id: next.id, controller };
    idle = run(next, controller.signal).finally(() => {
      active = null;
      pump();
    });
  }

  /** Resolves once nothing is running (for tests). */
  async function whenIdle(): Promise<void> {
    while (active) await idle;
  }

  async function run(task: Task, signal: AbortSignal): Promise<void> {
    const startedAt = deps.now();
    change(task.id, (t) => ({ ...t, status: "running", startedAt: t.startedAt ?? startedAt, progress: { phase: "connecting", startedAt } }));

    // What the generators have saved so far, and the batch the latest progress belongs to.
    let savedItems = 0;
    let itemsTotal: number | undefined;
    let batch: ProgressBatch | undefined;
    const field = task.type === "tutorial" ? "number" : "prompt";

    const onProgress = (progress: Progress) => {
      batch = progress.batch;
      if (signal.aborted) return;
      change(
        task.id,
        (t) => {
          const before = t.progress;
          const sameBatch = before?.batch === progress.batch?.index;
          const chars = progress.phase === "streaming" ? progress.chars : sameBatch ? before?.chars : undefined;
          const counted = progress.phase === "streaming" && progress.text !== undefined ? countItems(progress.text, field) : null;
          const items = counted !== null ? savedItems + counted : sameBatch ? Math.max(savedItems, before?.items ?? 0) : savedItems;
          return {
            ...t,
            progress: {
              phase: progress.phase,
              ...(progress.batch ? { batch: progress.batch.index, batches: progress.batch.total } : {}),
              items: itemsTotal ? Math.min(items, itemsTotal) : items,
              ...(itemsTotal ? { itemsTotal } : {}),
              ...(chars !== undefined ? { chars } : {}),
              startedAt,
            },
          };
        },
        progress.phase === "streaming" ? "throttled" : "now",
      );
    };

    const run = task.attempt ? `${task.id}.${task.attempt}` : task.id;
    try {
      const client = keyedClient(await deps.createClient(), {
        key: (index) => `${run}:b${index}`,
        label: (b) => (b && b.total > 1 ? `${task.label} (part ${b.index} of ${b.total})` : task.label),
        batch: () => batch,
        reset: () => {
          batch = undefined;
        },
      });
      const hosted = deps.hosted();
      const files = filesFor.get(task.id) ?? (hosted ? await deps.loadFiles(task.course) : null);
      if (!files)
        throw new AiError("unknown", "The module's files are no longer open in this page.", {
          hint: "Open the module again and start this once more.",
        });
      if (signal.aborted) throw new AiError("aborted", "Cancelled.");

      if (task.type === "tutorial") {
        const { pair } = task.spec;
        const saveSheet = async (sheet: TutorialSheet) => {
          const latest = await deps.loadTutorials(task.course, hosted);
          await deps.saveTutorials(task.course, hosted, upsertSheet(latest, sheet));
          deps.dispatch(TUTORIALS_CHANGED, { course: task.course });
        };
        const existing = (await deps.loadTutorials(task.course, hosted)).sheets.find((s) => s.id === pair.id);
        const resume = existing?.pending ? existing : undefined;
        savedItems = resume?.exercises.length ?? 0;
        const result = await deps.convertSheet({
          client,
          module: moduleName(task.course),
          pair,
          files,
          signal,
          onProgress,
          resume,
          onBatch: async (sheet, state) => {
            if (signal.aborted) return;
            await saveSheet(sheet);
            savedItems = state.exercises;
          },
        });
        if (signal.aborted) throw new AiError("aborted", "Cancelled.");
        await saveSheet(result.sheet);
        const notes = [
          result.dropped ? `${plural(result.dropped, "exercise")} left out because the answer could not be read.` : "",
          result.droppedRefs
            ? `${plural(result.droppedRefs, "slide link")} removed because ${result.droppedRefs === 1 ? "it" : "they"} did not match the slides.`
            : "",
          result.unread.length ? `Could not read ${result.unread.map((p) => p.split("/").pop()).join(", ")}.` : "",
        ].filter(Boolean);
        finish(task.id, { count: result.sheet.exercises.length, notes });
      } else {
        const spec = task.spec;
        const savePaper = (paper: Paper) => {
          const latest = deps.loadStore(task.course);
          deps.saveStore(task.course, { ...latest, papers: [paper, ...latest.papers.filter((p) => p.id !== paper.id)] });
          deps.dispatch(PRACTICE_CHANGED, { course: task.course });
        };
        const rememberPaper = (paperId: string) =>
          change(task.id, (t) => (t.type === "paper" ? { ...t, spec: { ...t.spec, paperId } } : t));
        const resume = spec.paperId ? deps.loadStore(task.course).papers.find((p) => p.id === spec.paperId && p.draft) : undefined;
        savedItems = resume?.questions.length ?? 0;
        itemsTotal = resume?.draft?.target ?? spec.count;
        const wanted = new Set(spec.sourcePaths);
        const result = await deps.generatePaper({
          client,
          kind: spec.kind,
          count: spec.count,
          brief: spec.brief,
          module: spec.module,
          sources: files.filter((f) => wanted.has(f.path)),
          signal,
          onProgress,
          resume,
          onBatch: async (paper, state) => {
            if (signal.aborted) return;
            savePaper(paper);
            savedItems = state.questions;
            if (spec.paperId !== paper.id) {
              spec.paperId = paper.id;
              rememberPaper(paper.id);
            }
          },
        });
        if (signal.aborted) throw new AiError("aborted", "Cancelled.");
        savePaper(result.paper);
        rememberPaper(result.paper.id);
        const { dropped, unread } = result;
        const notes = [
          dropped ? `${dropped} generated question${dropped === 1 ? " was" : "s were"} left out because the answer key could not be checked.` : "",
          unread.length
            ? `${unread.length} file${unread.length === 1 ? " was" : "s were"} too large or had no readable text and ${unread.length === 1 ? "was" : "were"} not used.`
            : "",
        ].filter(Boolean);
        finish(task.id, { count: result.paper.questions.length, notes });
      }
    } catch (error) {
      if (signal.aborted || (error instanceof AiError && error.code === "aborted")) {
        change(task.id, (t) => (t.status === "cancelled" ? t : { ...t, status: "cancelled", endedAt: deps.now() }));
      } else {
        const failure = toTaskError(error);
        change(task.id, (t) => ({ ...t, status: "failed", endedAt: deps.now(), error: failure }));
      }
    } finally {
      filesFor.delete(task.id);
    }
  }

  function finish(id: string, result: { count: number; notes: string[] }) {
    change(id, (t) => {
      const done: Task = { ...t, status: "done", endedAt: deps.now(), result };
      delete done.error;
      return done;
    });
  }

  return {
    list,
    subscribe,
    startTutorial,
    startPaper,
    cancel,
    retry,
    continueTask: retry,
    dismiss,
    resumeOnLoad,
    whenIdle,
  };
}

/**
 * The generators call client.generate themselves; this gives each call a job
 * key from the batch it belongs to. They tag every progress event with the
 * batch, so one synchronous "connecting" event, sent before delegating, says
 * which batch this call is for.
 */
function keyedClient(
  client: AiClient,
  keys: {
    key: (batchIndex: number) => string;
    label: (batch: ProgressBatch | undefined) => string;
    batch: () => ProgressBatch | undefined;
    reset: () => void;
  },
): AiClient {
  return {
    target: client.target,
    probe: (signal) => client.probe(signal),
    chat: (request) => client.chat(request),
    chatCapabilities: () => client.chatCapabilities(),
    listModels: (signal) => client.listModels(signal),
    generate<T>(request: GenerateRequest) {
      keys.reset();
      request.onProgress?.({ phase: "connecting" });
      const batch = keys.batch();
      return client.generate<T>({
        ...request,
        jobKey: request.jobKey ?? keys.key(batch?.index ?? 1),
        label: request.label ?? keys.label(batch),
      });
    },
  };
}

/* --------------------------------------------------------------- singleton */

let instance: TaskRunner | null = null;
const runner = () => (instance ??= createTaskRunner());

/** Every task, in queue order (oldest first). */
export const list = () => runner().list();
/** Called with the whole list after every change; returns the unsubscribe function. */
export const subscribe = (listener: TaskListener) => runner().subscribe(listener);
/** Queues converting one tutorial sheet (with its chosen lecturePath). */
export const startTutorial = (course: string, pair: SheetPair, label: string, files?: LocalFile[]) =>
  runner().startTutorial(course, pair, label, files);
/** Queues writing one practice paper. */
export const startPaper = (course: string, spec: PaperTaskSpec, label: string, files?: LocalFile[]) =>
  runner().startPaper(course, spec, label, files);
export const cancel = (id: string) => runner().cancel(id);
export const retry = (id: string) => runner().retry(id);
export const continueTask = (id: string) => runner().continueTask(id);
export const dismiss = (id: string) => runner().dismiss(id);
/** Once per page load, from the app shell. */
export const resumeOnLoad = () => runner().resumeOnLoad();
