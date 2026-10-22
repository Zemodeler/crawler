/**
 * The saved deadline list as plain text for the chat assistant. Pure and
 * dependency-free (types only) so it can run under node's test runner; the
 * calendar's own formatting lives in a React file and is not reused here.
 */

import type { Deadline } from "../library.ts";

const TZ = "Europe/London";
const MAX_LINES = 150;
const DAY_MS = 24 * 60 * 60 * 1000;

const fmt = (iso: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...options }).format(new Date(iso));
const DAY = { weekday: "short", day: "numeric", month: "short", year: "numeric" } as const;

export function describeToday(now: Date): string {
  return `${fmt(now.toISOString(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })} (${TZ})`;
}

function when(d: Deadline): string {
  if (d.due) {
    const day = fmt(d.due.iso, DAY);
    return d.due.allDay ? day : `${day}, ${fmt(d.due.iso, { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (d.window) return `some day in the week ${fmt(d.window.from.iso, DAY)} to ${fmt(d.window.to.iso, DAY)} (day not stated)`;
  return "date not confirmed";
}

/** The first moment it counts as due, for ordering; undated sorts last. */
const placed = (d: Deadline): number => {
  const iso = d.due?.iso ?? d.window?.from.iso;
  return iso ? new Date(iso).getTime() : Infinity;
};
/** The last moment it can still be due. */
const latest = (d: Deadline): number => {
  if (d.due) return new Date(d.due.iso).getTime();
  return d.window ? new Date(d.window.to.iso).getTime() + DAY_MS - 1 : Infinity;
};

export function deadlinesBlock(deadlines: Deadline[], now: Date): string {
  const live = deadlines.filter((d) => d.status !== "cancelled").sort((a, b) => placed(a) - placed(b) || a.title.localeCompare(b.title));
  if (!live.length) return "No deadlines are saved yet.";
  const lines = live.slice(0, MAX_LINES).map((d) => {
    const parts = [`[${d.module}] ${d.title}`, d.kind, when(d)];
    if (d.weight !== undefined) parts.push(`${d.weight}% of the module`);
    if (d.formative) parts.push("formative (not marked)");
    if (d.done) parts.push("marked done by the student");
    else if (latest(d) < now.getTime()) parts.push("date has passed");
    if (["needs-check", "conflict", "tbc"].includes(d.status) && !(d.due === null && d.window))
      parts.push(`date uncertain (${d.checkReason || d.status})`);
    if (d.userNote) parts.push(`student's note: ${d.userNote}`);
    return `- ${parts.join(" | ")}`;
  });
  if (live.length > MAX_LINES) lines.push(`(${live.length - MAX_LINES} later deadlines not shown)`);
  return lines.join("\n");
}
