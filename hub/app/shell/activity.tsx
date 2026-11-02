"use client";
/**
 * What the assistant is working on, in the navigation rail: every unfinished
 * tutorial conversion or practice paper, with a live line and a ticking
 * timer, and the ones that just finished. The rail does full page loads, so
 * everything here is drawn from the background runner's saved list, never
 * from a page's own state. Mounted once by the app shell; it is also what
 * picks up, on each page load, whatever an earlier page left running.
 *
 * When a task finishes it says so in a small message on the page and, if the
 * window is hidden or the student is on another page, in a system notification.
 */
import { useEffect, useRef, useState } from "react";

import { cancel, continueTask, dismiss, isFinished, list, resumeOnLoad, subscribe, type Task } from "../../lib/background-tasks.ts";
import { savedActiveModule } from "../../lib/library.ts";

/** How long a finished task stays in the list without being dismissed (failed ones stay until dismissed). */
const SHOW_FINISHED_MS = 10 * 60 * 1000;
const TOAST_MS = 7_000;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "2:14" or "1:02:05". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The runner's tasks, kept current. Empty until mounted, so nothing differs between server and browser rendering. */
export function useTasks(): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    const off = subscribe(setTasks);
    queueMicrotask(() => setTasks(list()));
    return off;
  }, []);
  return tasks;
}

/** The time now, ticking every second while `ticking`. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    queueMicrotask(() => setNow(Date.now()));
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The latest task of this type for this module that matches. */
export function latestTask(tasks: Task[], course: string, match: (task: Task) => boolean): Task | undefined {
  return tasks.filter((t) => t.course === course && match(t)).at(-1);
}

/** What a task is doing right now, in a few words, with its timer. */
export function liveLine(task: Task, tasks: Task[], now: number): string {
  if (task.status === "queued") {
    const index = tasks.findIndex((t) => t.id === task.id);
    const ahead = tasks.slice(0, Math.max(0, index)).filter((t) => t.status === "queued" || t.status === "running").length;
    if (ahead) return `Queued behind ${plural(ahead, "task")}`;
    return `Waiting for your assistant… ${clock(now - task.createdAt)}`;
  }
  const p = task.progress;
  if (!p) return `Waiting for your assistant… ${clock(now - (task.startedAt ?? task.createdAt))}`;
  const noun = task.type === "tutorial" ? "exercise" : "question";
  let main: string;
  if (p.phase === "streaming") {
    const n = Math.max(1, p.items ?? 0);
    let of = "";
    if (p.itemsTotal) of = ` of ${p.itemsTotal}`;
    else if (p.batches && p.batches > 1 && p.batch && p.batch > 1 && p.items) {
      const guess = Math.round((p.items / (p.batch - 1)) * p.batches);
      if (guess > n) of = ` of ~${guess}`;
    }
    main = `Writing ${noun} ${n}${of}`;
  } else if (p.phase === "validating") main = "Checking the answers…";
  else if (p.phase === "repairing") main = "Fixing the format…";
  else main = "Waiting for your assistant…";
  const part = p.batches && p.batches > 1 && p.batch ? ` · part ${p.batch} of ${p.batches}` : "";
  return `${main}${part}${main.endsWith("…") && !part ? " " : " · "}${clock(now - p.startedAt)}`;
}

/** The short outcome of a finished task. */
export function finishedLine(task: Task): string {
  if (task.status === "done") return `Done: ${plural(task.result?.count ?? 0, task.type === "tutorial" ? "exercise" : "question")}`;
  if (task.status === "cancelled") return "Cancelled";
  if (task.status === "interrupted") return "Stopped before it finished";
  return task.error?.title || "Could not finish";
}

/** "Continue from part 3 of 5" when the run was split into parts. */
export function continueLabel(task: Task): string {
  const p = task.progress;
  return p?.batches && p.batches > 1 && p.batch ? `Continue from part ${p.batch} of ${p.batches}` : "Continue";
}

/** Where a task's result is: the module's tutorial sheets or its papers. */
export function taskHref(task: Pick<Task, "type" | "course">): string {
  const query = new URLSearchParams({ view: task.type === "tutorial" ? "tutorials" : "papers", module: task.course });
  return `/practice?${query.toString()}`;
}

let asked = false;
/** Asks once, from a click that starts a task, whether the app may show system notifications. */
export function askToNotify() {
  if (asked) return;
  asked = true;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
  } catch {
    /* notifications unavailable */
  }
}

/** True while the student is looking at this task's module on the Practice page. */
function onTaskPage(task: Task): boolean {
  if (window.location.pathname !== "/practice") return false;
  const shown = new URLSearchParams(window.location.search).get("module") || savedActiveModule();
  return !shown || shown === task.course;
}

function systemNotice(task: Task) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState !== "hidden" && onTaskPage(task)) return;
    const noun = task.type === "tutorial" ? "exercise" : "question";
    const title = task.status === "done" ? `${task.label} ready: ${plural(task.result?.count ?? 0, noun)}` : `Could not finish ${task.label}`;
    const body = task.status === "done" ? task.result?.notes.join(" ") || "" : task.error?.message || "";
    const note = new Notification(title, { body, tag: task.id });
    note.onclick = () => {
      window.focus();
      if (!onTaskPage(task)) window.location.assign(taskHref(task));
    };
  } catch {
    /* notifications unavailable */
  }
}

type Toast = { id: string; text: string; href: string; failed: boolean };

/**
 * `headless`: picks up unfinished work and sends system notifications but draws
 * nothing (for pages without the rail).
 */
export default function Activity({ headless = false }: { headless?: boolean }) {
  const tasks = useTasks();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef<Map<string, Task["status"]> | null>(null);
  const busy = tasks.some((t) => !isFinished(t));
  const now = useNow(!headless && tasks.length > 0);

  useEffect(() => {
    resumeOnLoad();
  }, []);

  // A task seen running in this page that has now finished: say so.
  useEffect(() => {
    const before = seen.current;
    seen.current = new Map(tasks.map((t) => [t.id, t.status]));
    if (!before) return;
    for (const task of tasks) {
      const was = before.get(task.id);
      if (!was || isFinished({ status: was }) || (task.status !== "done" && task.status !== "failed")) continue;
      systemNotice(task);
      const noun = task.type === "tutorial" ? "exercise" : "question";
      const text =
        task.status === "done" ? `${task.label} is ready: ${plural(task.result?.count ?? 0, noun)}.` : `Could not finish ${task.label}.`;
      const toast = { id: `${task.id}:${task.status}`, text, href: taskHref(task), failed: task.status === "failed" };
      queueMicrotask(() => setToasts((list) => [...list.filter((t) => t.id !== toast.id), toast]));
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== toast.id)), TOAST_MS);
    }
  }, [tasks]);

  const toastRegion = (
    <div className="activity-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <p key={toast.id} className={`activity-toast${toast.failed ? " failed" : ""}`}>
          <span>{toast.text}</span>
          <a href={toast.href}>Open</a>
          <button type="button" aria-label="Close" onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))}>
            ×
          </button>
        </p>
      ))}
    </div>
  );

  if (headless) return null;

  const shown = tasks.filter(
    (t) => !isFinished(t) || t.status === "failed" || t.status === "interrupted" || !now || now - (t.endedAt ?? t.createdAt) < SHOW_FINISHED_MS,
  );
  const first = shown.find((t) => !isFinished(t)) ?? shown.at(-1);

  return (
    <>
      {shown.length > 0 && (
        <section className="rail-activity" aria-label="Working on">
          <p className="rail-label">{busy ? "Working on" : "Finished"}</p>
          {first && (
            <a className="rail-activity-chip" href={taskHref(first)} title={first.label}>
              {isFinished(first) ? finishedLine(first) : `Working · ${clock(now - (first.progress?.startedAt ?? first.createdAt))}`}
            </a>
          )}
          <ul className="rail-tasks">
            {shown.map((task) => {
              const finished = isFinished(task);
              return (
                <li key={task.id} className={`rail-task ${task.status}`}>
                  <a className="rail-task-label" href={taskHref(task)} title={task.label}>
                    {task.label}
                  </a>
                  <span className="rail-task-line">{finished ? finishedLine(task) : liveLine(task, tasks, now)}</span>
                  {task.status === "failed" && task.error?.message && <small className="rail-task-detail">{task.error.message}</small>}
                  <span className="rail-task-actions">
                    {!finished && (
                      <button type="button" onClick={() => cancel(task.id)}>
                        Cancel
                      </button>
                    )}
                    {finished && task.status !== "done" && (
                      <button type="button" onClick={() => continueTask(task.id)}>
                        {continueLabel(task)}
                      </button>
                    )}
                    {finished && (
                      <button type="button" onClick={() => dismiss(task.id)}>
                        Dismiss
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {toastRegion}
    </>
  );
}
