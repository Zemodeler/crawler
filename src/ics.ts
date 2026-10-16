/**
 * Deadlines.ics for Apple Calendar and other clients (RFC 5545). UIDs are
 * stable per Deadline.id and SEQUENCE grows with its history, so re-importing
 * updates events instead of duplicating them. See docs/design/05.
 */

import type { Deadline, DeadlineStatus } from "./types.ts";

const ON_CALENDAR: ReadonlySet<DeadlineStatus> = new Set(["confirmed", "user-verified", "conflict"]);
const WARNING = "⚠";

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line at 75 octets without splitting a UTF-8 character (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (octets + size > 75) {
      out.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join("\r\n");
}

/** 2026-12-14T10:00:00.000Z -> 20261214T100000Z */
export function utcBasic(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function eventLines(d: Deadline, stamp: string): string[] {
  const due = utcBasic(new Date(d.due!.iso));
  const summary = `${d.status === "conflict" ? `${WARNING} ` : ""}${d.module} · ${d.title}`;
  const description = [`Status: ${d.status}`];
  if (d.weight !== undefined) description.push(`Weight: ${d.weight}%`);
  for (const s of d.sources) description.push(`${s.quote} (${s.url})`);
  const url = d.submitUrl ?? d.sources[0]?.url;

  const lines = [
    "BEGIN:VEVENT",
    `UID:${d.id}@crawler`,
    `SEQUENCE:${d.history.length}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${due}`,
    `DTEND:${due}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description.join("\n"))}`,
  ];
  if (url) lines.push(`URL:${url}`);
  lines.push("END:VEVENT");
  return lines;
}

/** Calendar with one event per dated deadline that is confirmed, user-verified or in conflict. */
export function toIcs(deadlines: Deadline[], now: Date): string {
  const stamp = utcBasic(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crawler//Deadlines//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:University deadlines",
  ];
  for (const d of deadlines) {
    if (d.due && ON_CALENDAR.has(d.status)) lines.push(...eventLines(d, stamp));
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
