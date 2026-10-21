/** Repair automatic dates whose own quoted week evidence disproves them. */
import { weekContext } from "./candidates.ts";
import type { TermWeekMap } from "./extraction-types.ts";
import { parseDatesInText } from "./quotes.ts";
import type { Deadline, Instant, Source } from "./types.ts";
import { resolveWeek } from "./weeks.ts";

const londonDay = (instant: Instant): string | null => {
  const time = Date.parse(instant.iso);
  return Number.isNaN(time) ? null : new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(time));
};

function dueWeek(quote: string, index: number, length: number): boolean {
  const before = quote.slice(Math.max(0, index - 120), index);
  // weekContext handles "released week 7"; the same role also appears as
  // "released in week 7" in older AI quotes.
  if (/\b(?:released?|opens?|available|starts?|begins?)\s+(?:in|during|by)\s*$/i.test(before)) return false;
  return weekContext(quote, index, length) === "due";
}

function disproved(source: Source, map: TermWeekMap | null): boolean {
  if (source.type === "vle-field" || source.strength !== "quoted" || !source.date) return false;
  const refs = parseDatesInText(source.quote);
  // A calendar date may be the due date. Do not reinterpret ambiguous prose here.
  if (refs.some((ref) => ref.kind === "date")) return false;
  const weeks = refs.filter((ref) => ref.kind === "week");
  if (weeks.length === 0) return false;
  const due = weeks.filter((ref) => dueWeek(source.quote, ref.index, ref.text.length));
  // A stated duration can turn a release week into a due window.
  if (due.length === 0) return !/\b(?:duration(?:\s+of)?|lasts?|open\s+for)\s*:?\s*\d{1,2}\s*days?\b/i.test(source.quote);
  if (!map) return false;
  const sourceDay = londonDay(source.date);
  if (!sourceDay) return false;
  try {
    return !due.some((ref) => {
      // A due week alone identifies a range, not an exact day or time.
      const first = londonDay(resolveWeek(map, ref.week, 1));
      const last = londonDay(resolveWeek(map, ref.week, 7));
      return first !== null && last !== null && sourceDay >= first && sourceDay <= last;
    });
  } catch {
    // A malformed or unavailable calendar cannot disprove a due week.
    return false;
  }
}

/** Preserve source provenance while removing dates contradicted by their own quote. */
export function repairAutomaticWeekDates(deadline: Deadline, map: TermWeekMap | null): Deadline {
  if (deadline.status === "user-verified" || deadline.status === "cancelled") return deadline;
  let changed = false;
  const sources = deadline.sources.map((source) => {
    if (!disproved(source, map)) return source;
    changed = true;
    return { ...source, date: null };
  });
  if (!changed) return deadline;

  const dated = sources.filter((source): source is Source & { date: Instant } => source.date !== null);
  const stillSupported = dated.find((source) => source.date.iso === deadline.due?.iso);
  const preferred = stillSupported ?? dated.find((source) => source.strength === "structured") ?? dated[0];
  const due = preferred?.date ?? null;
  const timedDays = new Set(dated.filter((source) => !source.date.allDay).map((source) => londonDay(source.date)));
  const distinct = new Set(dated.filter((source) => !source.date.allDay || !timedDays.has(londonDay(source.date)))
    .map((source) => source.date.iso));
  const sameDue = due?.iso === deadline.due?.iso;
  const status = distinct.size > 1 ? "conflict" : due ? (sameDue && deadline.status === "needs-check" ? "needs-check" : "confirmed") : "tbc";
  const repaired: Deadline = { ...deadline, sources, due, status };
  if (status !== "needs-check") delete repaired.checkReason;
  return repaired;
}
