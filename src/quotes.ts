/**
 * Quote verification: every rule or AI candidate must carry a verbatim quote
 * (5-40 words) found on its page, and its date (and time, when it has one)
 * must parse from that quote. Fail -> rejected with the reason. See
 * docs/design/04 (Quote verification).
 */

import { instantFromAiDate } from "./ai-extract.ts";
import type { DateCandidate, PageText, TextSource, VerificationResult } from "./extraction-types.ts";
import type { Instant } from "./types.ts";

const TZ = "Europe/London";
export const MIN_QUOTE_WORDS = 5;
export const MAX_QUOTE_WORDS = 40;

/* ------------------------------------------------------------- normalising */

/**
 * Lower case, straight quotes, plain hyphens, single spaces; drops soft
 * hyphens and zero-width characters. Applied to both quote and page text.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function countWords(text: string): number {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ").length : 0;
}

/* ------------------------------------------------------------- date parsing */

/** A date reference found in text. `month` is 1-12, `weekday` 0 (Sunday) to 6. */
export type ParsedDate =
  | { kind: "date"; day: number; month: number; year?: number; text: string; index: number }
  | { kind: "weekday"; weekday: number; text: string; index: number }
  | { kind: "week"; week: number; text: string; index: number };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = String.raw`(?:,?\s+(\d{4}))?`;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const DAY_MONTH = new RegExp(String.raw`\b${DAY}(?:\s+of)?[\s-]+${MONTH}(?![a-z])${YEAR}(?!\d)`, "gi");
const MONTH_DAY = new RegExp(String.raw`\b${MONTH}(?![a-z])\s+${DAY}(?![\d:])(?!\s*(?:am|pm)\b)${YEAR}(?!\d)`, "gi");
const NUMERIC = /\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const WEEKDAY = /\b(sun|mon|tues|wednes|thurs|fri|satur)day\b/gi;
const WEEK = /\b(?:teaching\s+)?(?:week|wk)\.?\s*(\d{1,2})(?!\d)/gi;

function monthNumber(name: string): number {
  return MONTHS[name.toLowerCase().slice(0, 3)] ?? 0;
}

function validDate(day: number, month: number, year?: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysIn = new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate(); // leap year when no year
  return day <= daysIn;
}

/**
 * Every date reference in `text`: day-month with or without a year ("13
 * November", "Nov 13th, 2026"), numeric dd/mm/yyyy (UK order) and ISO dates,
 * weekday names, and "week N". Sorted by position; overlapping matches keep
 * the first found.
 */
export function parseDatesInText(text: string): ParsedDate[] {
  const found: ParsedDate[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => taken.every(([s, e]) => end <= s || start >= e);
  const add = (match: RegExpExecArray, parsed: ParsedDate | null) => {
    if (!parsed || !free(match.index, match.index + match[0].length)) return;
    taken.push([match.index, match.index + match[0].length]);
    found.push(parsed);
  };
  const date = (match: RegExpExecArray, day: number, month: number, year?: number): ParsedDate | null =>
    validDate(day, month, year)
      ? { kind: "date", day, month, ...(year !== undefined ? { year } : {}), text: match[0], index: match.index }
      : null;

  for (const m of text.matchAll(ISO_DATE)) add(m, date(m, Number(m[3]), Number(m[2]), Number(m[1])));
  for (const m of text.matchAll(DAY_MONTH)) add(m, date(m, Number(m[1]), monthNumber(m[2]!), m[3] ? Number(m[3]) : undefined));
  for (const m of text.matchAll(MONTH_DAY)) add(m, date(m, Number(m[2]), monthNumber(m[1]!), m[3] ? Number(m[3]) : undefined));
  for (const m of text.matchAll(NUMERIC)) {
    const year = m[4]!.length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
    add(m, date(m, Number(m[1]), Number(m[3]), year));
  }
  for (const m of text.matchAll(WEEKDAY)) {
    const weekday = WEEKDAYS.indexOf(m[0].toLowerCase());
    add(m, { kind: "weekday", weekday, text: m[0], index: m.index });
  }
  for (const m of text.matchAll(WEEK)) add(m, { kind: "week", week: Number(m[1]), text: m[0], index: m.index });
  return found.sort((a, b) => a.index - b.index);
}


/** A time of day stated in text, London local. "midnight" is 23:59 of its day. */
export type ParsedTime = { hour: number; minute: number; text: string; index: number };

const CLOCK = /(?<![\d:.])(\d{1,2}):(\d{2})(?!\d)(?:\s*([ap])\.?m\b\.?)?/gi;
const MERIDIEM = /(?<![\d:.])(\d{1,2})(?:\.(\d{2}))?\s*([ap])\.?m(?![a-z])\.?/gi;
const NAMED_TIME = /\b(noon|midday|midnight)\b/gi;

/** 12-hour clock -> 24-hour; null when out of range. */
function clockHour(hour: number, meridiem: string | undefined): number | null {
  if (meridiem === undefined) return hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  return (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
}

/**
 * Every time of day in `text`: "16:00", "4:30pm", "4pm", "4.30 p.m.", and
 * "noon" or "midday" (12:00) and "midnight" (23:59). A bare "4.30" is not a
 * time. Sorted by position.
 */
export function parseTimesInText(text: string): ParsedTime[] {
  const found: ParsedTime[] = [];
  const taken: [number, number][] = [];
  const add = (match: RegExpExecArray, hour: number | null, minute: number) => {
    const [start, end] = [match.index, match.index + match[0].length];
    if (hour === null || minute > 59 || !taken.every(([s, e]) => end <= s || start >= e)) return;
    taken.push([start, end]);
    found.push({ hour, minute, text: match[0].trim(), index: start });
  };
  for (const m of text.matchAll(CLOCK)) add(m, clockHour(Number(m[1]), m[3]), Number(m[2]));
  for (const m of text.matchAll(MERIDIEM)) add(m, clockHour(Number(m[1]), m[3]), m[2] ? Number(m[2]) : 0);
  for (const m of text.matchAll(NAMED_TIME)) {
    const midnight = m[1]!.toLowerCase() === "midnight";
    add(m, midnight ? 23 : 12, midnight ? 59 : 0);
  }
  return found.sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------- verification */

/** Resolves "week N" (and optionally a weekday, 0 = Sunday) through the trusted teaching-week calendar. */
export type WeekDateResolver = (weekNumber: number, weekday?: number) => Instant | null;

export type VerifyOptions = { resolveWeekDate?: WeekDateResolver };

/** A verified candidate that was changed on the way, and why. */
export type AdjustedCandidate = { candidate: DateCandidate; reason: string };

export type QuoteVerification = VerificationResult & { adjusted: AdjustedCandidate[] };

type LondonTime = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

/** Calendar date and wall-clock time of an instant in London (all-day dates as written). */
function londonTime(instant: Instant): LondonTime | null {
  const weekdayOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(instant.iso);
  if (plain) {
    const [year, month, day] = [Number(plain[1]), Number(plain[2]), Number(plain[3])];
    if (!validDate(day, month, year)) return null;
    return { year, month, day, weekday: weekdayOf(year, month, day), hour: 0, minute: 0 };
  }
  const ms = Date.parse(instant.iso);
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const [year, month, day] = [get("year"), get("month"), get("day")];
  return { year, month, day, weekday: weekdayOf(year, month, day), hour: get("hour"), minute: get("minute") };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const show = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const clock = (t: { hour: number; minute: number }) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
const weekdayName = (weekday: number) => WEEKDAYS[weekday]!.replace(/^./, (c) => c.toUpperCase());
const sameDay = (a: LondonTime, b: LondonTime) => a.year === b.year && a.month === b.month && a.day === b.day;

type DateCheck = { ok: true; weekMapped: boolean } | { ok: false; reason: string } | { tbc: string };

/**
 * Does the quote itself give the candidate's calendar date? `quote` is
 * normalised. A day-month in the quote decides; failing that, "week N" is
 * resolved through the injected week map and must match it exactly; a
 * weekday alone never gives a date.
 */
function checkDate(candidate: DateCandidate, target: LondonTime, quote: string, resolveWeekDate?: WeekDateResolver): DateCheck {
  const refs = parseDatesInText(quote);
  const dates = refs.filter((r) => r.kind === "date");
  const weeks = refs.filter((r) => r.kind === "week");
  const weekdays = refs.filter((r) => r.kind === "weekday");
  const saidWeekdays = weekdays.map((w) => weekdayName(w.weekday)).join(", ");

  if (dates.some((d) => d.day === target.day && d.month === target.month && (d.year === undefined || d.year === target.year))) {
    return { ok: true, weekMapped: false };
  }
  if (dates.length > 0) {
    const said = dates.map((d) => `${d.day} ${MONTH_NAMES[d.month - 1]}${d.year !== undefined ? ` ${d.year}` : ""}`);
    return { ok: false, reason: `date ${show(target)} is not the date in the quote (${said.join(", ")})` };
  }
  if (weeks.length > 0) {
    const numbers = weeks.map((w) => w.week);
    const said = `week ${numbers.join(", ")}`;
    if (candidate.weekNumber === undefined || !numbers.includes(candidate.weekNumber)) {
      const own = candidate.weekNumber === undefined ? "no week number" : `week ${candidate.weekNumber}`;
      return { ok: false, reason: `the quote gives ${said} but the candidate has ${own}` };
    }
    const week = candidate.weekNumber;
    if (!resolveWeekDate) return { tbc: `the quote gives ${said} but the teaching-week calendar is not known` };
    const asked = weekdays.length > 0 ? `${saidWeekdays} of week ${week}` : `week ${week}`;
    const resolved = (weekdays.length > 0 ? weekdays.map((w) => resolveWeekDate(week, w.weekday)) : [resolveWeekDate(week)])
      .map((instant) => (instant ? londonTime(instant) : null))
      .filter((t): t is LondonTime => t !== null);
    if (resolved.length === 0) return { tbc: `the teaching-week calendar has no date for ${asked}` };
    if (!resolved.some((r) => sameDay(r, target))) {
      return { ok: false, reason: `date ${show(target)} is not ${asked} in the teaching-week calendar (${resolved.map(show).join(", ")})` };
    }
    if (!candidate.weekMapSource) return { tbc: `the date for ${asked} has no teaching-week calendar source` };
    return { ok: true, weekMapped: true };
  }
  if (weekdays.length > 0) return { tbc: `the quote gives only a weekday (${saidWeekdays}), not a date` };
  return { ok: false, reason: `no date in the quote for ${show(target)}` };
}

function findPage(pages: PageText[], quote: string): PageText | undefined {
  return pages.find((page) => normalizeText(page.text).includes(quote));
}

/**
 * Checks each candidate against `source`. Verified candidates come back as
 * copies with `page` filled in. A dated candidate whose quote gives only a
 * weekday, or only "week N" that the injected `resolveWeekDate` cannot
 * confirm, is kept as tbc (date null, quote kept). A timed candidate must
 * have a time the quote states; when the quote states none, the date is kept
 * as all-day and the candidate is listed in `adjusted` with the reason.
 */
export function verifyCandidates(candidates: DateCandidate[], source: TextSource, opts: VerifyOptions = {}): QuoteVerification {
  const result: QuoteVerification = { verified: [], rejected: [], adjusted: [] };
  const reject = (candidate: DateCandidate, reason: string) => result.rejected.push({ candidate, reason });

  for (const candidate of candidates) {
    const quote = normalizeText(candidate.quote ?? "");
    if (!quote) {
      reject(candidate, "no quote");
      continue;
    }
    const words = quote.split(" ").length;
    if (words < MIN_QUOTE_WORDS || words > MAX_QUOTE_WORDS) {
      reject(candidate, `quote has ${words} words, needs ${MIN_QUOTE_WORDS}-${MAX_QUOTE_WORDS}`);
      continue;
    }
    if (candidate.url !== source.url) {
      reject(candidate, `candidate is from ${candidate.url}, not this source (${source.url})`);
      continue;
    }

    let page: number;
    if (candidate.page !== undefined) {
      const own = source.pages.find((p) => p.page === candidate.page);
      if (!own) {
        reject(candidate, `page ${candidate.page} is not in the source`);
        continue;
      }
      if (!normalizeText(own.text).includes(quote)) {
        const elsewhere = findPage(source.pages, quote);
        reject(
          candidate,
          elsewhere
            ? `quote not found on page ${candidate.page} (it is on page ${elsewhere.page})`
            : `quote not found on page ${candidate.page}`,
        );
        continue;
      }
      page = own.page;
    } else {
      const found = findPage(source.pages, quote);
      if (!found) {
        reject(candidate, "quote not found in the source text");
        continue;
      }
      page = found.page;
    }

    const { weekMapSource: _weekMapSource, ...unmapped } = candidate;
    if (candidate.date === null) {
      const tbcReason =
        candidate.tbcReason ??
        (candidate.weekNumber !== undefined ? `the quote gives week ${candidate.weekNumber} but no date` : "the quote gives no date");
      result.verified.push({ ...candidate, page, tbcReason });
      continue;
    }

    const target = londonTime(candidate.date);
    if (!target) {
      reject(candidate, `date "${candidate.date.iso}" is not a valid date`);
      continue;
    }
    const check = checkDate(candidate, target, quote, opts.resolveWeekDate);
    if ("tbc" in check) {
      result.verified.push({ ...unmapped, date: null, page, tbcReason: check.tbc });
      continue;
    }
    if (!check.ok) {
      reject(candidate, check.reason);
      continue;
    }
    // weekMapSource is kept only when the date really came from the week map.
    const dated: DateCandidate = check.weekMapped ? { ...candidate, page } : { ...unmapped, page };
    if (candidate.date.allDay) {
      result.verified.push(dated);
      continue;
    }

    const times = parseTimesInText(quote);
    if (times.length === 0) {
      const allDay: DateCandidate = { ...dated, date: instantFromAiDate(show(target))! };
      result.verified.push(allDay);
      result.adjusted.push({ candidate: allDay, reason: `the quote states no time, so ${clock(target)} was dropped and the date kept as all-day` });
    } else if (times.some((t) => t.hour === target.hour && t.minute === target.minute)) {
      result.verified.push(dated);
    } else {
      reject(candidate, `time ${clock(target)} is not the time in the quote (${times.map((t) => t.text).join(", ")})`);
    }
  }
  return result;
}
