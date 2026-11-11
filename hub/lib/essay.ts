/**
 * The essay workspace in Practice: the student writes (or imports) an essay
 * and works on it with the assistant, which can see the module's files. It
 * makes a plan for the time the student has, suggests readings that would
 * make the essay stand out, marks the passages that are not good enough yet,
 * and answers questions about it.
 *
 * Everything the assistant returns is checked here before it is shown:
 * - a mark quotes the draft; a quote that is not in the draft is dropped,
 *   because a comment pinned to text the student never wrote is worse than none;
 * - a reading is "from your course" only when a cited quote from that file
 *   verified, "checked on the web" only when the reply cited that URL from a
 *   real web search, and otherwise is labelled as something to check exists.
 *
 * Essays live in the module's `.study-hub/essays.json`, so they survive cleared
 * browser data. Pure apart from the load/save helpers at the bottom.
 */

import type { ChatCitation, ChatTurn } from "./ai/chat.ts";
import { parseTurn } from "./chat-store.ts";

export const ESSAYS_PATH = ".study-hub/essays.json";
const GUARD = { "x-study-hub-host": "1" };
const localKey = (course: string) => `studyhub:essays:${course}`;

export type MarkSeverity = "major" | "minor" | "strength";
export type EssayMark = { quote: string; comment: string; severity: MarkSeverity };

export type ReadingSource = "course" | "web" | "knowledge";
export type Reading = {
  title: string;
  author?: string;
  why: string;
  /** Where the model says it came from; `verified` says whether Study Hub could confirm that. */
  source: ReadingSource;
  file?: string;
  url?: string;
  verified: boolean;
};

export type EssayTurn = ChatTurn;

export type Essay = {
  id: string;
  title: string;
  /** The question or title the essay answers. */
  question: string;
  /** The assignment brief or marking criteria, pasted by the student. */
  brief: string;
  wordLimit: number | null;
  /** London calendar day it is due, YYYY-MM-DD. */
  due: string | null;
  /** The deadline it was linked to, if the student picked one. */
  deadlineId?: string;
  /** Hours the student will give it in total. */
  hours: number | null;
  text: string;
  plan: { markdown: string; at: string; citations: ChatCitation[] } | null;
  review: { summary: string; marks: EssayMark[]; dropped: number; at: string; citations: ChatCitation[] } | null;
  readings: { intro: string; items: Reading[]; at: string; usedWebSearch: boolean } | null;
  chat: EssayTurn[];
  created: string;
  updated: string;
};

export type EssayFile = { version: 1; essays: Essay[] };

export const emptyEssayFile = (): EssayFile => ({ version: 1, essays: [] });

export function newEssay(input: Pick<Essay, "title" | "question" | "brief" | "wordLimit" | "due" | "hours"> & { deadlineId?: string }, now = new Date()): Essay {
  const at = now.toISOString();
  return {
    id: `essay-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: input.title.trim() || "Untitled essay",
    question: input.question.trim(),
    brief: input.brief.trim(),
    wordLimit: input.wordLimit,
    due: input.due,
    ...(input.deadlineId ? { deadlineId: input.deadlineId } : {}),
    hours: input.hours,
    text: "",
    plan: null,
    review: null,
    readings: null,
    chat: [],
    created: at,
    updated: at,
  };
}

export const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/* --------------------------------------------------------------- validation */

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const SEVERITIES: MarkSeverity[] = ["major", "minor", "strength"];
const SOURCES: ReadingSource[] = ["course", "web", "knowledge"];

function citations(v: unknown): ChatCitation[] {
  if (!Array.isArray(v)) return [];
  const turn = parseTurn({ role: "assistant", content: "", citations: v });
  return turn?.citations ?? [];
}

function parseEssay(value: unknown): Essay | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  const plan = e.plan && typeof e.plan === "object" ? (e.plan as Record<string, unknown>) : null;
  const review = e.review && typeof e.review === "object" ? (e.review as Record<string, unknown>) : null;
  const readings = e.readings && typeof e.readings === "object" ? (e.readings as Record<string, unknown>) : null;
  return {
    id: e.id,
    title: str(e.title, "Untitled essay") || "Untitled essay",
    question: str(e.question),
    brief: str(e.brief),
    wordLimit: num(e.wordLimit),
    due: day(e.due),
    ...(typeof e.deadlineId === "string" ? { deadlineId: e.deadlineId } : {}),
    hours: num(e.hours),
    text: str(e.text),
    plan: plan && typeof plan.markdown === "string" ? { markdown: plan.markdown, at: str(plan.at), citations: citations(plan.citations) } : null,
    review: review && typeof review.summary === "string" && Array.isArray(review.marks)
      ? {
          summary: review.summary,
          marks: review.marks.flatMap((m) => {
            const mark = m as Record<string, unknown>;
            return mark && typeof mark.quote === "string" && typeof mark.comment === "string" && SEVERITIES.includes(mark.severity as MarkSeverity)
              ? [{ quote: mark.quote, comment: mark.comment, severity: mark.severity as MarkSeverity }]
              : [];
          }),
          dropped: typeof review.dropped === "number" ? review.dropped : 0,
          at: str(review.at),
          citations: citations(review.citations),
        }
      : null,
    readings: readings && Array.isArray(readings.items)
      ? {
          intro: str(readings.intro),
          items: readings.items.flatMap((r) => {
            const item = r as Record<string, unknown>;
            if (!item || typeof item.title !== "string" || !SOURCES.includes(item.source as ReadingSource)) return [];
            return [{
              title: item.title,
              ...(typeof item.author === "string" ? { author: item.author } : {}),
              why: str(item.why),
              source: item.source as ReadingSource,
              ...(typeof item.file === "string" ? { file: item.file } : {}),
              ...(typeof item.url === "string" ? { url: item.url } : {}),
              verified: item.verified === true,
            }];
          }),
          at: str(readings.at),
          usedWebSearch: readings.usedWebSearch === true,
        }
      : null,
    chat: Array.isArray(e.chat) ? e.chat.map(parseTurn).filter((t): t is EssayTurn => t !== null) : [],
    created: str(e.created),
    updated: str(e.updated),
  };
}

export function parseEssayFile(value: unknown): EssayFile {
  if (!value || typeof value !== "object") return emptyEssayFile();
  const list = (value as { essays?: unknown }).essays;
  return { version: 1, essays: Array.isArray(list) ? list.map(parseEssay).filter((e): e is Essay => e !== null) : [] };
}

/* ------------------------------------------------------------------ prompts */

/** "Wednesday 11 November 2026" for a YYYY-MM-DD day. */
function longDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The essay itself as untrusted material for the assistant's context. */
export function essayBlock(essay: Essay): string {
  return [
    `Title: ${essay.title}`,
    essay.question ? `Question: ${essay.question}` : "",
    essay.wordLimit ? `Word limit: ${essay.wordLimit}` : "",
    essay.due ? `Due: ${longDay(essay.due)}` : "",
    essay.hours ? `Time the student will give it: ${essay.hours} hours in total` : "",
    essay.brief ? `Brief and marking criteria, as the student pasted them:\n${essay.brief}` : "",
    `Current draft (${wordCount(essay.text)} words):`,
    essay.text.trim() || "(nothing written yet)",
  ].filter(Boolean).join("\n");
}

const COACH = [
  "You are coaching a university student on their own essay. Help them write a better essay; never write it",
  "for them. Short example sentences to show a technique are fine, whole paragraphs are not.",
  "Point them to the course material that helps: name the file (as in a SOURCE MATERIAL header) and what",
  "in it is useful, and cite it in the sources footer so it links to the file.",
].join("\n");

export function chatInstructions(): string {
  return [COACH, "Answer the student's question about their essay. Be specific to their draft and their question."].join("\n");
}

export function planInstructions(essay: Essay, today: string): string {
  const time = essay.hours ? `${essay.hours} hours in total` : "an amount of time they did not say (assume about 10 hours and say so)";
  const due = essay.due ? `It is due on ${longDay(essay.due)}.` : "It has no due date set; plan over the next two weeks and say so.";
  return [
    COACH,
    `TASK: write a plan for how the student gets from where the draft is now to a finished essay, using ${time}.`,
    `Today is ${longDay(today)}. ${due}`,
    "Format: a short opening line on the approach, then numbered steps. Each step: what to do, the hours it",
    "takes, and by which date. The hours must add up to the time given. Include reading the specific course",
    "files that help (by name), outlining the argument, drafting, a review pass against the brief or marking",
    "criteria, referencing, and a final proofread. If the draft already has parts done, skip or shorten",
    "those steps. End with a short 'To make it stand out' list of two to four concrete ideas for this essay.",
  ].join("\n");
}

export const MARK_PREFIX = "MARK:";

export function reviewInstructions(essay: Essay): string {
  return [
    COACH,
    "TASK: review the draft the way a strict marker would, against the question and the brief or marking criteria.",
    "First write a short summary: what grade band it is heading for and the two or three changes that would",
    "lift it most. Then, before any sources footer, one line per passage that needs work (or is a real strength):",
    `${MARK_PREFIX} major|minor|strength | <exact words copied from the draft, 5-30 words> | <what is wrong or good, and how to fix it>`,
    "major: costs real marks (weak or missing argument, unsupported claim, off the question, wrong fact).",
    "minor: style, clarity, referencing format, word choice. strength: worth keeping, at most three.",
    "Copy the quoted words exactly as they appear in the draft, character for character. Say where it is not",
    "good enough plainly; do not soften it. Mention anything the brief asks for that the draft does not do.",
    essay.wordLimit ? `The word limit is ${essay.wordLimit}; the draft has ${wordCount(essay.text)} words. Say if that is a problem.` : "",
  ].filter(Boolean).join("\n");
}

export const READING_PREFIX = "READING:";

export function readingsInstructions(webSearch: boolean): string {
  return [
    COACH,
    "TASK: recommend four to eight readings that would make this essay stronger and stand out. Start with the",
    "readings in the course material (reading lists, slides, set texts). Then add well-known academic works",
    "on the topic that go beyond the course.",
    webSearch
      ? "You have web search this turn and must use it: look up EVERY reading that is not in the course material, " +
        "and give it source web with the URL of a page that confirms it (publisher, DOI, library or author page). " +
        "Use source knowledge only when the search found nothing, and say so in its why."
      : "",
    "Write one short opening line, then one line per reading, before any sources footer:",
    `${READING_PREFIX} {"title":"...","author":"...","why":"what it adds to this essay, in one sentence","source":"course|web|knowledge","file":"<course file name if source is course>","url":"<link if source is web>"}`,
    "source: course = it is named in the course material (give the file); web = you found it with a web search",
    "this turn (give the URL); knowledge = from what you know, not checked. Never invent a title, author or URL.",
    "Cite each course file and each web page you relied on in the sources footer.",
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------ parsing */

/**
 * Letters and digits only, lower case, one space between words: a quote
 * still matches when the model drops punctuation, curly quotes or a line break.
 */
function normalise(text: string): { text: string; origin: number[] } {
  let out = "";
  const origin: number[] = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[\p{L}\p{N}]/u.test(c)) {
      if (gap && out) {
        out += " ";
        origin.push(i);
      }
      gap = false;
      out += c.toLowerCase();
      origin.push(i);
    } else gap = true;
  }
  return { text: out, origin };
}

/** Where `quote` sits in `text`, ignoring case, spacing and punctuation; null when it is not there. */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const wanted = normalise(quote).text;
  if (wanted.length < 8) return null;
  const hay = normalise(text);
  const at = hay.text.indexOf(wanted);
  if (at < 0) return null;
  return { start: hay.origin[at], end: hay.origin[at + wanted.length - 1] + 1 };
}

/**
 * Splits a review reply into its summary and the marks whose quotes are
 * really in the draft. `dropped` counts marks that quoted something else.
 */
export function parseReview(prose: string, draft: string): { summary: string; marks: EssayMark[]; dropped: number } {
  const marks: EssayMark[] = [];
  const kept: string[] = [];
  let dropped = 0;
  for (const line of prose.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(MARK_PREFIX)) {
      kept.push(line);
      continue;
    }
    const [severity, quote, ...rest] = trimmed.slice(MARK_PREFIX.length).split("|").map((p) => p.trim());
    const comment = rest.join(" | ").trim();
    const clean = (quote || "").replace(/^["'“‘]+|["'”’]+$/g, "").trim();
    if (!SEVERITIES.includes(severity as MarkSeverity) || !clean || !comment || !locateQuote(draft, clean)) {
      dropped++;
      continue;
    }
    marks.push({ quote: clean, comment, severity: severity as MarkSeverity });
  }
  return { summary: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), marks, dropped };
}

const fileMatches = (cited: string, named: string) => {
  const a = cited.toLowerCase();
  const b = named.toLowerCase();
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
};
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").replace(/^https?:\/\//, "") === b.replace(/\/+$/, "").replace(/^https?:\/\//, "");

/**
 * Reads READING lines and decides, from the reply's checked citations, which
 * claims Study Hub could confirm. Lines that do not parse are left out.
 */
export function parseReadings(prose: string, cited: ChatCitation[], usedWebSearch: boolean): { intro: string; items: Reading[] } {
  const items: Reading[] = [];
  const kept: string[] = [];
  for (const line of prose.split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed.startsWith(READING_PREFIX)) {
      kept.push(line);
      continue;
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed.slice(READING_PREFIX.length).trim());
    } catch {
      continue;
    }
    if (!raw || typeof raw.title !== "string" || !raw.title.trim()) continue;
    const source: ReadingSource = SOURCES.includes(raw.source as ReadingSource) ? (raw.source as ReadingSource) : "knowledge";
    const file = typeof raw.file === "string" && raw.file.trim() ? raw.file.trim() : undefined;
    const url = typeof raw.url === "string" && /^https?:\/\//i.test(raw.url.trim()) ? raw.url.trim() : undefined;
    let verified = false;
    if (source === "course" && file)
      verified = cited.some((c) => c.kind === "file" && c.verdict === "verified" && fileMatches(c.sourceFile, file));
    if (source === "web" && url) verified = usedWebSearch && cited.some((c) => c.kind === "web" && sameUrl(c.url, url));
    items.push({
      title: raw.title.trim(),
      ...(typeof raw.author === "string" && raw.author.trim() ? { author: raw.author.trim() } : {}),
      why: typeof raw.why === "string" ? raw.why.trim() : "",
      source,
      ...(file ? { file } : {}),
      ...(url ? { url } : {}),
      verified,
    });
  }
  return { intro: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), items };
}

/** The draft cut into plain and marked pieces, in order, for showing marks in place. Overlapping marks keep the first. */
export function markedSegments(text: string, marks: EssayMark[]): { text: string; mark?: EssayMark; index?: number }[] {
  const spans = marks
    .map((mark, index) => ({ mark, index, at: locateQuote(text, mark.quote) }))
    .filter((s): s is { mark: EssayMark; index: number; at: { start: number; end: number } } => s.at !== null)
    .sort((a, b) => a.at.start - b.at.start);
  const out: { text: string; mark?: EssayMark; index?: number }[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.at.start < cursor) continue;
    if (span.at.start > cursor) out.push({ text: text.slice(cursor, span.at.start) });
    out.push({ text: text.slice(span.at.start, span.at.end), mark: span.mark, index: span.index });
    cursor = span.at.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

/* ------------------------------------------------------------- load / save */

export async function loadEssays(course: string, hosted: boolean): Promise<EssayFile> {
  if (!hosted) {
    try {
      return parseEssayFile(JSON.parse(localStorage.getItem(localKey(course)) || "null"));
    } catch {
      return emptyEssayFile();
    }
  }
  const response = await fetch(`/api/library/module-file?${new URLSearchParams({ module: course, path: ESSAYS_PATH })}`, { headers: GUARD });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Could not read your essays (${response.status}).`);
  if (typeof body.text !== "string") return emptyEssayFile();
  try {
    return parseEssayFile(JSON.parse(body.text));
  } catch {
    return emptyEssayFile();
  }
}

export async function saveEssays(course: string, hosted: boolean, file: EssayFile): Promise<void> {
  const content = JSON.stringify(file);
  if (!hosted) {
    localStorage.setItem(localKey(course), content);
    return;
  }
  const response = await fetch("/api/library/module-file", {
    method: "PUT",
    headers: { ...GUARD, "content-type": "application/json" },
    body: JSON.stringify({ module: course, path: ESSAYS_PATH, content }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Could not save your essay (${response.status}).`);
  }
}
