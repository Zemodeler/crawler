/**
 * Deadline rules: VLE items -> Deadlines, merging a sync into the previous
 * Deadlines.json, conflict detection and the Changes.md lines.
 * See docs/design/03 (Deadline model, Status rules, Changes).
 */

import type { Change, Course, Deadline, DeadlineStatus, Instant, ModulePlacement, Source, VleItem } from "./types.ts";

const TZ = "Europe/London";
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------- time helpers */

export function instantFromUnix(seconds: number): Instant {
  return { iso: new Date(seconds * 1000).toISOString(), allDay: false, tz: TZ };
}

function londonParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

/** "Mon 14 Dec 2026, 10:00" in Europe/London. */
export function formatLondon(date: Date): string {
  const p = londonParts(date);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "14 Dec 10:00" in Europe/London, used in Changes.md. */
function formatShort(instant: Instant | null): string {
  if (!instant) return "TBC";
  const p = londonParts(new Date(instant.iso));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** Offset of Europe/London from UTC at `utcMs`, in ms. */
function londonOffset(utcMs: number): number {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(p.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - utcMs;
}

/** UTC ms of local midnight in London on the given date (month 1-12). */
function londonMidnight(year: number, month: number, day: number): number {
  const guess = Date.UTC(year, month - 1, day);
  return guess - londonOffset(guess - londonOffset(guess));
}

/** First calendar year of "2026-27", or null for "Undated" and the like. */
function firstYear(year: string): number | null {
  const match = /^(\d{4})/.exec(year);
  return match ? Number(match[1]) : null;
}

/* ------------------------------------------------------------- title parsing */

/** "mySkills Task 3 - Submission Link (3%)" -> 3. */
export function parseWeight(title: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(title);
  return match ? Number(match[1]) : undefined;
}

/** True for "formative", and for the real QMplus typo "fomative". */
export function isFormative(title: string): boolean {
  return /fo(?:r)?mative/i.test(title);
}

/* ------------------------------------------------------------- items -> deadlines */

/**
 * Status for a VLE-field date: tbc when missing, needs-check when outside the
 * academic year (1 Aug – 30 Sep the following year, London time) or more than
 * 30 days before the course starts, else confirmed.
 */
export function statusFor(
  due: Date | null,
  year: string,
  course: Course,
): { status: DeadlineStatus; checkReason?: string } {
  if (!due) return { status: "tbc" };
  const when = formatLondon(due);
  const first = firstYear(year);
  if (first !== null) {
    const from = londonMidnight(first, 8, 1);
    const to = londonMidnight(first + 1, 10, 1); // exclusive: end of 30 Sep
    if (due.getTime() < from || due.getTime() >= to) {
      return {
        status: "needs-check",
        checkReason:
          `The date ${when} is outside the ${year} academic year ` +
          `(1 Aug ${first} to 30 Sep ${first + 1}), so it may be a placeholder.`,
      };
    }
  }
  if (course.startdate !== null && due.getTime() < course.startdate * 1000 - 30 * DAY_MS) {
    const start = formatLondon(new Date(course.startdate * 1000));
    return {
      status: "needs-check",
      checkReason: `The date ${when} is more than 30 days before the module starts (${start}).`,
    };
  }
  return { status: "confirmed" };
}

export function deadlinesFromItems(
  items: VleItem[],
  course: Course,
  placement: ModulePlacement,
  now: Date,
): Deadline[] {
  const module = placement.code ?? course.shortname;
  const seenAt = now.toISOString();
  const out: Deadline[] = [];

  const make = (
    type: "assign" | "quiz" | "event",
    id: number,
    title: string,
    kind: Deadline["kind"],
    dueSeconds: number | null,
    label: string,
    url: string,
  ): Deadline => {
    const dueDate = dueSeconds === null ? null : new Date(dueSeconds * 1000);
    const due = dueSeconds === null ? null : instantFromUnix(dueSeconds);
    const source: Source = {
      type: "vle-field",
      strength: "structured",
      url,
      quote: `${label}: ${dueDate ? formatLondon(dueDate) : "not set"}`,
      date: due,
      seenAt,
    };
    const deadline: Deadline = {
      id: `moodle:${course.shortname}:${type}:${id}`,
      module,
      year: placement.year,
      title,
      kind,
      ...statusFor(dueDate, placement.year, course),
      due,
      sources: [source],
      history: [],
    };
    const weight = parseWeight(title);
    if (weight !== undefined) deadline.weight = weight;
    if (isFormative(title)) deadline.formative = true;
    return deadline;
  };

  for (const item of items) {
    if (item.kind === "assignment") {
      const d = make("assign", item.id, item.title, "coursework", item.due, "Due", item.url);
      d.submitUrl = item.url;
      out.push(d);
    } else if (item.kind === "quiz") {
      const d = make("quiz", item.id, item.title, "quiz", item.closes, "Closes", item.url);
      if (item.opens !== null && item.closes !== null) {
        d.window = { from: instantFromUnix(item.opens), to: instantFromUnix(item.closes) };
      }
      out.push(d);
    } else if (item.kind === "event") {
      // Assignment and quiz events duplicate the activities themselves.
      if (item.activityType === "assign" || item.activityType === "quiz") continue;
      out.push(make("event", item.id, item.title, "other", item.start, "Starts", item.url));
    }
  }
  return out;
}

/* ------------------------------------------------------------- conflicts */

function sameDate(a: Instant | null, b: Instant | null): boolean {
  if (!a || !b) return a === b;
  return Date.parse(a.iso) === Date.parse(b.iso);
}

/** Distinct non-null dates the sources claim, as ms. */
function sourceDates(sources: Source[]): number[] {
  return [...new Set(sources.flatMap((s) => (s.date ? [Date.parse(s.date.iso)] : [])))];
}

/** Marks a deadline 'conflict' when its sources disagree on the date, unless the student verified it. */
export function detectConflict(deadline: Deadline): Deadline {
  if (deadline.status === "user-verified" || deadline.status === "cancelled") return deadline;
  if (sourceDates(deadline.sources).length > 1) return { ...deadline, status: "conflict" };
  return deadline;
}

/* ------------------------------------------------------------- merge */

/**
 * A deadline has at most one vle-field source: its url can embed the date
 * (calendar events), so a moved event must replace, not add to, the old one.
 */
function sourceKey(s: Source): string {
  if (s.type === "vle-field") return s.type;
  return [s.type, s.url, s.localPath ?? "", s.page ?? "", s.line ?? ""].join("|");
}

/** Fresh sources replace previous ones from the same place; others are kept. Structured first. */
function mergeSources(previous: Source[], fresh: Source[]): Source[] {
  // At most one vle-field source, even if a fresh deadline arrives with several.
  let seenVle = false;
  fresh = fresh.filter((s) => s.type !== "vle-field" || (seenVle ? false : (seenVle = true)));
  const freshKeys = new Set(fresh.map(sourceKey));
  const merged = [...fresh, ...previous.filter((s) => !freshKeys.has(sourceKey(s)))];
  return merged.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "structured" ? -1 : 1));
}

function compareDeadlines(a: Deadline, b: Deadline): number {
  if (a.due && b.due) {
    const diff = Date.parse(a.due.iso) - Date.parse(b.due.iso);
    if (diff !== 0) return diff;
  } else if (a.due || b.due) {
    return a.due ? -1 : 1;
  }
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function sortDeadlines(deadlines: Deadline[]): Deadline[] {
  return [...deadlines].sort(compareDeadlines);
}

/** The source that gives `due`, else the strongest one. */
function sourceForDate(sources: Source[], due: Instant | null): Source | undefined {
  return sources.find((s) => s.date !== null && sameDate(s.date, due)) ?? sources[0];
}

/**
 * Previous sources that still count without being found again: the VLE field
 * and what the AI quoted (it only re-reads changed documents). A rule source
 * that was not found again no longer stands; neither does one from before
 * sources recorded who found them.
 */
const lasting = (s: Source) => s.type === "vle-field" || s.origin === "ai";

function mergeOne(p: Deadline, fresh: Deadline, at: string): Deadline {
  const history = [...p.history];
  const sources = mergeSources(p.sources.filter(lasting), fresh.sources);
  let f = fresh;

  // A date quoted from a document is not found again while the document is
  // unchanged (the AI only reads changed documents), so the fresh deadline can
  // arrive undated. Keep the date while the VLE field still gives none and the
  // quoting source is still on record.
  if (f.due === null && p.due !== null && p.status !== "user-verified") {
    const quoted = sources.find((s) => s.type !== "vle-field" && s.date !== null && sameDate(s.date, p.due));
    if (quoted) {
      f = { ...f, due: p.due, status: p.status === "conflict" ? "confirmed" : p.status };
      if (p.checkReason !== undefined) f.checkReason = p.checkReason;
      else delete f.checkReason;
    }
  }

  if (p.status === "user-verified") {
    // Back after a removal: record it, so that a later removal is reported again.
    if (p.history.at(-1)?.field === "removed") {
      history.push({ at, field: "added", from: "removed", to: p.status });
    }
    const previousByKey = new Map(p.sources.map((s) => [sourceKey(s), s]));
    for (const s of f.sources) {
      const old = previousByKey.get(sourceKey(s));
      const alreadyReported = old !== undefined && sameDate(old.date, s.date);
      if (s.date && !sameDate(s.date, p.due) && !alreadyReported) {
        history.push({ at, field: "due", from: p.due?.iso ?? null, to: s.date.iso, source: s });
      }
    }
    const kept: Deadline = { ...f, due: p.due, status: p.status, sources, history };
    if (p.checkReason !== undefined) kept.checkReason = p.checkReason;
    else delete kept.checkReason;
    if (p.userNote !== undefined) kept.userNote = p.userNote;
    return kept;
  }

  if (!sameDate(p.due, f.due)) {
    const change: Change = { at, field: "due", from: p.due?.iso ?? null, to: f.due?.iso ?? null };
    const source = sourceForDate(f.sources, f.due);
    if (source) change.source = source;
    history.push(change);
  }
  if (p.title !== f.title) history.push({ at, field: "title", from: p.title, to: f.title });
  if (p.weight !== f.weight) {
    history.push({ at, field: "weight", from: p.weight?.toString() ?? null, to: f.weight?.toString() ?? null });
  }
  const merged = detectConflict({ ...f, sources, history });
  if (merged.status !== p.status) history.push({ at, field: "status", from: p.status, to: merged.status });
  if (p.userNote !== undefined) merged.userNote = p.userNote;
  return merged;
}

/**
 * What happens to a previous deadline the VLE no longer lists. Only VLE-born
 * deadlines backed solely by vle-field sources are cancelled; a user-verified
 * one stays and records 'removed' once; anything a document, announcement or
 * page also speaks for, or that did not come from the VLE, is kept unchanged.
 */
function missingFromVle(p: Deadline, at: string): Deadline {
  if (p.status === "cancelled") return p;
  // Found in text and not found again: it stands only on what the AI quoted.
  if (p.id.includes(":text:")) {
    const kept = p.sources.filter(lasting);
    if (kept.length > 0 || p.status === "user-verified") return kept.length === p.sources.length ? p : { ...p, sources: kept.length ? kept : p.sources };
    return { ...p, status: "cancelled", history: [...p.history, { at, field: "removed", from: p.status, to: "cancelled" }] };
  }
  if (!p.id.startsWith("moodle:")) return p;
  if (p.sources.some((s) => s.type !== "vle-field")) return p;
  if (p.status === "user-verified") {
    if (p.history.at(-1)?.field === "removed") return p;
    return { ...p, history: [...p.history, { at, field: "removed", from: p.status, to: p.status }] };
  }
  return { ...p, status: "cancelled", history: [...p.history, { at, field: "removed", from: p.status, to: "cancelled" }] };
}

/**
 * Merges a fresh sync into the previous deadlines, recording history. Ids
 * missing from `fresh` go through missingFromVle. Result is sorted by due,
 * then title, undated last.
 */
export function mergeDeadlines(previous: Deadline[], fresh: Deadline[], now: Date): Deadline[] {
  const at = now.toISOString();
  const previousById = new Map(previous.map((d) => [d.id, d]));
  const freshIds = new Set(fresh.map((d) => d.id));
  const out: Deadline[] = [];

  for (const f of fresh) {
    const p = previousById.get(f.id);
    if (!p) {
      const added: Change = { at, field: "added", from: null, to: f.due?.iso ?? null };
      const source = sourceForDate(f.sources, f.due);
      if (source) added.source = source;
      out.push(detectConflict({ ...f, sources: mergeSources([], f.sources), history: [...f.history, added] }));
    } else {
      out.push(mergeOne(p, f, at));
    }
  }

  for (const p of previous) {
    if (!freshIds.has(p.id)) out.push(missingFromVle(p, at));
  }

  return sortDeadlines(out);
}

/* ------------------------------------------------------------- Changes.md */

/** Human lines for Changes.md describing what changed between two Deadlines.json states. */
export function changeLines(previous: Deadline[], merged: Deadline[]): string[] {
  const previousById = new Map(previous.map((d) => [d.id, d]));
  const lines: string[] = [];

  for (const d of merged) {
    const p = previousById.get(d.id);
    const label = `${d.module} · ${d.title}`;
    const fresh = d.history.slice(p ? p.history.length : 0);

    for (const change of fresh) {
      if (change.field === "added" && change.from === "removed") {
        lines.push(`${label} — back on QMplus`);
      } else if (change.field === "added") {
        lines.push(`${label} — new deadline, ${d.due ? `due ${formatShort(d.due)}` : "date TBC"}`);
      } else if (change.field === "removed") {
        lines.push(
          d.status === "user-verified"
            ? `${label} — removed from QMplus, but kept because you confirmed it`
            : `${label} — removed from QMplus`,
        );
      } else if (change.field === "title") {
        lines.push(`${label} — renamed from "${change.from ?? ""}"`);
      } else if (change.field === "due") {
        const from = formatShort(change.from ? { iso: change.from, allDay: false, tz: TZ } : null);
        const to = formatShort(change.to ? { iso: change.to, allDay: false, tz: TZ } : null);
        if (d.status === "user-verified") {
          lines.push(`${label} — a source now says ${to}; keeping your date ${from}`);
        } else {
          lines.push(`${label} — due moved ${from} → ${to}`);
        }
      }
    }

    if (p?.status !== d.status) {
      if (d.status === "needs-check") {
        lines.push(`${label} — needs check: ${d.checkReason ?? "the date looks implausible"}`);
      } else if (d.status === "conflict") {
        const dates = sourceDates(d.sources)
          .sort((a, b) => a - b)
          .map((ms) => formatShort({ iso: new Date(ms).toISOString(), allDay: false, tz: TZ }));
        lines.push(`${label} — conflict: sources disagree (${dates.join(" vs ")})`);
      } else if (p && d.status === "confirmed" && (p.status === "conflict" || p.status === "needs-check")) {
        lines.push(`${label} — date confirmed`);
      }
    }
  }
  return lines;
}
