/**
 * Teaching-week calendars: "week 9" -> a date. Seeded per university from the
 * config below, or from a verified "Week 1 starts …" quote in a module.
 * See docs/design/04 (Week-number resolution).
 */

import type { TermWeekMap } from "./extraction-types.ts";
import type { Instant } from "./types.ts";

const TZ = "Europe/London";
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------- config */

type TermConfig = { termStart: string; readingWeeks: number[]; weeks: number };

/**
 * Term starts per university and term label ("2026-27 Semester A").
 *
 * UPDATE YEARLY: add the next academic year's rows when the university
 * publishes its calendar (QM: https://www.qmul.ac.uk/about/calendar/).
 * `termStart` is the Monday of teaching week 1. `readingWeeks` lists the
 * calendar weeks (1 = the week of `termStart`) that the university leaves out
 * of its week numbering; QM numbers its reading week (week 7 is reading week,
 * teaching resumes in week 8), so nothing is skipped there.
 *
 * `weeks` is how many numbered weeks the term has (reading week included).
 *
 * QM 2026-27 Semester A is confirmed: teaching began on Tuesday 22 Sep 2026,
 * so week 1 is the week of Monday 21 Sep, which QMplus section names agree
 * with ("Assessment 1 - Week 11: Monday 30/11/2026"). Its numbered week 7
 * is a reading week, so it remains in the map. Semester B and Surrey 2026-27
 * have published term dates but no verified module week-number maps; see 02.
 */
export const TERM_WEEKS: Record<string, Record<string, TermConfig>> = {
  qmul: {
    "2026-27 Semester A": { termStart: "2026-09-21", readingWeeks: [], weeks: 12 },
  },
  // Surrey key dates (surrey.ac.uk/about/facts/key-dates): Semester 1 teaching
  // 28 Sep - 11 Dec 2026; Semester 2 from 8 Feb 2027 with spring vacation
  // 22 Mar - 9 Apr (calendar weeks 7-9, left out of the numbering) to 14 May.
  // Surrey says "Semester 1/2"; the labels stay A/B like QM's.
  surrey: {
    "2026-27 Semester A": { termStart: "2026-09-28", readingWeeks: [], weeks: 11 },
    "2026-27 Semester B": { termStart: "2027-02-08", readingWeeks: [7, 8, 9], weeks: 11 },
  },
};

/** The configured week map for a term, or null when the term isn't configured. */
export function weekMapFor(universityId: string, termLabel: string): TermWeekMap | null {
  const term = TERM_WEEKS[universityId]?.[termLabel];
  if (!term) return null;
  return { termStart: term.termStart, readingWeeks: [...term.readingWeeks], source: { kind: "config" } };
}

/** The teaching week a moment falls in, e.g. { term: "2026-27 Semester A", week: 4 }. */
export type TeachingWeek = { term: string; week: number; monday: string };

/**
 * Which teaching week `at` falls in, read in London time. Null outside every
 * configured term, during a reading week the university leaves unnumbered, or
 * for a university with no calendar.
 */
export function teachingWeekAt(universityId: string, at: Date | number): TeachingWeek | null {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(at))
    .split("-")
    .map(Number);
  const day = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!);
  for (const [term, config] of Object.entries(TERM_WEEKS[universityId] ?? {})) {
    const start = Date.parse(`${config.termStart}T00:00:00Z`);
    const calendarWeek = Math.floor((day - start) / (7 * DAY_MS)) + 1;
    if (calendarWeek < 1 || config.readingWeeks.includes(calendarWeek)) continue;
    const week = calendarWeek - config.readingWeeks.filter((w) => w < calendarWeek).length;
    if (week > config.weeks) continue;
    const monday = new Date(start + (calendarWeek - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
    return { term, week, monday };
  }
  return null;
}

/* ------------------------------------------------------------- London time */

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

/** True when year/month (1-12)/day is a real calendar date. */
export function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * An Instant for a London wall-clock date and time (month 1-12). Without a
 * time it is all-day, anchored at London midnight of that date.
 */
export function londonInstant(year: number, month: number, day: number, time?: { hour: number; minute: number }): Instant {
  const wall = Date.UTC(year, month - 1, day, time?.hour ?? 0, time?.minute ?? 0);
  const utc = wall - londonOffset(wall - londonOffset(wall));
  return { iso: new Date(utc).toISOString(), allDay: time === undefined, tz: TZ };
}

/** 1 = Monday … 7 = Sunday, for a calendar date. */
export function isoWeekday(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d === 0 ? 7 : d;
}

/* ------------------------------------------------------------- resolution */

/** "12:00" / "9:30" -> parts, or null. */
function parseTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/**
 * The date of teaching week `weekNumber` in London: `dayOfWeek` 1 (Monday,
 * the default) to 7 (Sunday), `time` "HH:MM" (all-day when omitted). Calendar
 * weeks listed in `readingWeeks` are skipped in the numbering.
 */
export function resolveWeek(map: TermWeekMap, weekNumber: number, dayOfWeek = 1, time?: string): Instant {
  if (!Number.isInteger(weekNumber) || weekNumber < 1) throw new Error(`Invalid week number: ${weekNumber}`);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) throw new Error(`Invalid day of week: ${dayOfWeek}`);
  const start = /^(\d{4})-(\d{2})-(\d{2})$/.exec(map.termStart);
  if (!start) throw new Error(`Invalid term start: ${map.termStart}`);
  let calendarWeek = 0;
  for (let teaching = 0; teaching < weekNumber; ) {
    calendarWeek++;
    if (!map.readingWeeks.includes(calendarWeek)) teaching++;
  }
  const offsetDays = (calendarWeek - 1) * 7 + (dayOfWeek - 1);
  const day = new Date(Date.UTC(Number(start[1]), Number(start[2]) - 1, Number(start[3])) + offsetDays * DAY_MS);
  let parsedTime: { hour: number; minute: number } | undefined;
  if (time !== undefined) {
    const t = parseTime(time);
    if (!t) throw new Error(`Invalid time: ${time}`);
    parsedTime = t;
  }
  return londonInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), parsedTime);
}

/* ------------------------------------------------------------- quotes */

export const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Month number for "December", "Dec", "Sept", or undefined. */
export function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase().replace(/\.$/, "");
  return MONTHS[key.slice(0, 3)];
}

const MONTH_RE =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const WEEK1_RE = new RegExp(
  String.raw`\bweek\s*(?:1|one)\b[^.\n]{0,20}?\b(?:starts|begins|commences|starting|beginning|commencing)\b` +
    String.raw`(?:\s+(?:on|from))?(?:\s+(?:the\s+)?(?:week\s+of|w/c))?\s*` +
    String.raw`(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?` +
    String.raw`(?:(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_RE})\.?,?\s+(\d{4})` +
    String.raw`|(${MONTH_RE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})` +
    String.raw`|(\d{1,2})[/.](\d{1,2})[/.](\d{4})` +
    String.raw`|(\d{4})-(\d{2})-(\d{2}))`,
  "i",
);

/**
 * A week map from a verbatim quote such as "Week 1 starts on Monday 21
 * September 2026". The year must be in the quote. A date that isn't a Monday
 * is moved back to the Monday of its week. Null when the quote doesn't say.
 */
export function weekMapFromQuote(quote: string, url: string): TermWeekMap | null {
  const m = WEEK1_RE.exec(quote);
  if (!m) return null;
  let y: number, mo: number | undefined, d: number;
  if (m[1] !== undefined) [d, mo, y] = [Number(m[1]), monthNumber(m[2]!), Number(m[3])];
  else if (m[4] !== undefined) [mo, d, y] = [monthNumber(m[4]), Number(m[5]), Number(m[6])];
  else if (m[7] !== undefined) [d, mo, y] = [Number(m[7]), Number(m[8]), Number(m[9])];
  else [y, mo, d] = [Number(m[10]), Number(m[11]), Number(m[12])];
  if (mo === undefined || !isRealDate(y, mo, d)) return null;
  const back = isoWeekday(y, mo, d) - 1;
  const monday = new Date(Date.UTC(y, mo - 1, d) - back * DAY_MS);
  return {
    termStart: monday.toISOString().slice(0, 10),
    readingWeeks: [],
    source: { kind: "quote", quote, url },
  };
}
