/**
 * First launch and syncing, through the desktop app's host (`/api/setup/*`).
 * The university sign-in happens in its own window; the page only sees
 * whether it worked.
 */

import { loadSettings } from "./ai/settings.ts";

const GUARD = { "x-study-hub-host": "1" };

export type SyncRun = {
  state: "idle" | "running" | "done" | "failed";
  course: string | null;
  coursesDone: number;
  newFiles: number;
  files: number;
  failedCourses: string[];
  error: string | null;
  finishedAt: string | null;
  /** What the last finished sync found; null while running or before the first. */
  summary: {
    deadlines: number;
    conflicts: number;
    needsCheck: number;
    notifications: number;
    verified: number;
    rejected: number;
    aiRuns: number;
    aiMs: number;
  } | null;
};

export type CalendarReport = {
  created: string[];
  updated: string[];
  deleted: string[];
  unchanged: number;
  editedByUser: { crawlerId: string; summary: string }[];
  skipped: { crawlerId: string; reason: string }[];
  at: string;
};

export type CalendarStatus = {
  /** A Google OAuth client is set up on this computer. */
  configured: boolean;
  connected: boolean;
  busy: boolean;
  lastReport: CalendarReport | null;
  error: string | null;
};

export type SetupStatus = {
  university: { id: string; name: string };
  signedIn: boolean;
  signingIn: boolean;
  sync: SyncRun;
  lastSync: string | null;
  /** "last synced 2 days ago" */
  freshness: string;
  schedule: { everyDays: 1 | 3 | 7 };
  /** The CLI the last sync used to read documents, if any. */
  assistant: "claude" | "codex" | null;
  calendar: CalendarStatus;
};

async function call<T>(path: string, method: "GET" | "POST" = "GET", payload?: object): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: payload ? { ...GUARD, "content-type": "application/json" } : GUARD,
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Study Hub could not finish that (${response.status}).`);
  return body as T;
}

export const setupStatus = () => call<SetupStatus>("/api/setup/status");
export const signIn = () => call<{ ok: true }>("/api/setup/sign-in", "POST");
export const startSync = () => call<{ ok: true }>("/api/setup/sync", "POST", { assistant: chosenAssistant() });
export const setSchedule = (everyDays: 1 | 3 | 7) => call<{ ok: true }>("/api/setup/schedule", "POST", { everyDays });
export const connectCalendar = () => call<{ ok: true }>("/api/setup/calendar/connect", "POST");
export const syncCalendarNow = () => call<{ ok: true; report: CalendarReport | null }>("/api/setup/calendar/sync", "POST");
export const disconnectCalendar = () => call<{ ok: true }>("/api/setup/calendar/disconnect", "POST");

/**
 * The assistant the student chose for Study Hub ("My subscription"), which the
 * sync also uses to read documents for deadlines; "none" when they use an API
 * key or nothing, so the sync sticks to rules and the course site's own dates.
 */
export function chosenAssistant(): "claude" | "codex" | "none" {
  const settings = loadSettings();
  if (settings.transport !== "subscription") return "none";
  return settings.provider === "openai" ? "codex" : "claude";
}

/** Calls `onUpdate` every second until the sync stops running. */
export function watchSync(onUpdate: (run: SyncRun) => void): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const { sync } = await setupStatus();
      onUpdate(sync);
      if (sync.state === "running") setTimeout(tick, 1000);
    } catch {
      setTimeout(tick, 2000);
    }
  };
  tick();
  return () => {
    stopped = true;
  };
}

/** Marks the first-launch flow finished, so the hub stops sending you to it. */
const DONE_KEY = "studyhub:setup:done";
export function setupDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}
export function markSetupDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* the hub will just check the library again */
  }
}
