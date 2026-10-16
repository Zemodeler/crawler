/**
 * Deadline -> Google Calendar event. One event per Deadline, keyed by
 * extendedProperties.private.crawlerId = Deadline.id; crawlerHash fingerprints
 * the content written so the sync can tell a student's edit from ours.
 * Everything leaves through sanitizeText, so VLE URLs lose their credentials.
 * See docs/design/05 (Google Calendar).
 */

import { createHash } from "node:crypto";

import type { CalendarEventInput, CalendarEventTime } from "../calendar-types.ts";
import type { Deadline, Instant } from "../types.ts";

const TZ = "Europe/London";
const WARNING = "⚠";
const TIMED_MINUTES = 30;

const londonDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Europe/London calendar date of an instant, "2026-12-14". */
function dateOf(instant: Instant): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(instant.iso)) return instant.iso;
  return londonDate.format(new Date(instant.iso));
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function times(d: Deadline): { start: CalendarEventTime; end: CalendarEventTime } | null {
  if (d.due && d.status !== "tbc") {
    if (d.due.allDay) {
      const date = dateOf(d.due);
      return { start: { date }, end: { date: nextDay(date) } };
    }
    const end = new Date(d.due.iso).getTime();
    return {
      start: { dateTime: utc(end - TIMED_MINUTES * 60_000), timeZone: TZ },
      end: { dateTime: utc(end), timeZone: TZ },
    };
  }
  if (d.window) {
    return { start: { date: dateOf(d.window.from) }, end: { date: nextDay(dateOf(d.window.to)) } };
  }
  return null;
}

/** Query or fragment parameter names that carry credentials (matched case-insensitively). */
const SECRET_PARAM =
  /^(key|sig|auth|pass|pwd|passwd)$|token|secret|password|signature|sesskey|session|credential|apikey|api_key|access_key|private_key/i;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'“”‘’]+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

function decodeName(pair: string): string {
  const name = pair.split("=", 1)[0]!.replace(/\+/g, " ");
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** `a=1&token=x` without its credential pairs, keeping the rest exactly as spelt. */
function withoutSecrets(params: string): string {
  return params
    .split("&")
    .filter((pair) => pair !== "" && !SECRET_PARAM.test(decodeName(pair)))
    .join("&");
}

/** One URL without userinfo or credential-bearing parameters; unchanged when it has none. */
function sanitizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const search = url.search.slice(1);
  const hash = url.hash.slice(1);
  const cleanSearch = withoutSecrets(search);
  const cleanHash = hash.includes("=") ? withoutSecrets(hash) : hash;
  if (!url.username && !url.password && cleanSearch === search && cleanHash === hash) return raw;
  url.username = "";
  url.password = "";
  url.search = cleanSearch;
  url.hash = cleanHash;
  return url.href;
}

/**
 * `text` with every URL in it stripped of userinfo and credential-bearing
 * query or fragment parameters (token, wstoken, key, sig, ...), so nothing
 * secret copied from the VLE reaches Google.
 */
export function sanitizeText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const tail = TRAILING.exec(match)?.[0] ?? "";
    return sanitizeUrl(match.slice(0, match.length - tail.length)) + tail;
  });
}

function description(d: Deadline, vleLabel: string): string {
  const lines = [`Status: ${d.status}`];
  if (d.status === "conflict") lines.push("Sources disagree on the date; check each one below.");
  if (d.weight !== undefined) lines.push(`Weight: ${d.weight}%`);
  if (d.formative) lines.push("Formative: does not count towards the module mark.");
  if (d.window) lines.push(`Window: ${dateOf(d.window.from)} to ${dateOf(d.window.to)}`);
  if (d.sources.length > 0) {
    lines.push("", d.sources.length === 1 ? "Source:" : "Sources:");
    for (const s of d.sources) {
      lines.push(`“${s.quote}”`, `${s.type === "vle-field" ? vleLabel : s.type}: ${s.url}`);
    }
  }
  if (d.submitUrl) lines.push("", `Submit: ${d.submitUrl}`);
  return lines.join("\n");
}

function normalTime(t: CalendarEventTime): string {
  if (t.date) return t.date;
  if (t.dateTime) return new Date(t.dateTime).toISOString();
  return "";
}

/** sha256 over summary, description, start and end (times normalised to UTC). */
export function contentHash(event: Pick<CalendarEventInput, "summary" | "description" | "start" | "end">): string {
  const payload = JSON.stringify([
    event.summary ?? "",
    event.description ?? "",
    normalTime(event.start ?? {}),
    normalTime(event.end ?? {}),
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * The event Crawler writes for `deadline`, or why it has none: needs-check,
 * cancelled and undated items (tbc without a window) stay off the calendar.
 */
export function deadlineToEvent(
  deadline: Deadline,
  opts: { vleLabel?: string } = {},
): CalendarEventInput | { skip: string } {
  if (deadline.status === "cancelled") return { skip: "cancelled" };
  if (deadline.status === "needs-check") {
    return { skip: deadline.checkReason ? `needs-check: ${deadline.checkReason}` : "needs-check" };
  }
  const when = times(deadline);
  if (!when) return { skip: deadline.status === "tbc" ? "tbc without a window" : "no date" };

  const prefix = deadline.status === "conflict" ? `${WARNING} ` : "";
  const event = {
    summary: sanitizeText(`${prefix}${deadline.module} · ${deadline.title}`),
    description: sanitizeText(description(deadline, opts.vleLabel ?? "VLE")),
    start: when.start,
    end: when.end,
  };
  return {
    ...event,
    extendedProperties: { private: { crawlerId: deadline.id, crawlerHash: contentHash(event) } },
  };
}
