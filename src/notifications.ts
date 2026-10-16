/**
 * Notification events: what changed in a sync that is worth a native
 * notification, "due in 48h" reminders computed locally between syncs, and
 * the one-line new-files summary. Only for things that matter, never per file.
 * See docs/design/05 (Notifications).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatLondon } from "./deadlines.ts";
import type { Change, Deadline } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;

export type NotificationEvent = {
  kind: "date-changed" | "new-deadline" | "new-conflict" | "due-soon" | "files-summary";
  deadlineId?: string;
  title: string;
  body: string;
  sourceUrl?: string;
};

/* ------------------------------------------------------------- helpers */

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function label(d: Deadline): string {
  return `${d.module} · ${d.title}`;
}

function when(d: Deadline): string {
  return d.due ? formatLondon(new Date(d.due.iso)) : "TBC";
}

/** Where the notification links: the submission page, else the first source. */
function link(d: Deadline): string | undefined {
  return d.submitUrl ?? d.sources[0]?.url;
}

function event(kind: NotificationEvent["kind"], d: Deadline, body: string): NotificationEvent {
  const out: NotificationEvent = { kind, deadlineId: d.id, title: label(d), body };
  const url = link(d);
  if (url !== undefined) out.sourceUrl = url;
  return out;
}

/** Formative work, unconfirmed dates (tbc, needs-check) and cancelled items never notify. */
function notifiable(d: Deadline): boolean {
  if (d.formative) return false;
  return d.status === "confirmed" || d.status === "conflict" || d.status === "user-verified";
}

function sameDue(a: Deadline["due"], b: Deadline["due"]): boolean {
  if (!a || !b) return a === b;
  return Date.parse(a.iso) === Date.parse(b.iso);
}

/* ------------------------------------------------------------- sync diff */

/**
 * The latest source disagreement merged into a user-verified deadline since
 * `previous`. The merge keeps the student's status and date and appends a
 * 'due' change carrying the disagreeing source, once per new source date.
 */
function newDisagreement(previous: Deadline, merged: Deadline): Change | undefined {
  return merged.history
    .slice(previous.history.length)
    .filter((c) => c.field === "due" && c.source !== undefined && c.to !== null)
    .at(-1);
}

/**
 * Events for one sync, from the previous and merged Deadlines.json. One event
 * per deadline at most: a new conflict beats a date change. On the first sync
 * (`previous` empty) every deadline is pre-existing, so a single summary
 * event replaces the per-deadline ones.
 */
export function eventsFromDiff(previous: Deadline[], merged: Deadline[]): NotificationEvent[] {
  if (previous.length === 0) {
    const found = merged.filter(notifiable);
    if (found.length === 0) return [];
    const modules = new Set(found.map((d) => d.module)).size;
    return [
      {
        kind: "new-deadline",
        title: `Found ${plural(found.length, "deadline")} in ${plural(modules, "module")}`,
        body: "Crawler will tell you when a date changes or a new deadline appears.",
      },
    ];
  }

  const previousById = new Map(previous.map((d) => [d.id, d]));
  const events: NotificationEvent[] = [];
  for (const d of merged) {
    if (!notifiable(d)) continue;
    const p = previousById.get(d.id);
    if (!p) {
      events.push(
        d.status === "conflict"
          ? event("new-conflict", d, `New deadline, but its sources disagree on the date (${when(d)} on the VLE)`)
          : event("new-deadline", d, `New deadline, due ${when(d)}`),
      );
    } else if (d.status === "conflict" && p.status !== "conflict") {
      events.push(event("new-conflict", d, `Sources disagree on the date (${when(d)} on the VLE)`));
    } else if (d.status === "user-verified") {
      // The student's date stands; only a newly disagreeing source is news.
      const change = newDisagreement(p, d);
      if (!change) continue;
      const out = event("new-conflict", d, `A source now says ${formatLondon(new Date(change.to!))}; keeping your date ${when(d)}`);
      if (change.source) out.sourceUrl = change.source.url;
      events.push(out);
    } else if (!sameDue(p.due, d.due)) {
      const from = p.due ? formatLondon(new Date(p.due.iso)) : "TBC";
      events.push(event("date-changed", d, `Due date moved from ${from} to ${when(d)}`));
    }
  }
  return events;
}

/* ------------------------------------------------------------- due soon */

/** Key for a reminder already sent: a moved date gets a new key, so it re-notifies. */
export function dueSoonKey(d: Deadline): string {
  return `${d.id}|${d.due?.iso ?? ""}`;
}

function keyDue(key: string): number {
  return Date.parse(key.slice(key.lastIndexOf("|") + 1));
}

function inHours(ms: number): string {
  const hours = Math.round(ms / HOUR_MS);
  return hours < 1 ? "in under an hour" : `in ${plural(hours, "hour")}`;
}

/**
 * Reminders for confirmed or user-verified, non-formative deadlines due in
 * the next `hours`, once each. `notified` is `alreadyNotified` plus the new
 * keys, minus keys whose date has passed so the saved set stays small.
 */
export function dueSoon(
  deadlines: Deadline[],
  now: Date,
  alreadyNotified: Set<string>,
  hours = 48,
): { events: NotificationEvent[]; notified: Set<string> } {
  const nowMs = now.getTime();
  const until = nowMs + hours * HOUR_MS;
  const notified = new Set([...alreadyNotified].filter((key) => !(keyDue(key) < nowMs)));
  const events: NotificationEvent[] = [];

  for (const d of deadlines) {
    if (d.formative || !d.due) continue;
    if (d.status !== "confirmed" && d.status !== "user-verified") continue;
    const due = Date.parse(d.due.iso);
    if (due <= nowMs || due > until) continue;
    const key = dueSoonKey(d);
    if (notified.has(key)) continue;
    notified.add(key);
    events.push(event("due-soon", d, `Due ${when(d)} (${inHours(due - nowMs)})`));
  }
  return { events, notified };
}

/* ------------------------------------------------------------- files */

/** "12 new files in 3 modules", or null when nothing new arrived. */
export function filesSummary(counts: { module: string; added: number }[]): NotificationEvent | null {
  const withFiles = counts.filter((c) => c.added > 0);
  if (withFiles.length === 0) return null;
  const total = withFiles.reduce((sum, c) => sum + c.added, 0);
  const modules = new Set(withFiles.map((c) => c.module)).size;
  return {
    kind: "files-summary",
    title: `${plural(total, "new file")} in ${plural(modules, "module")}`,
    body: withFiles.map((c) => `${c.module} (${c.added})`).join(", "),
  };
}

/* ------------------------------------------------------------- persistence */

const NOTIFIED_FILE = "notified.json";

/** Reminder keys already sent, from `<stateDir>/notified.json` (stateDir is the .crawler folder). */
export async function loadNotified(stateDir: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, NOTIFIED_FILE), "utf8"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === "string"));
  } catch {
    return new Set();
  }
}

/** Writes `<stateDir>/notified.json` atomically, keys sorted. */
export async function saveNotified(stateDir: string, notified: Set<string>): Promise<void> {
  const path = join(stateDir, NOTIFIED_FILE);
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(stateDir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify([...notified].sort(), null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
