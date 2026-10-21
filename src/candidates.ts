/**
 * Rule-based date candidates: date and "week N" expressions in sentences that
 * talk about an assessment. No AI. Candidates still go through quote
 * verification before they become sources. See docs/design/04 (Order of trust).
 */

import { isFormative, parseWeight } from "./deadlines.ts";
import type { DateCandidate, PageText, TermWeekMap, TextSource } from "./extraction-types.ts";
import type { Deadline, Instant } from "./types.ts";
import { isoWeekday, isRealDate, londonInstant, monthNumber, resolveWeek } from "./weeks.ts";

/* ------------------------------------------------------------- patterns */

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAY = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)`;
const ORD = String.raw`(?:st|nd|rd|th)?`;

/** "Monday 14th December 2026", "14 Dec", "December 14, 2026", "14/12/2026", "2026-12-14". */
const DATE_RE = new RegExp(
  String.raw`\b(?:(${WEEKDAY}),?\s+(?:the\s+)?)?` +
    String.raw`(?:(\d{1,2})${ORD}\s+(?:of\s+)?(${MONTH})\b\.?(?:,?\s+(\d{4}))?` +
    String.raw`|(${MONTH})\.?\s+(\d{1,2})${ORD}\b(?:,?\s+(\d{4}))?` +
    String.raw`|(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b` +
    String.raw`|(\d{4})-(\d{2})-(\d{2})\b)`,
  "gi",
);

/** "week 9", "Friday of week 9", "week 9 (Friday)". */
const WEEK_RE = new RegExp(
  String.raw`\b(?:(${WEEKDAY})\s+(?:of\s+)?)?(?:teaching\s+)?week\s+(\d{1,2})\b(?:,?\s*\(?(${WEEKDAY})\b\)?)?`,
  "gi",
);

/** "12:00", "5pm", "5.30 pm", "noon", "midnight". */
const TIME_RE = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b|\b(noon|midday|midnight)\b/gi;

const ASSESS_RE =
  /\b(?:due|deadlines?|submit(?:ted)?\s+by|submissions?|submit|hand(?:ed)?[- ]in|exam(?:ination)?s?|tests?|quiz(?:zes)?|presentations?|coursework|assignments?|lab\s+tests?)\b/gi;

/** Assessment words that don't announce an assessment: "exam revision", "unit test". */
const NOT_ASSESS_RE =
  /\b(?:past\s+exam(?:ination)?\s+papers?|(?:exam(?:ination)?s?|tests?)\s+(?:revision|preparation|tips|technique|practice|papers?|cases?|data|suites?|plans?|period|season|timetable|board)s?|unit\s+tests?|mock\s+(?:exam|test)s?|safe\s+exam\s+browser)\b/gi;

/**
 * Words just before a date that make it the start of something, not a
 * deadline: "w/c 26 October", "released on 5 November", "opens Monday 2 Nov".
 */
export const START_BEFORE_RE =
  /(?:\bw\/c|\bw\.c\.|\bweek\s+(?:commencing|beginning|starting|of)|\bfrom|\bstarting|\bstarts?|\bbegins?|\breleased?(?:\s+on)?|\bopens?(?:\s+on)?|\bavailable(?:\s+from)?|\bafter)\s*[:(]?\s*(?:on\s+)?$/i;

/** Words that make a teaching-session sentence a real deadline. */
const DUE_RE = /\b(?:due|deadlines?|submit|submission|hand(?:ed)?[- ]in|takes?\s+place|will\s+be\s+held|sit)\b/i;
const SESSION_RE = /\b(?:lectures?|seminars?|tutorials?|workshops?|lab\s+sessions?|classes)\b/i;
/** Classify the role of one week reference before turning it into a deadline. */
export function weekContext(text: string, index: number, length: number): "due" | "release" | "reference" {
  let before = text.slice(Math.max(0, index - 120), index);
  const after = text.slice(index + length);
  if (/^(?:['’]s)?\s*[:\-–]?\s*(?:announcements?|posts?|emails?|news|feedback|lectures?|seminars?|tutorials?|workshops?|labs?\b(?!\s+(?:tests?|reports?|assessments?))|class(?:es)?|slides|recordings?|notes|materials|sessions?)\b/i.test(after)) return "reference";
  if (/\b(?:feedback|announcements?|posts?|emails?|lectures?|seminars?|slides|recordings?)\b[^.!?;:]{0,65}\b(?:in|by|on|from|for)\s*$/i.test(before)) return "reference";
  // A weekday belongs to the same week reference: "released on Friday of week 7".
  before = before.replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+of)?\s*$/i, "");
  // Carry the release verb across "released week 7 and week 10".
  before = before.replace(/(?:\bweek\s+\d{1,2}\s*(?:,|&|and)\s*)+$/i, "");
  return START_BEFORE_RE.test(before) ? "release" : "due";
}

const CITATION_RE = /\b(?:accessed|retrieved|doi|isbn|proceedings|journal\s+of)\b|\b(?:et\s+al|pp|vol)\.|\(\d{4}[a-z]?\)/i;
const REFERENCES_HEADING_RE = /^\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography|reading\s+list|further\s+reading|works\s+cited|sources)\s*:?\s*$/i;

const TITLE_RE =
  /\b(?:(?:mid-?term|final|class|in-class|online|group|individual|written|practical|programming|lab)\s+)?(?:coursework|assignment|lab\s+test|lab\s+report|test|quiz|exam(?:ination)?|presentation|project|essay|report|viva)(?:\s+(?:\d+|[A-Z])\b)?/gi;

/* ------------------------------------------------------------- segments */

type Segment = { start: number; end: number; text: string; heading?: string };

function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || /[.!?,;]$/.test(t)) return false;
  if (t.split(/\s+/).length > 10) return false;
  return /^[A-Z0-9]/.test(t);
}

/** Sentences (within lines) of one page with the heading above them, minus reference lists and citations. */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let heading: string | undefined;
  let inReferences = false;
  const lineRe = /[^\n]+/g;
  for (let line = lineRe.exec(text); line; line = lineRe.exec(text)) {
    const raw = line[0];
    if (REFERENCES_HEADING_RE.test(raw)) {
      inReferences = true;
      continue;
    }
    if (inReferences) {
      // A plain-words heading ends the reference list; citations have digits and punctuation.
      if (isHeading(raw) && /^[\sA-Za-z&'-]+$/.test(raw) && raw.trim().split(/\s+/).length <= 6) inReferences = false;
      else continue;
    }
    // Sentence ends followed by a capital; keeps "14 Dec. 2026" and "e.g. this" together.
    const cuts: Array<[number, number]> = [];
    let from = 0;
    const endRe = /[.!?]+(?=\s+[A-Z("'“])/g;
    for (let m = endRe.exec(raw); m; m = endRe.exec(raw)) {
      cuts.push([from, m.index + m[0].length]);
      from = m.index + m[0].length;
    }
    cuts.push([from, raw.length]);
    for (const [a, b] of cuts) {
      const lead = raw.slice(a, b).search(/\S/);
      if (lead < 0) continue;
      const start = line.index + a + lead;
      const end = line.index + b;
      const segText = text.slice(start, end);
      if (CITATION_RE.test(segText)) continue;
      const seg: Segment = { start, end, text: segText };
      if (heading !== undefined) seg.heading = heading;
      out.push(seg);
    }
    if (isHeading(raw)) heading = raw.trim();
  }
  return out;
}

/** Assessment words left after removing "exam revision" and the like. */
function hasAssessmentWord(sentence: string): boolean {
  const cleaned = sentence.replace(NOT_ASSESS_RE, " ");
  ASSESS_RE.lastIndex = 0;
  if (!ASSESS_RE.test(cleaned)) return false;
  return !SESSION_RE.test(cleaned) || DUE_RE.test(cleaned);
}

/* ------------------------------------------------------------- dates */

type Found = {
  index: number; // within the segment
  length: number;
  date: Instant | null;
  weekNumber?: number;
  weekMapSource?: TermWeekMap["source"];
  tbcReason?: string;
};

function weekdayNumber(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const key = name.slice(0, 3).toLowerCase();
  const n = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(key);
  return n < 0 ? undefined : n + 1;
}

/** The time nearest to `at` in the segment, as hours and minutes. */
function nearestTime(text: string, at: number): { hour: number; minute: number } | undefined {
  let best: { hour: number; minute: number; distance: number } | undefined;
  TIME_RE.lastIndex = 0;
  for (let m = TIME_RE.exec(text); m; m = TIME_RE.exec(text)) {
    let hour: number;
    let minute = 0;
    if (m[6]) {
      const word = m[6].toLowerCase();
      [hour, minute] = word === "midnight" ? [23, 59] : [12, 0];
    } else {
      const ampm = (m[3] ?? m[5])?.toLowerCase();
      // "12.00" without am/pm is too often a number; "12:00" is a time.
      if (m[1] !== undefined && text[m.index + m[1].length] === "." && !ampm) continue;
      hour = Number(m[1] ?? m[4]);
      minute = m[2] !== undefined ? Number(m[2]) : 0;
      if (ampm) {
        if (hour < 1 || hour > 12) continue;
        if (ampm === "pm" && hour !== 12) hour += 12;
        if (ampm === "am" && hour === 12) hour = 0;
      }
    }
    if (hour > 23 || minute > 59) continue;
    const distance = Math.abs(m.index - at);
    if (!best || distance < best.distance) best = { hour, minute, distance };
  }
  return best && { hour: best.hour, minute: best.minute };
}

/** Year for a day and month the text gives without one, if unambiguous within the academic year. */
function inferYear(
  year: string,
  month: number,
  day: number,
  weekday: number | undefined,
): { year: number } | { reason: string } {
  const match = /^(\d{4})/.exec(year);
  if (!match) return { reason: `The text gives no year and the academic year "${year}" is unknown.` };
  const first = Number(match[1]);
  // The academic year runs 1 Aug to 30 Sep the following year, so Aug and Sep occur twice.
  const options = month >= 10 ? [first] : month <= 7 ? [first + 1] : [first, first + 1];
  const valid = options.filter((y) => isRealDate(y, month, day));
  const fits = weekday === undefined ? valid : valid.filter((y) => isoWeekday(y, month, day) === weekday);
  if (fits.length === 1) return { year: fits[0]! };
  if (valid.length === 0) return { reason: "The text gives a day that doesn't exist." };
  return { reason: `The text gives no year, and ${year} has that date twice (${first} and ${first + 1}).` };
}

function findDates(seg: Segment, ctx: { year: string; weekMap?: TermWeekMap }): Found[] {
  const out: Found[] = [];
  const text = seg.text;
  DATE_RE.lastIndex = 0;
  for (let m = DATE_RE.exec(text); m; m = DATE_RE.exec(text)) {
    let day: number;
    let month: number | undefined;
    let year: number | undefined;
    if (m[2] !== undefined) [day, month, year] = [Number(m[2]), monthNumber(m[3]!), m[4] ? Number(m[4]) : undefined];
    else if (m[5] !== undefined) [month, day, year] = [monthNumber(m[5]), Number(m[6]), m[7] ? Number(m[7]) : undefined];
    else if (m[8] !== undefined) {
      [day, month, year] = [Number(m[8]), Number(m[9]), Number(m[10])];
      if (m[10]!.length === 2) year = 2000 + year;
    } else [year, month, day] = [Number(m[11]), Number(m[12]), Number(m[13])];
    if (month === undefined || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const weekday = weekdayNumber(m[1]);
    const found: Found = { index: m.index, length: m[0].length, date: null };
    const startsHere = START_BEFORE_RE.test(text.slice(Math.max(0, m.index - 30), m.index));
    if (startsHere) {
      // Kept as a dated-less candidate: the item exists, its deadline isn't stated.
      found.tbcReason = "The quote gives when this starts or opens, not its deadline.";
      out.push(found);
      continue;
    }
    if (year === undefined) {
      const inferred = inferYear(ctx.year, month, day, weekday);
      if ("reason" in inferred) found.tbcReason = inferred.reason;
      else year = inferred.year;
    }
    if (year !== undefined) {
      if (!isRealDate(year, month, day)) continue;
      found.date = londonInstant(year, month, day, nearestTime(text, m.index + m[0].length));
    }
    out.push(found);
  }
  WEEK_RE.lastIndex = 0;
  for (let m = WEEK_RE.exec(text); m; m = WEEK_RE.exec(text)) {
    // "Week 3 lecture" names a session, not a deadline.
    const context = weekContext(text, m.index, m[0].length);
    if (context === "reference") continue;
    const weekNumber = Number(m[2]);
    if (weekNumber < 1 || weekNumber > 15) continue;
    if (out.some((f) => m.index < f.index + f.length && f.index < m.index + m[0].length)) continue;
    const found: Found = { index: m.index, length: m[0].length, date: null, weekNumber };
    if (context === "release") {
      found.tbcReason = `The quote says week ${weekNumber} is when this starts or opens, not its deadline.`;
      delete found.weekNumber;
      out.push(found);
      continue;
    }
    const day = weekdayNumber(m[1] ?? m[3]);
    if (ctx.weekMap && day === undefined) {
      // "In week 6" names a week, not a day: picking its Monday would be a guess.
      const monday = resolveWeek(ctx.weekMap, weekNumber, 1);
      const label = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(new Date(monday.iso));
      found.tbcReason = `The text says week ${weekNumber} (the week of ${label}) but not which day.`;
    } else if (ctx.weekMap) {
      const time = nearestTime(text, m.index + m[0].length);
      const hhmm = time && `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
      found.date = resolveWeek(ctx.weekMap, weekNumber, day!, hhmm);
      found.weekMapSource = ctx.weekMap.source;
    } else {
      found.tbcReason = `The text says week ${weekNumber}, but the teaching-week calendar for this term isn't known.`;
    }
    out.push(found);
  }
  return out.sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------- titles, kinds, quotes */

function titlePhrases(text: string): Array<{ index: number; phrase: string }> {
  const out: Array<{ index: number; phrase: string }> = [];
  TITLE_RE.lastIndex = 0;
  for (let m = TITLE_RE.exec(text); m; m = TITLE_RE.exec(text)) out.push({ index: m.index, phrase: m[0] });
  return out;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const KIND_TITLE: Record<Deadline["kind"], string> = {
  coursework: "Coursework",
  exam: "Exam",
  quiz: "Quiz",
  presentation: "Presentation",
  lab: "Lab assessment",
  other: "Deadline",
};

/** A heading or source title is a title only when it names an assessment and reads like one. */
function usableTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length > 80 || /[.!?]\s+\S/.test(trimmed) || /\b(?:the|a|an|and|of|to)$/i.test(trimmed)) return undefined;
  return titlePhrases(trimmed).length > 0 ? trimmed : undefined;
}

function chooseTitle(seg: Segment, at: number, fallback: string): string {
  const phrases = titlePhrases(seg.text);
  const distinct = new Set(phrases.map((p) => p.phrase.toLowerCase()));
  const heading = usableTitle(seg.heading);
  if (heading && distinct.size < 2) return heading;
  if (phrases.length > 0) {
    // The phrase before the date, else the first after it.
    const before = phrases.filter((p) => p.index <= at);
    const pick = before.length > 0 ? before[before.length - 1]! : phrases[0]!;
    return capitalise(pick.phrase.replace(/\s+/g, " "));
  }
  // Never a sentence fragment: a named heading or source title, else the kind.
  return heading ?? usableTitle(fallback) ?? KIND_TITLE[inferKind(seg.text)];
}

export function inferKind(text: string): Deadline["kind"] {
  if (/\blab(?:oratory)?\s+(?:tests?|reports?|exams?|assessments?)\b/i.test(text)) return "lab";
  if (/\bquiz(?:zes)?\b/i.test(text)) return "quiz";
  if (/\b(?:exam(?:ination)?s?|tests?)\b/i.test(text)) return "exam";
  if (/\b(?:presentations?|vivas?|demos?|demonstrations?)\b/i.test(text)) return "presentation";
  if (/\b(?:coursework|assignments?|essays?|reports?|projects?|submi(?:t|ssion)|due|hand(?:ed)?[- ]in)\b/i.test(text)) {
    return "coursework";
  }
  return "other";
}

type Word = { start: number; end: number };

function words(text: string): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * A verbatim slice of the page, 5-40 words: the sentence, cut around the date
 * when longer, widened into the neighbouring text when shorter. Null when the
 * page itself has fewer than 5 words.
 */
function quoteFor(pageText: string, all: Word[], seg: Segment, at: number): string | null {
  if (all.length < 5) return null;
  let first = all.findIndex((w) => w.end > seg.start);
  let last = all.findLastIndex((w) => w.start < seg.end);
  if (first < 0 || last < first) return null;
  const hit = Math.max(first, all.findLastIndex((w) => w.start <= at));
  if (last - first + 1 > 40) {
    first = Math.max(first, hit - 15);
    last = Math.min(last, first + 39);
  }
  while (last - first + 1 < 5) {
    if (last < all.length - 1) last++;
    else first--;
  }
  return pageText.slice(all[first]!.start, all[last]!.end);
}

/* ------------------------------------------------------------- entry points */

/** Rule-based date candidates in one text source. */
export function findCandidates(
  source: TextSource,
  ctx: { year: string; weekMap?: TermWeekMap; now: Date },
): DateCandidate[] {
  const out: DateCandidate[] = [];
  const seen = new Set<string>();
  for (const page of source.pages) {
    const pageWords = words(page.text);
    for (const seg of segments(page.text)) {
      if (!hasAssessmentWord(seg.text)) continue;
      for (const found of findDates(seg, ctx)) {
        const quote = quoteFor(page.text, pageWords, seg, seg.start + found.index);
        if (quote === null) continue;
        const title = chooseTitle(seg, found.index, source.title);
        const candidate: DateCandidate = {
          origin: "rule",
          title,
          kind: inferKind(`${title} ${seg.text}`),
          date: found.date,
          quote,
          sourceType: source.type,
          url: source.url,
          page: page.page,
        };
        if (found.weekNumber !== undefined) candidate.weekNumber = found.weekNumber;
        if (found.weekMapSource) candidate.weekMapSource = found.weekMapSource;
        const weight = parseWeight(seg.text);
        if (weight !== undefined) candidate.weight = weight;
        if (isFormative(`${title} ${seg.text}`) || /\bnot\s+count\s+towards\b/i.test(seg.text)) candidate.formative = true;
        if (source.localPath !== undefined) candidate.localPath = source.localPath;
        if (found.tbcReason !== undefined) candidate.tbcReason = found.tbcReason;
        const key = `${page.page}|${title}|${found.date?.iso ?? `w${found.weekNumber}`}|${quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
      }
    }
  }
  return out;
}

/**
 * Cheap check for "this document talks about assessments": a sentence with an
 * assessment word and a date, a week number or a percentage. Decides which
 * documents go to the AI.
 */
export function looksLikeAssessmentText(pages: PageText[]): boolean {
  for (const page of pages) {
    for (const seg of segments(page.text)) {
      if (!hasAssessmentWord(seg.text)) continue;
      if (/\d+(?:\.\d+)?\s*%/.test(seg.text)) return true;
      DATE_RE.lastIndex = 0;
      WEEK_RE.lastIndex = 0;
      if (DATE_RE.test(seg.text) || WEEK_RE.test(seg.text)) return true;
    }
  }
  return false;
}
