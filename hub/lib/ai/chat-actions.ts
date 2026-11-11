/**
 * Things the student can ask the assistant to do, not just answer: add a
 * deadline the course site never listed, give an undated item a date, tick
 * one off, remove one they added.
 *
 * The model never changes anything itself. It writes one `ACTION: {json}`
 * line per change; this module parses and checks each line against the
 * saved deadlines and the library's modules, and the chat shows a card the
 * student has to click before anything is written. A line that fails the
 * check is shown as a refused proposal with the reason, never applied.
 *
 * Pure and dependency-free (types only) so it runs under node's test runner.
 */

import type { Deadline } from "../library.ts";

export const ACTION_PREFIX = "ACTION:";

const KINDS = ["coursework", "exam", "quiz", "presentation", "lab", "other"] as const;
type Kind = (typeof KINDS)[number];

export type ChatAction =
  | {
      type: "add_deadline";
      module: string;
      title: string;
      kind: Kind;
      /** London calendar day, YYYY-MM-DD. */
      date: string;
      /** London wall-clock time, HH:MM; absent for an all-day deadline. */
      time?: string;
      weight?: number;
      formative?: boolean;
      note?: string;
    }
  | { type: "set_date"; id: string; date: string; time?: string }
  | { type: "mark_done"; id: string; done: boolean }
  | { type: "remove_deadline"; id: string };

export type ActionState = "proposed" | "applied" | "dismissed" | "failed" | "refused";

/** One proposal as the chat keeps it, saved with the conversation. */
export type ProposedAction = {
  /** Absent when the line could not be read or checked; `error` says why. */
  action?: ChatAction;
  label: string;
  state: ActionState;
  error?: string;
};

/** A module the student can add a deadline to: its code and its academic year folder. */
export type ActionModule = { code: string; year: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The rules for the system prompt, written for the model. */
export function actionInstructions(modules: ActionModule[]): string {
  return [
    "ACTIONS: the student can ask you to change their deadline list (add something the course site",
    "did not list, give an item a date, mark one done, remove one they added). Only when they ask for",
    "a change, put one line per change at the end of your answer, before any sources footer, exactly:",
    `${ACTION_PREFIX} {"type":"add_deadline","module":"<code>","title":"<title>","kind":"coursework|exam|quiz|presentation|lab|other","date":"YYYY-MM-DD","time":"HH:MM"}`,
    `  (optional on add_deadline: "weight": <0-100>, "formative": true|false, "note": "<text>"; omit "time" for an all-day deadline)`,
    `${ACTION_PREFIX} {"type":"set_date","id":"<id from the Deadlines list>","date":"YYYY-MM-DD","time":"HH:MM"}`,
    `${ACTION_PREFIX} {"type":"mark_done","id":"<id>","done":true}`,
    `${ACTION_PREFIX} {"type":"remove_deadline","id":"<id starting with user:>"}`,
    "Rules: dates and times are London time. Use set_date when the item is already in the Deadlines list",
    "(even with no date), add_deadline only when it is not there. Never invent a date the student did not",
    "give or the material does not state; ask instead. In your answer say what you propose in one sentence:",
    "nothing changes until the student clicks Apply on each proposal, so never claim it is done.",
    `Modules you can add to: ${modules.map((m) => m.code).join(", ") || "(none)"}.`,
  ].join("\n");
}

/** Splits ACTION lines out of a reply's prose; everything else stays as written. */
export function extractActionLines(prose: string): { prose: string; lines: string[] } {
  const lines: string[] = [];
  const kept: string[] = [];
  for (const line of prose.split("\n")) {
    const trimmed = line.trim().replace(/^`+|`+$/g, "");
    if (trimmed.startsWith(ACTION_PREFIX)) lines.push(trimmed.slice(ACTION_PREFIX.length).trim());
    else kept.push(line);
  }
  return { prose: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), lines };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function realDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** "Thu 20 Nov 2026, 16:00" for a proposal card. */
function when(date: string, time?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(",", "");
  return time ? `${day}, ${time}` : day;
}

/**
 * Reads and checks one ACTION line. Returns the action and a plain-words
 * label, or a refused proposal saying what was wrong with it.
 */
export function checkAction(line: string, deadlines: Deadline[], modules: ActionModule[]): ProposedAction {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch {
    return { label: "A change Study Hub could not read", state: "refused", error: "The assistant wrote it in a form Study Hub does not understand." };
  }
  const refuse = (label: string, error: string): ProposedAction => ({ label, state: "refused", error });
  const find = (id: unknown) => (typeof id === "string" ? deadlines.find((d) => d.id === id) : undefined);
  const time = raw.time === undefined || raw.time === null || raw.time === "" ? undefined : raw.time;

  switch (raw.type) {
    case "add_deadline": {
      const label = `Add "${typeof raw.title === "string" ? raw.title : "a deadline"}"`;
      const place = modules.find((m) => m.code === raw.module);
      if (!place) return refuse(label, `${String(raw.module ?? "That module")} is not one of your modules.`);
      if (!text(raw.title, 500)) return refuse(label, "It has no title.");
      if (!KINDS.includes(raw.kind as Kind)) return refuse(label, "It has no valid type.");
      if (typeof raw.date !== "string" || !realDate(raw.date)) return refuse(label, "It has no valid date.");
      if (time !== undefined && (typeof time !== "string" || !TIME.test(time))) return refuse(label, "Its time is not valid.");
      if (raw.weight !== undefined && raw.weight !== null && (typeof raw.weight !== "number" || !Number.isFinite(raw.weight) || raw.weight < 0 || raw.weight > 100))
        return refuse(label, "Its weight must be between 0 and 100.");
      if (raw.formative !== undefined && raw.formative !== null && typeof raw.formative !== "boolean") return refuse(label, "Formative must be yes or no.");
      if (raw.note !== undefined && raw.note !== null && (typeof raw.note !== "string" || raw.note.length > 4000)) return refuse(label, "Its note is too long.");
      const action: ChatAction = {
        type: "add_deadline",
        module: place.code,
        title: raw.title.trim(),
        kind: raw.kind as Kind,
        date: raw.date,
        ...(time ? { time: time as string } : {}),
        ...(typeof raw.weight === "number" ? { weight: raw.weight } : {}),
        ...(typeof raw.formative === "boolean" ? { formative: raw.formative } : {}),
        ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note.trim() } : {}),
      };
      const extras = [action.formative ? "formative" : "", action.weight !== undefined ? `${action.weight}%` : ""].filter(Boolean).join(", ");
      return {
        action,
        label: `Add "${action.title}" to ${action.module}, due ${when(action.date, action.time)}${extras ? ` (${extras})` : ""}`,
        state: "proposed",
      };
    }
    case "set_date": {
      const item = find(raw.id);
      if (!item) return refuse("Set a date", "That deadline is not in your list.");
      const label = `Set "${item.title}" (${item.module}) to`;
      if (typeof raw.date !== "string" || !realDate(raw.date)) return refuse(`${label} a date`, "It has no valid date.");
      if (time !== undefined && (typeof time !== "string" || !TIME.test(time))) return refuse(`${label} a date`, "Its time is not valid.");
      return {
        action: { type: "set_date", id: item.id, date: raw.date, ...(time ? { time: time as string } : {}) },
        label: `${label} ${when(raw.date, time as string | undefined)}`,
        state: "proposed",
      };
    }
    case "mark_done": {
      const item = find(raw.id);
      if (!item) return refuse("Mark a deadline done", "That deadline is not in your list.");
      const done = raw.done !== false;
      return {
        action: { type: "mark_done", id: item.id, done },
        label: done ? `Mark "${item.title}" (${item.module}) done` : `Mark "${item.title}" (${item.module}) not done`,
        state: "proposed",
      };
    }
    case "remove_deadline": {
      const item = find(raw.id);
      if (!item) return refuse("Remove a deadline", "That deadline is not in your list.");
      if (!item.id.startsWith("user:"))
        return refuse(`Remove "${item.title}"`, "Only deadlines you added yourself can be removed. Mark it done instead.");
      return { action: { type: "remove_deadline", id: item.id }, label: `Remove "${item.title}" (${item.module})`, state: "proposed" };
    }
    default:
      return refuse("A change Study Hub cannot make", "The assistant asked for something Study Hub does not do.");
  }
}

/** The date string the library's deadline endpoints take: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`. */
export const actionDate = (a: { date: string; time?: string }) => (a.time ? `${a.date}T${a.time}` : a.date);

/**
 * How proposals read back to the model on later turns, so it knows what the
 * student applied or turned down and does not propose the same thing again.
 */
export function actionsSummary(actions: ProposedAction[] | undefined): string {
  if (!actions?.length) return "";
  const word: Record<ActionState, string> = {
    proposed: "proposed, not applied yet",
    applied: "applied by the student",
    dismissed: "dismissed by the student",
    failed: "failed to apply",
    refused: "refused by Study Hub",
  };
  return ["[Changes from this answer:", ...actions.map((a) => `- ${a.label}: ${word[a.state]}${a.error ? ` (${a.error})` : ""}`), "]"].join("\n");
}
