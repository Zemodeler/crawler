/**
 * The text pipeline: deadlines hidden in downloaded documents, announcements,
 * pages and assignment intros. For one course it builds text sources, finds
 * candidates (rules, then AI when allowed), verifies every quote and turns the
 * verified ones into sources on the VLE deadlines of the module, or into new
 * text-only deadlines. See docs/design/04 (Order of trust) and 05.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { extractWithAi, planAiRuns, sourceHash } from "./ai-extract.ts";
import { findCandidates, looksLikeAssessmentText } from "./candidates.ts";
import { detectConflict, statusFor } from "./deadlines.ts";
import { renameWithRetry } from "./fs-retry.ts";
import { cachedExtract } from "./extract/cache.ts";
import { detectFormat, htmlToText } from "./extract/index.ts";
import type { DateCandidate, RejectedCandidate, TermWeekMap, TextSource } from "./extraction-types.ts";
import { parseDatesInText, parseTimesInText, verifyCandidates } from "./quotes.ts";
import type { WeekDateResolver } from "./quotes.ts";
import type { AiRunner, Course, Deadline, ManifestEntry, ModulePlacement, Source, VleItem } from "./types.ts";
import { resolveWeek, weekMapFor } from "./weeks.ts";

const STATE_DIR = ".crawler";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** More sources than this on a course's first AI run need the student's go-ahead. */
export const AI_CONFIRM_ABOVE = 20;
const OVERLAP = 0.6;
const TZ = "Europe/London";

export type TextCounts = {
  sources: number;
  candidates: number;
  verified: number;
  rejected: number;
  adjusted: number;
  aiRuns: number;
  aiMs: number;
  /** Why AI did not run although a runner was given. */
  aiSkipped?: string;
  /** AI requests that failed (they are retried next sync). */
  aiFailures?: number;
};

export type TextDeadlinesInput = {
  universityId: string;
  /** The My Studies folder. */
  root: string;
  course: Course;
  placement: ModulePlacement;
  items: VleItem[];
  /** Manifest entries of this course (files already written). */
  manifest: ManifestEntry[];
  /** The VLE-field deadlines of this course, from deadlinesFromItems. */
  deadlines: Deadline[];
  now: Date;
  ai?: AiRunner;
  confirmAi?: (documents: number) => Promise<boolean>;
};

export type TextDeadlinesResult = { deadlines: Deadline[]; counts: TextCounts };

/* ------------------------------------------------------------- week map */

/**
 * The teaching-week calendar for a course: Semester A for a course that
 * starts Sep-Dec and ends before February, Semester B for one starting
 * Jan-May and ending by July of that year. Year-long or unknown courses get none,
 * so week-only dates stay tbc.
 */
export function weekMapForCourse(universityId: string, course: Course, placement: ModulePlacement): TermWeekMap | null {
  if (course.startdate === null || course.enddate === null) return null;
  const start = new Date(course.startdate * 1000);
  const end = new Date(course.enddate * 1000);
  const month = start.getUTCMonth(); // 0 = January
  if (month >= 8 && end.getTime() < Date.UTC(start.getUTCFullYear() + 1, 1, 1)) {
    return weekMapFor(universityId, `${placement.year} Semester A`);
  }
  if (month <= 4 && end.getTime() < Date.UTC(start.getUTCFullYear(), 7, 1)) {
    return weekMapFor(universityId, `${placement.year} Semester B`);
  }
  return null;
}

/* ------------------------------------------------------------- sources */

const isPage = (text: string) => text.trim().length > 0;

async function documentSources(root: string, entries: ManifestEntry[]): Promise<TextSource[]> {
  // The page body of a page activity comes from the VLE item, not the written file.
  const latest = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    if (entry.vleId.startsWith("moodle:page:")) continue;
    const seen = latest.get(entry.sourceUrl);
    if (!seen || entry.writtenAt >= seen.writtenAt) latest.set(entry.sourceUrl, entry);
  }
  const base = resolve(root);
  const out: TextSource[] = [];
  for (const entry of [...latest.values()].sort((a, b) => a.localPath.localeCompare(b.localPath))) {
    const filename = entry.localPath.split("/").slice(-1)[0] ?? entry.localPath;
    if (!detectFormat(filename).readable) continue;
    const full = resolve(base, ...entry.localPath.split("/"));
    if (!full.startsWith(base + sep)) continue;
    try {
      if ((await stat(full)).size > MAX_FILE_BYTES) continue;
      const bytes = await readFile(full);
      const doc = await cachedExtract(join(base, STATE_DIR), bytes, filename);
      if (!doc.pages.some((p) => isPage(p.text))) continue;
      out.push({ type: "document", title: filename, url: entry.sourceUrl, localPath: entry.localPath, pages: doc.pages });
    } catch {
      // A file we cannot read has no text to offer; the course goes on.
    }
  }
  return out;
}

function itemSources(items: VleItem[], manifest: ManifestEntry[]): TextSource[] {
  const pagePath = new Map(manifest.filter((e) => e.vleId.startsWith("moodle:page:")).map((e) => [e.vleId, e.localPath]));
  const out: TextSource[] = [];
  const add = (source: Omit<TextSource, "pages"> & { html: string }) => {
    const { html, ...rest } = source;
    const text = htmlToText(html);
    if (isPage(text)) out.push({ ...rest, pages: [{ page: 1, text }] });
  };
  for (const item of items) {
    if (item.kind === "announcement") {
      add({ type: "announcement", title: item.subject, url: item.url, html: item.bodyHtml });
    } else if (item.kind === "page") {
      const localPath = pagePath.get(`moodle:page:${item.activityId}`);
      add({ type: "page", title: item.activity, url: item.activityUrl, ...(localPath ? { localPath } : {}), html: item.html });
    } else if (item.kind === "assignment") {
      add({ type: "page", title: item.title, url: item.url, html: item.introHtml });
    }
  }
  return out;
}

/* ------------------------------------------------------------- week-only quotes */

/** Resolves "week N" quotes that name no date through the map, before verification. */
function resolveWeekOnly(candidate: DateCandidate, map: TermWeekMap | null): DateCandidate {
  if (!map || candidate.date !== null || candidate.weekNumber === undefined) return candidate;
  const refs = parseDatesInText(candidate.quote);
  if (refs.some((r) => r.kind === "date")) return candidate;
  if (!refs.some((r) => r.kind === "week" && r.week === candidate.weekNumber)) return candidate;
  const weekday = refs.find((r) => r.kind === "weekday");
  // "In week 9" without a day stays TBC: its Monday would be a guess.
  if (!weekday || weekday.kind !== "weekday") return candidate;
  const dayOfWeek = weekday.weekday === 0 ? 7 : weekday.weekday;
  const times = parseTimesInText(candidate.quote);
  const time = times.length === 1 ? `${String(times[0]!.hour).padStart(2, "0")}:${String(times[0]!.minute).padStart(2, "0")}` : undefined;
  try {
    return { ...candidate, date: resolveWeek(map, candidate.weekNumber, dayOfWeek, time), weekMapSource: map.source };
  } catch {
    return candidate;
  }
}

function weekResolver(map: TermWeekMap | null): WeekDateResolver | undefined {
  if (!map) return undefined;
  return (week, weekday) => {
    try {
      if (weekday === undefined) return null; // a week without a day is not a date
      return resolveWeek(map, week, weekday === 0 ? 7 : weekday);
    } catch {
      return null;
    }
  };
}

/* ------------------------------------------------------------- matching */

const STOP = new Set(["a", "an", "the", "of", "and", "for", "to", "in", "on", "at", "by", "submission", "link", "due", "deadline"]);

/** Lower-case words of a title, without weights and filler. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?\s*%/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

/** Shared tokens over the shorter title; titles that name different numbers never match. */
export function titleOverlap(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const digits = (s: Set<string>) => [...s].filter((t) => /^\d+$/.test(t));
  const [da, db] = [digits(ta), digits(tb)];
  if (da.length > 0 && db.length > 0 && !da.some((t) => db.includes(t))) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size);
}

function londonDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** The VLE deadline a candidate speaks for: best title overlap >= 0.6, else same kind on the same London day. */
function matchVle(candidate: DateCandidate, vle: Deadline[]): number {
  let best = -1;
  let bestScore = 0;
  let tied = false;
  vle.forEach((d, i) => {
    const score = titleOverlap(candidate.title, d.title);
    if (score < OVERLAP) return;
    if (score > bestScore) [best, bestScore, tied] = [i, score, false];
    else if (score === bestScore) tied = true;
  });
  // A generic title ("Coursework") that fits several deadlines equally must not
  // put its date on whichever comes first.
  if (tied) return -1;
  if (best >= 0 || !candidate.date) return best;
  const day = londonDay(candidate.date.iso);
  return vle.findIndex((d) => d.kind === candidate.kind && d.due !== null && londonDay(d.due.iso) === day);
}

export function textDeadlineId(universityId: string, module: string, title: string, kind: Deadline["kind"]): string {
  const key = `${titleTokens(title).join(" ")}|${kind}`;
  return `${universityId}:${module}:text:${createHash("sha1").update(key).digest("hex")}`;
}

function sourceFrom(candidate: DateCandidate, seenAt: string): Source {
  const source: Source = { type: candidate.sourceType, strength: "quoted", url: candidate.url, quote: candidate.quote, date: candidate.date, seenAt, origin: candidate.origin };
  if (candidate.localPath !== undefined) source.localPath = candidate.localPath;
  if (candidate.page !== undefined) source.page = candidate.page;
  return source;
}

const sameSource = (a: Source, b: Source) =>
  a.type === b.type && a.url === b.url && a.page === b.page && a.quote === b.quote && a.date?.iso === b.date?.iso;

function addSource(sources: Source[], source: Source): Source[] {
  return sources.some((s) => sameSource(s, source)) ? sources : [...sources, source];
}

/* ------------------------------------------------------------- AI hashes and rejected.json */

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameWithRetry(tmp, path);
}

export type RejectedEntry = RejectedCandidate & { module: string };

/** The module's rejected candidates replace its earlier entries; other modules' stay. */
async function writeRejected(path: string, module: string, rejected: RejectedCandidate[]): Promise<void> {
  const others = (await readJson<RejectedEntry[]>(path, [])).filter((e) => e.module !== module);
  await writeJson(path, [...others, ...rejected.map((r) => ({ module, ...r }))]);
}

/* ------------------------------------------------------------- the pipeline */

export async function textDeadlines(input: TextDeadlinesInput): Promise<TextDeadlinesResult> {
  const { universityId, root, course, placement, now } = input;
  const module = placement.code ?? course.shortname;
  const stateDir = join(resolve(root), STATE_DIR);
  const seenAt = now.toISOString();
  const counts: TextCounts = { sources: 0, candidates: 0, verified: 0, rejected: 0, adjusted: 0, aiRuns: 0, aiMs: 0 };

  const sources = [...(await documentSources(root, input.manifest)), ...itemSources(input.items, input.manifest)];
  counts.sources = sources.length;
  const map = weekMapForCourse(universityId, course, placement);

  const candidates: DateCandidate[] = sources.flatMap((s) => findCandidates(s, { year: placement.year, ...(map ? { weekMap: map } : {}), now }));

  if (input.ai) {
    const hashesPath = join(stateDir, "ai-hashes.json");
    const hashes = await readJson<Record<string, string>>(hashesPath, {});
    const available = await input.ai.available();
    if (!available.cli) {
      counts.aiSkipped = "no AI command-line tool is available";
    } else {
      const toRun = planAiRuns(
        sources.filter((s) => looksLikeAssessmentText(s.pages)),
        hashes,
      );
      const firstRun = !sources.some((s) => hashes[s.url] !== undefined);
      let go = toRun.length > 0;
      if (go && toRun.length > AI_CONFIRM_ABOVE && firstRun) {
        if (!input.confirmAi) {
          counts.aiSkipped = `${toRun.length} documents would go to the AI and nothing confirms it`;
          go = false;
        } else if (!(await input.confirmAi(toRun.length))) {
          counts.aiSkipped = "the student declined the AI run";
          go = false;
        }
      }
      if (go) {
        const result = await extractWithAi(input.ai, toRun);
        candidates.push(...result.candidates);
        counts.aiRuns = result.runs;
        counts.aiMs = result.ms;
        const failed = new Set(result.failures.map((f) => f.url));
        if (failed.size > 0) counts.aiFailures = result.failures.length;
        for (const source of toRun) if (!failed.has(source.url)) hashes[source.url] = sourceHash(source);
        await writeJson(hashesPath, hashes);
      }
    }
  }
  counts.candidates = candidates.length;

  // Verify against the source each candidate came from.
  const bySource = new Map(sources.map((s) => [s.url, s]));
  const grouped = new Map<string, DateCandidate[]>();
  const orphans: RejectedCandidate[] = [];
  for (const candidate of candidates) {
    const source = bySource.get(candidate.url);
    if (!source) {
      orphans.push({ candidate, reason: `no text source for ${candidate.url}` });
      continue;
    }
    const list = grouped.get(source.url) ?? [];
    list.push(resolveWeekOnly(candidate, map));
    grouped.set(source.url, list);
  }
  const verified: DateCandidate[] = [];
  const rejected: RejectedCandidate[] = [...orphans];
  const resolveWeekDate = weekResolver(map);
  for (const source of sources) {
    const list = grouped.get(source.url);
    if (!list) continue;
    const result = verifyCandidates(list, source, resolveWeekDate ? { resolveWeekDate } : {});
    verified.push(...result.verified);
    rejected.push(...result.rejected);
    counts.adjusted += result.adjusted.length;
  }
  counts.verified = verified.length;
  counts.rejected = rejected.length;
  await writeRejected(join(stateDir, "rejected.json"), module, rejected);

  // Verified candidates become sources on VLE deadlines or new deadlines.
  const vle = input.deadlines.map((d) => d);
  const fresh = new Map<string, Deadline>();
  const touched = new Set<number>();
  for (const candidate of verified) {
    const source = sourceFrom(candidate, seenAt);
    const hit = matchVle(candidate, vle);
    if (hit >= 0) {
      const existing = vle[hit]!;
      const next = { ...existing, sources: addSource(existing.sources, source) };
      if (existing.due === null && existing.status === "tbc" && source.date) {
        next.due = source.date;
        Object.assign(next, statusFor(new Date(source.date.iso), placement.year, course));
        if (next.status !== "needs-check") delete next.checkReason;
        next.history = [...existing.history, { at: seenAt, field: "due", from: null, to: source.date.iso, source }];
      }
      vle[hit] = next;
      touched.add(hit);
      continue;
    }
    // The same assessment quoted twice under different titles: same kind, same London day.
    // A bare "the deadline is …" (kind other) is the named assessment due that day.
    const sameKind = (d: Deadline) => d.kind === candidate.kind || d.kind === "other" || candidate.kind === "other";
    const sameDay = candidate.date
      ? [...fresh.values()].find((d) => sameKind(d) && d.due !== null && londonDay(d.due.iso) === londonDay(candidate.date!.iso))
      : undefined;
    const id = sameDay?.id ?? textDeadlineId(universityId, module, candidate.title, candidate.kind);
    const existing = fresh.get(id);
    if (existing) {
      const sources = addSource(existing.sources, source);
      const next: Deadline = { ...existing, sources };
      if (existing.due === null && candidate.date) {
        const dueDate = new Date(candidate.date.iso);
        Object.assign(next, statusFor(dueDate, placement.year, course), { due: candidate.date });
        if (next.status !== "needs-check") delete next.checkReason;
      }
      // The named assessment gives the title; a timed date beats an all-day one on the same day.
      if (existing.kind === "other" && candidate.kind !== "other") Object.assign(next, { title: candidate.title, kind: candidate.kind });
      if (next.due?.allDay && candidate.date && !candidate.date.allDay) next.due = candidate.date;
      if (next.weight === undefined && candidate.weight !== undefined) next.weight = candidate.weight;
      if (next.formative === undefined && candidate.formative) next.formative = true;
      fresh.set(id, next);
      continue;
    }
    const deadline: Deadline = {
      id,
      module,
      year: placement.year,
      title: candidate.title,
      kind: candidate.kind,
      ...statusFor(candidate.date ? new Date(candidate.date.iso) : null, placement.year, course),
      due: candidate.date,
      sources: [source],
      history: [],
    };
    if (candidate.weight !== undefined) deadline.weight = candidate.weight;
    if (candidate.formative) deadline.formative = true;
    fresh.set(id, deadline);
  }

  const out = [...vle.map((d, i) => (touched.has(i) ? detectConflict(d) : d)), ...[...fresh.values()].map(detectConflict)];
  return { deadlines: out, counts };
}
