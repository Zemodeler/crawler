/**
 * Exam practice: which deadlines are exams or tests, how long until they,
 * what to focus on, and which of a module's files to practise from.
 *
 * Everything here is pure: the Assessments page gathers the module's files,
 * opened-file progress and flashcard reviews (all already stored by the hub)
 * and passes them in.
 *
 * URL contract for the pages the practice buttons open (`/flashcards?tab=practice`
 * and `/generate`), built by `practiceHref` and read by `parseSourceParams`:
 *
 *   module=<year>/<module folder>   which module to practise
 *   source=<module-relative path>   repeated, one per auto-picked file
 *   auto=1                          the sources were picked automatically
 *   exam=<title>                    the assessment being prepared for
 */

import { SUPPORTED_EXTS, canonicalTopicKey, inferCategory, topicLabel, topicName, type Category } from "./course-format.ts";

/** The categories of file a student practises from; generated packs and decks are not sources. */
export const SOURCE_CATEGORIES: readonly Category[] = ["Source materials", "Seminars", "Past papers", "Course materials"];

export type ExamFile = { path: string; modified: number };

/** The subset of a Deadline this module reads. */
export type ExamDeadline = { kind: string; title: string; status?: string };

/** Exams, tests and quizzes: by kind, or by the words in the title. */
export function isExamLike(d: ExamDeadline): boolean {
  return d.kind === "exam" || d.kind === "quiz" || /\b(tests?|exams?|examinations?|quiz(?:zes)?)\b/i.test(d.title);
}

/* ---------------------------------------------------------------- countdown */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Midnight (UTC-based) of the London calendar day, so two instants subtract to whole days. */
function londonDay(at: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return Date.parse(`${parts}T00:00:00Z`);
}

export type Countdown = { label: string; days: number; urgent: boolean; passed: boolean };

/**
 * "In 3 days", "Tomorrow", "Today". `from` and `to` are the earliest and latest
 * moment it can fall (equal for a dated deadline; a teaching week for one that
 * only names its week). `allDay` deadlines count whole London days.
 */
export function countdown(from: number, to: number, allDay: boolean, now: number): Countdown {
  if (now > to && (!allDay || londonDay(now) > londonDay(to))) return { label: "Passed", days: -1, urgent: false, passed: true };
  if (to > from && now >= from) return { label: "This week", days: 0, urgent: true, passed: false };
  const hours = (from - now) / HOUR;
  if (!allDay && hours >= 0 && hours < 24) {
    const whole = Math.floor(hours);
    return { label: whole < 1 ? "Within the hour" : `In ${whole} hour${whole === 1 ? "" : "s"}`, days: 0, urgent: true, passed: false };
  }
  const days = Math.round((londonDay(from) - londonDay(now)) / DAY);
  if (days <= 0) return { label: "Today", days: 0, urgent: true, passed: false };
  if (days === 1) return { label: "Tomorrow", days, urgent: true, passed: false };
  if (days < 14) return { label: `In ${days} days`, days, urgent: days <= 7, passed: false };
  const weeks = Math.round(days / 7);
  return { label: `In ${weeks} weeks`, days, urgent: false, passed: false };
}

/* ------------------------------------------------------------------ ranking */

/** Words that say what kind of assessment it is, not what it covers. */
const GENERIC = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "assessment", "assessments", "exam", "exams", "examination",
  "test", "tests", "quiz", "quizzes", "final", "paper", "module", "coursework", "mark", "marks", "marked", "week", "weeks",
  "part", "mid", "midterm", "term", "semester", "online", "written", "mcq", "formative", "summative", "resit",
  "lecture", "lectures", "slides", "slide", "notes", "pdf", "docx", "pptx", "ppt", "txt", "csv", "course", "materials", "material",
]);

/** Lower-case word stems of at least 3 characters, without filler or the assessment's generic words. */
export function keywords(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !GENERIC.has(w) && !/^\d/.test(w));
  // Module codes (ECS505U) say which module, not which topic.
  const topical = words.filter((w) => !/^[a-z]{2,4}\d{3,4}[a-z]?$/.test(w));
  return [...new Set(topical.map(stem))];
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** How many of `words` appear in `text` (whole stems, or a shared prefix of 5+ letters). */
function overlap(words: string[], text: string): number {
  if (!words.length) return 0;
  const found = new Set((text.toLowerCase().match(/[a-z][a-z0-9]*/g) || []).map(stem));
  let hits = 0;
  for (const word of words)
    if (found.has(word) || (word.length >= 5 && [...found].some((f) => f.length >= 5 && (f.startsWith(word) || word.startsWith(f))))) hits++;
  return hits;
}

export type RankedFile = ExamFile & { score: number; relevant: boolean };

const RELEVANCE_WEIGHT = 10;
const PAST_PAPER_BONUS = 8;
const RECENCY_WEIGHT = 5;

/**
 * A module's practice sources, best first: files whose path names the same
 * things as the assessment, past papers when it is an exam, then the most
 * recently changed. Generated packs, decks and guides are never sources.
 */
export function rankSources(files: ExamFile[], assessmentText: string, opts: { exam?: boolean } = {}): RankedFile[] {
  const wanted = keywords(assessmentText);
  const candidates = files.filter((f) => {
    const ext = f.path.split(".").pop()?.toLowerCase() || "";
    return SUPPORTED_EXTS.has(ext) && SOURCE_CATEGORIES.includes(inferCategory(f.path, ext));
  });
  const times = candidates.map((f) => f.modified);
  const oldest = Math.min(...times);
  const span = Math.max(...times) - oldest;
  return candidates
    .map((f) => {
      const ext = f.path.split(".").pop()?.toLowerCase() || "";
      const topical = overlap(wanted, f.path) * RELEVANCE_WEIGHT;
      const paper = opts.exam && inferCategory(f.path, ext) === "Past papers" ? PAST_PAPER_BONUS : 0;
      const recency = span > 0 ? ((f.modified - oldest) / span) * RECENCY_WEIGHT : 0;
      return { ...f, score: topical + paper + recency, relevant: topical + paper > 0 };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * The files to practise from: every relevant one up to `limit`, topped up with
 * the most recent to at least `min`, so a title that names no topic still gets sources.
 */
export function pickSources(files: ExamFile[], assessmentText: string, opts: { exam?: boolean; limit?: number; min?: number } = {}): RankedFile[] {
  const { limit = 5, min = 3 } = opts;
  const ranked = rankSources(files, assessmentText, opts);
  const relevant = ranked.filter((f) => f.relevant).slice(0, limit);
  if (relevant.length >= min) return relevant;
  const filler = ranked.filter((f) => !f.relevant).slice(0, min - relevant.length);
  return [...relevant, ...filler].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export const fileName = (path: string) => path.split("/").pop() || path;

/* -------------------------------------------------------------------- focus */

/** One flashcard review as the flashcards page stores it. */
export type ReviewRecord = { confidence: number };

export type FocusItem = {
  kind: "topic" | "cards" | "files";
  label: string;
  detail?: string;
};

export type FocusInput = {
  files: ExamFile[];
  /** Title plus the matching assessment component's description. */
  text: string;
  /** Module-relative path -> when it was opened. */
  opened: Record<string, number>;
  /** Card id (`<csv path>:<hash>`) -> review. */
  reviews: Record<string, ReviewRecord>;
  /** Module-relative CSV path -> number of cards in it. */
  cardCounts: Record<string, number>;
  exam?: boolean;
};

const WEAK_AT_OR_BELOW = 2;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type TopicStat = { key: string; name: string; number: number; weak: number; unreviewed: number; relevance: number };

/**
 * What to focus on, from what the hub already knows: the study-pack topics
 * (the ones the assessment names first, then the weakest), weak and unreviewed
 * flashcards, and course files not opened yet.
 */
export function buildFocus(input: FocusInput): FocusItem[] {
  const wanted = keywords(input.text);

  // Reviews belong to a deck by their card id's path prefix.
  const reviewedByDeck = new Map<string, { reviewed: number; weak: number }>();
  for (const [id, review] of Object.entries(input.reviews)) {
    const deck = id.slice(0, id.lastIndexOf(":"));
    const entry = reviewedByDeck.get(deck) || { reviewed: 0, weak: 0 };
    entry.reviewed++;
    if (review.confidence <= WEAK_AT_OR_BELOW) entry.weak++;
    reviewedByDeck.set(deck, entry);
  }

  const topics = new Map<string, TopicStat>();
  const topic = (path: string) => {
    const key = canonicalTopicKey(path);
    let stat = topics.get(key);
    if (!stat) {
      const label = topicLabel(path);
      const number = Number(label.match(/^(\d{1,2})\s*[-–.]/)?.[1] ?? 99);
      const name = topicName(path);
      stat = { key, name, number, weak: 0, unreviewed: 0, relevance: overlap(wanted, name) };
      topics.set(key, stat);
    }
    return stat;
  };
  let weakTotal = 0;
  let unreviewedTotal = 0;
  for (const f of input.files) {
    const ext = f.path.split(".").pop()?.toLowerCase();
    if (ext === "md" && inferCategory(f.path, ext) === "Study packs") topic(f.path);
  }
  for (const [path, count] of Object.entries(input.cardCounts)) {
    const seen = reviewedByDeck.get(path) || { reviewed: 0, weak: 0 };
    const unreviewed = Math.max(0, count - seen.reviewed);
    weakTotal += seen.weak;
    unreviewedTotal += unreviewed;
    // A loose deck with no numbered topic folder belongs to no topic.
    if (!topics.has(canonicalTopicKey(path)) && !/^\d{1,2}\s*[-–.]/.test(topicLabel(path))) continue;
    const stat = topic(path);
    stat.weak += seen.weak;
    stat.unreviewed += unreviewed;
  }

  const items: FocusItem[] = [];
  const ordered = [...topics.values()].sort(
    (a, b) => b.relevance - a.relevance || b.weak - a.weak || b.unreviewed - a.unreviewed || a.number - b.number || a.name.localeCompare(b.name),
  );
  const named = ordered.filter((t) => t.relevance > 0);
  // Name the topics the assessment mentions; otherwise the ones that need most work.
  const pool = named.length ? named : ordered.filter((t) => t.weak > 0 || t.unreviewed > 0);
  for (const t of (pool.length ? pool : ordered).slice(0, 3)) {
    const detail = [t.weak ? `${plural(t.weak, "weak card")}` : "", t.unreviewed ? `${t.unreviewed} not reviewed yet` : ""].filter(Boolean).join(" · ");
    items.push({ kind: "topic", label: t.name, ...(detail ? { detail } : {}) });
  }
  if (weakTotal) items.push({ kind: "cards", label: `Revisit ${plural(weakTotal, "weak flashcard")}`, detail: "Rated 1 or 2 when you last reviewed them" });
  if (unreviewedTotal) items.push({ kind: "cards", label: `${plural(unreviewedTotal, "flashcard")} not reviewed yet` });

  const unopened = rankSources(input.files, input.text, { exam: input.exam }).filter((f) => !input.opened[f.path]);
  if (unopened.length)
    items.push({
      kind: "files",
      label: `${plural(unopened.length, "file")} not opened yet`,
      detail: `${unopened.slice(0, 3).map((f) => fileName(f.path)).join(", ")}${unopened.length > 3 ? ", ..." : ""}`,
    });
  return items;
}

/* --------------------------------------------------------------- practice URL */

export type PracticeTarget = "flashcards" | "generate";

/** The link a "Practise for this" button follows, carrying the auto selection. */
export function practiceHref(target: PracticeTarget, opts: { module: string; sources: string[]; exam: string; auto?: boolean }): string {
  const query = new URLSearchParams();
  if (target === "flashcards") {
    query.set("tab", "practice");
    query.set("mode", "smart");
  }
  query.set("module", opts.module);
  for (const source of opts.sources) query.append("source", source);
  if (opts.auto !== false) query.set("auto", "1");
  query.set("exam", opts.exam);
  return `/${target}?${query.toString()}`;
}

export type SourceParams = { module: string; sources: string[]; auto: boolean; exam: string };

/** Reads what `practiceHref` wrote; an empty `sources` means "no preselection". */
export function parseSourceParams(search: string): SourceParams {
  const query = new URLSearchParams(search);
  return {
    module: query.get("module") || "",
    sources: [...new Set(query.getAll("source").filter(Boolean))],
    auto: query.get("auto") === "1",
    exam: query.get("exam") || "",
  };
}
