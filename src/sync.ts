/**
 * The sync: one pass from a university VLE into the My Studies folder.
 *
 *   list courses → pick the ones to sync → per course: list items, plan files,
 *   download what is new or changed, build deadlines → merge, write, report.
 *
 * Rules (docs/design/03):
 *  - Never destroy the student's work. A file the student edited is never
 *    overwritten (the new version is saved beside it); a file the student moved
 *    is followed by hash; a file the student deleted is not brought back.
 *  - Nothing is half-written: files and state are written to .crawler/tmp and
 *    renamed into place.
 *  - A course that fails does not fail the others, and its previous deadlines
 *    are left exactly as they were.
 *  - The VLE is only read.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { once } from "node:events";

import { changeLines, deadlinesFromItems, mergeDeadlines } from "./deadlines.ts";
import { readDeadlineFile, withDeadlineLock, withSyncLock, writeDeadlineFile } from "./deadline-store.ts";
import type { DeadlineFileOps } from "./deadline-store.ts";
import { parseAssessmentOverview } from "./assessments.ts";
import type { AssessmentComponent } from "./assessments.ts";
import { repairAutomaticWeekDates } from "./revalidate-week-dates.ts";
import { toIcs } from "./ics.ts";
import { selectForumPosts } from "./forum.ts";
import type { ForumHighlight } from "./forum.ts";
import { placeCourse, sanitizeSegment } from "./naming.ts";
import { eventsFromDiff, filesSummary } from "./notifications.ts";
import type { NotificationEvent } from "./notifications.ts";
import { foldIntoDated, mergeSameWeek, placeInWeek, textDeadlines } from "./pipeline.ts";
import type { ExtractionIssue, TextCounts } from "./pipeline.ts";
import type { TermWeekMap } from "./extraction-types.ts";
import { planFiles } from "./sorter.ts";
import type { FileJob } from "./sorter.ts";
import { renameWithRetry } from "./fs-retry.ts";
import { syncTranscripts } from "./transcripts.ts";
import { VleError } from "./types.ts";
import type {
  AiRunner,
  Course,
  Credentials,
  Deadline,
  ManifestEntry,
  ModulePlacement,
  UniversityAdapter,
  VleFile,
  VleItem,
} from "./types.ts";

/* ------------------------------------------------------------- public API */

export type SyncOptions = {
  adapter: UniversityAdapter;
  credentials: Credentials;
  /** The My Studies folder. Created if missing. */
  root: string;
  now?: Date;
  /** Overrides the default course selection (and state.json). */
  select?: (course: Course, placement: ModulePlacement) => boolean;
  /** Parallel downloads within a course. Default 4 (the adapter also limits requests). */
  concurrency?: number;
  /** Finds deadlines hidden in documents with the AI CLI, besides the rules. Off without a runner. */
  ai?: AiRunner;
  /** Asked before the first AI run over more than 20 documents; no callback means no AI run. */
  confirmAi?: (documents: number) => Promise<boolean>;
  /** Read downloaded documents, announcements and pages for deadlines. Default true. */
  textDeadlines?: boolean;
  /** Save lecture-recording captions (Echo360) as text in Transcripts/. Default true. */
  transcripts?: boolean;
  /** Injected for tests; the Echo360 client uses global fetch otherwise. */
  transcriptFetch?: typeof fetch;
  /** Pause between Echo360 requests, in ms (default 500). */
  transcriptPauseMs?: number;
  onProgress?: (event: SyncEvent) => void;
  /** Per-call file operations for storage failure tests. */
  storage?: Partial<DeadlineFileOps>;
};

export type SyncEvent =
  | { type: "course-start"; course: string; folder: string }
  | { type: "course-done"; course: string }
  | { type: "course-failed"; course: string; message: string }
  | { type: "file"; course: string; path: string; result: FileResult };

export type FileResult = "new" | "updated" | "unchanged" | "kept-your-edit" | "moved-by-you" | "deleted-by-you" | "failed";

export type CourseReport = {
  shortname: string;
  folder: string;
  status: "synced" | "skipped" | "failed";
  error?: string;
  files: Record<FileResult, number> & { videosSkipped: number };
  deadlines: number;
  /** Forum posts kept after the relevance filter (see forum.ts). */
  forumPosts?: number;
  /** Counts from the text step; absent when it did not run. */
  text?: TextCounts;
  extractionIssues?: ExtractionIssue[];
  /** Set when the text step failed; the VLE deadlines were kept. */
  textError?: string;
  /** Set when assessment overview parsing failed; the rest of the course synced. */
  assessmentsError?: string;
  /** Lecture transcripts saved this run; absent when the step did not run. */
  transcripts?: { added: number; skippedNoCaptions: number; failed: number; error?: string };
};

export type SyncResult = {
  startedAt: string;
  finishedAt: string;
  courses: CourseReport[];
  deadlines: Deadline[];
  /** What went into Changes.md this run. */
  changes: string[];
  /** What is worth a native notification: date changes, new deadlines and conflicts, new files. */
  notifications: NotificationEvent[];
  /** Set when the assessments file could not be updated; deadlines and state were saved. */
  assessmentsError?: string;
};

/** Per-course switches the student can set in .crawler/state.json. */
export type SyncState = {
  version: 1;
  lastSync: string | null;
  courses: Record<string, { enabled?: boolean }>;
};

export const STATE_DIR = ".crawler";

/** "2026-27" for any date from 1 Aug 2026 to 31 Jul 2027. */
export function currentAcademicYear(now: Date): string {
  const start = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Courses synced unless the student says otherwise: this year's modules. */
export function defaultSelection(now: Date): (course: Course, placement: ModulePlacement) => boolean {
  const year = currentAcademicYear(now);
  return (_course, placement) => placement.isModule && placement.year === year;
}

export async function readState(root: string, io: Partial<DeadlineFileOps> = {}): Promise<SyncState> {
  const path = join(root, STATE_DIR, "state.json");
  let text: string;
  try {
    text = await (io.readFile ?? readFile)(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, lastSync: null, courses: {} };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Cannot read ${path}: invalid JSON. Restore or repair this file before syncing.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Cannot read ${path}: invalid sync state. Restore or repair this file before syncing.`);
  const state = parsed as Partial<SyncState>;
  if (state.version !== 1 || (state.lastSync !== null && typeof state.lastSync !== "string") ||
    !state.courses || typeof state.courses !== "object" || Array.isArray(state.courses) ||
    Object.values(state.courses).some((course) => !course || typeof course !== "object" || Array.isArray(course) ||
      (course.enabled !== undefined && typeof course.enabled !== "boolean"))) {
    throw new Error(`Cannot read ${path}: invalid sync state. Restore or repair this file before syncing.`);
  }
  return state as SyncState;
}

/* ------------------------------------------------------------- the sync */

export async function sync(options: SyncOptions): Promise<SyncResult> {
  return withSyncLock(resolve(options.root), () => syncUnlocked(options));
}

async function syncUnlocked(options: SyncOptions): Promise<SyncResult> {
  const { adapter, credentials } = options;
  const now = options.now ?? new Date();
  const root = resolve(options.root);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const startedAt = now.toISOString();
  const select = options.select ?? defaultSelection(now);
  const emit = options.onProgress ?? (() => {});

  await mkdir(join(root, STATE_DIR, "tmp"), { recursive: true });
  await clearTmp(root);

  const state = await readState(root, options.storage);
  const manifest = new Map((await readJson<ManifestEntry[]>(join(root, STATE_DIR, "manifest.json"), [])).map((e) => [e.vleId, e]));
  // Fail before downloading if the student's saved deadlines cannot be read.
  await readDeadlineFile(root, options.storage);
  const freshAssessments = new Map<string, AssessmentComponent[]>();

  const courses = await adapter.listCourses(credentials);
  const reports: CourseReport[] = [];
  const freshDeadlines: Deadline[] = [];
  const syncedKeys = new Set<string>();
  const textRefresh = new Map<string, { rule: Set<string>; ai: Set<string>; current: Set<string> }>();
  const weekMaps = new Map<string, TermWeekMap | null>();
  const fileChanges: string[] = [];
  const newFiles: { module: string; added: number }[] = [];
  const readText = options.textDeadlines !== false;
  if (readText) await rm(join(root, STATE_DIR, "rejected.json"), { force: true });

  for (const course of courses) {
    const placement = placeCourse(course);
    const wanted = state.courses[course.shortname]?.enabled ?? select(course, placement);
    const report: CourseReport = {
      shortname: course.shortname,
      folder: `${placement.year}/${placement.folder}`,
      status: wanted ? "synced" : "skipped",
      files: emptyCounts(),
      deadlines: 0,
    };
    reports.push(report);
    if (!wanted) continue;

    emit({ type: "course-start", course: course.shortname, folder: report.folder });
    try {
      const listed = await adapter.listItems(credentials, course);
      const label = placement.code ?? course.shortname;
      // Every forum was read; only the relevant posts go on, the rest is thrown away here.
      const forum = selectForumPosts(listed);
      const items = forum.items;
      await writeForumHighlights(root, placement, forum.highlights);
      const plan = planFiles(items, placement);
      report.files.videosSkipped = plan.skipped.length;
      report.forumPosts = forum.highlights.length;

      const added: { name: string; category: string }[] = [];
      await runPool(plan.jobs, concurrency, async (job) => {
        const result = await syncFile({ adapter, credentials, root, course, job, manifest, now });
        report.files[result.result]++;
        if (result.result === "new") added.push({ name: job.relativePath.split("/").slice(-1)[0] ?? job.relativePath, category: job.category });
        else if (result.line) fileChanges.push(`${label} · ${result.line}`);
        emit({ type: "file", course: course.shortname, path: job.relativePath, result: result.result });
      });
      if (options.transcripts !== false && adapter.ltiLaunch) {
        const got = await syncTranscripts({
          adapter,
          credentials,
          course,
          placement,
          items: items as VleItem[],
          root,
          manifest,
          now,
          ...(options.transcriptFetch ? { fetch: options.transcriptFetch } : {}),
          ...(options.transcriptPauseMs !== undefined ? { pauseMs: options.transcriptPauseMs } : {}),
        });
        report.transcripts = { added: got.added.length, skippedNoCaptions: got.skippedNoCaptions, failed: got.failed, ...(got.error ? { error: got.error } : {}) };
        for (const path of got.added) emit({ type: "file", course: course.shortname, path, result: "new" });
        if (got.added.length) fileChanges.push(`${label} · ${got.added.length} new lecture transcript${got.added.length === 1 ? "" : "s"} in Transcripts/`);
        report.files.new += got.added.length;
        newFiles.push({ module: label, added: got.added.length });
      }
      fileChanges.push(...describeNewFiles(label, added));
      newFiles.push({ module: label, added: added.length });

      let deadlines = deadlinesFromItems(items as VleItem[], course, placement, now);
      if (readText) {
        try {
          const currentFiles = new Set(plan.jobs.map((job) => job.vleId));
          const found = await textDeadlines({
            universityId: adapter.id,
            root,
            course,
            placement,
            items: items as VleItem[],
            // Spoken lectures are not read for deadlines: too easy to misquote.
            manifest: [...manifest.values()].filter((e) => e.module === course.shortname && e.category !== "Transcripts" && currentFiles.has(e.vleId)),
            deadlines,
            now,
            ...(options.ai ? { ai: options.ai } : {}),
            ...(options.confirmAi ? { confirmAi: options.confirmAi } : {}),
          });
          deadlines = found.deadlines;
          weekMaps.set(`${placement.year}|${label}`, found.weekMap);
          report.text = found.counts;
          if (found.issues.length) report.extractionIssues = found.issues;
          const current = new Set(plan.jobs.map((job) => job.file.url));
          for (const item of items) {
            if (item.kind === "announcement" || item.kind === "assignment" || item.kind === "forum-post") current.add(item.url);
            else if (item.kind === "page") current.add(item.activityUrl);
          }
          textRefresh.set(`${placement.year}|${label}`, { rule: new Set(found.refreshed.ruleUrls), ai: new Set(found.refreshed.aiUrls), current });
        } catch (error) {
          report.textError = error instanceof Error ? error.message : String(error);
        }
      }
      report.deadlines = deadlines.length;
      await writeJson(join(root, STATE_DIR, "manifest.json"), [...manifest.values()]);
      freshDeadlines.push(...deadlines);
      syncedKeys.add(`${placement.year}|${placement.code ?? course.shortname}`);
      emit({ type: "course-done", course: course.shortname });
      try {
        const components = new Map<string, AssessmentComponent>();
        for (const item of items) {
          if (item.kind !== "page" && item.kind !== "assignment") continue;
          const localPath = item.kind === "page" ? manifest.get(`moodle:page:${item.activityId}`)?.localPath : undefined;
          const source = item.kind === "page"
            ? { url: item.activityUrl, title: item.activity, ...(localPath ? { localPath } : {}) }
            : { url: item.url, title: item.title };
          for (const row of parseAssessmentOverview(item.kind === "page" ? item.html : item.introHtml)) {
            const key = JSON.stringify([row.seq, row.description]);
            if (!components.has(key)) components.set(key, { ...row, module: label, year: placement.year, source });
          }
        }
        freshAssessments.set(`${placement.year}|${label}`, [...components.values()]);
      } catch (error) {
        report.assessmentsError = error instanceof Error ? error.message : String(error);
      }
    } catch (error) {
      if (error instanceof VleError && error.code === "invalid_token") {
        await writeJson(join(root, STATE_DIR, "manifest.json"), [...manifest.values()]);
        throw error;
      }
      report.status = "failed";
      report.error = error instanceof Error ? error.message : String(error);
      emit({ type: "course-failed", course: course.shortname, message: report.error });
    }
  }

  // Merge only the courses that synced: a failed or switched-off course keeps
  // its previous deadlines exactly as they were.
  const inSync = (d: Deadline) => syncedKeys.has(`${d.year}|${d.module}`);
  const { deadlines, placed, previousSynced, deadlineLines } = await withDeadlineLock(root, async () => {
    // Read again at commit time: UI edits made during downloads must survive.
    const previousDeadlines = await readDeadlineFile(root, options.storage);
    const previousSynced = previousDeadlines.filter(inSync);
    const untouched = previousDeadlines.filter((d) => !inSync(d));
    const repaired = previousSynced.map((deadline) => {
      const next = repairAutomaticWeekDates(deadline, weekMaps.get(`${deadline.year}|${deadline.module}`) ?? null);
      if (next === deadline) return deadline;
      // Compare against the original latest read for both history and notifications.
      const history = [...deadline.history];
      if (deadline.due?.iso !== next.due?.iso) history.push({ at: startedAt, field: "due", from: deadline.due?.iso ?? null, to: next.due?.iso ?? null });
      if (deadline.status !== next.status) history.push({ at: startedAt, field: "status", from: deadline.status, to: next.status });
      return { ...next, history };
    });
    const merged = mergeDeadlines(repaired, freshDeadlines, now, (source, deadline) => {
      const refreshed = textRefresh.get(`${deadline.year}|${deadline.module}`);
      if (!refreshed) return false; // Text disabled or failed: retain previous evidence.
      if (!refreshed.current.has(source.url)) return true; // Removed from the VLE.
      return (source.origin === "ai" ? refreshed.ai : refreshed.rule).has(source.url);
    });
    const placed = foldIntoDated(mergeSameWeek(merged.map((d) => placeInWeek(d, weekMaps.get(`${d.year}|${d.module}`) ?? null))));
    const deadlines = sortAll([...untouched, ...placed]);
    const deadlineLines = changeLines(previousSynced, placed);

    await writeDeadlineFile(root, deadlines, options.storage);
    // Keep the calendar export in order with other sync commits as well.
    try {
      await writeText(join(root, "Deadlines.ics"), toIcs(deadlines, now), options.storage);
    } catch (error) {
      throw new Error("Deadlines.json was saved, but Deadlines.ics was not updated. Sync is incomplete; rerun after fixing storage.", { cause: error });
    }
    return { deadlines, placed, previousSynced, deadlineLines };
  });
  let assessmentsError: string | undefined;
  try {
    const previous = await readJson<AssessmentComponent[]>(join(root, "Assessments.json"), []);
    if (!Array.isArray(previous)) throw new Error("Assessments.json must contain an array; repair it before syncing assessments.");
    const previousAssessments = previous;
    const assessments = [
      ...previousAssessments.filter((entry) => !freshAssessments.has(`${entry.year}|${entry.module}`)),
      ...[...freshAssessments.values()].flat(),
    ].sort((a, b) => a.year.localeCompare(b.year) || a.module.localeCompare(b.module) || (a.seq ?? "").localeCompare(b.seq ?? ""));
    await writeJson(join(root, "Assessments.json"), assessments);
  } catch (error) {
    assessmentsError = error instanceof Error ? error.message : String(error);
  }

  const changes = [...fileChanges.sort(), ...deadlineLines];
  if (changes.length) await prependChanges(root, now, changes);

  state.lastSync = now.toISOString();
  try {
    await writeJson(join(root, STATE_DIR, "state.json"), state, options.storage);
  } catch (error) {
    throw new Error("Deadlines and calendar were saved, but sync state was not updated. Sync is incomplete; rerun after fixing storage.", { cause: error });
  }
  await clearTmp(root);

  const summary = filesSummary(newFiles);
  const notifications = [...eventsFromDiff(previousSynced, placed), ...(summary ? [summary] : [])];

  return { startedAt, finishedAt: new Date().toISOString(), courses: reports, deadlines, changes, notifications, ...(assessmentsError ? { assessmentsError } : {}) };
}

/* ------------------------------------------------------------- one file */

type FileContext = {
  adapter: UniversityAdapter;
  credentials: Credentials;
  root: string;
  course: Course;
  job: FileJob;
  manifest: Map<string, ManifestEntry>;
  now: Date;
};

const isoOrNull = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);

async function syncFile(ctx: FileContext): Promise<{ result: FileResult; line?: string }> {
  const { job, manifest, root } = ctx;
  const entry = manifest.get(job.vleId);
  const upstreamModified = isoOrNull(job.file.modified);
  const display = job.relativePath.split("/").slice(-1)[0] ?? job.relativePath;

  try {
    /* Page bodies already have their content; everything else is downloaded. */
    const fetchTo = async (target: string): Promise<{ sha256: string }> => {
      const tmp = join(root, STATE_DIR, "tmp", randomBytes(8).toString("hex"));
      const got = job.html !== undefined ? await writeHtml(tmp, job.html) : await downloadTo(ctx.adapter, ctx.credentials, job.file, tmp);
      await mkdir(dirname(target), { recursive: true });
      await renameWithRetry(tmp, target);
      return got;
    };
    const record = (localPath: string, sha256: string, vleId = job.vleId) => {
      manifest.set(vleId, {
        vleId,
        module: ctx.course.shortname,
        sourceUrl: job.file.url,
        localPath,
        category: job.category,
        categoryReason: job.reason,
        vleModified: upstreamModified,
        sha256,
        writtenAt: ctx.now.toISOString(),
      });
    };

    /* A file we have never written. */
    if (!entry) {
      const wanted = safeJoin(root, job.relativePath);
      const target = (await exists(wanted)) ? await freeSibling(wanted, "from QMplus") : wanted;
      const { sha256 } = await fetchTo(target);
      record(toRelative(root, target), sha256);
      return { result: "new", line: `new file ${display}` };
    }

    /* A file we wrote before: where is it now? */
    let localPath = entry.localPath;
    let local = safeJoin(root, localPath);
    let movedByStudent = false;
    if (!(await exists(local))) {
      const found = await findByHash(root, job, entry.sha256);
      if (!found) return { result: "deleted-by-you" }; // never bring back what the student removed
      local = found;
      localPath = toRelative(root, found);
      movedByStudent = true;
      manifest.set(job.vleId, { ...entry, localPath });
    }

    const current = manifest.get(job.vleId)!;
    const changedUpstream =
      job.html !== undefined
        ? sha256Text(job.html) !== current.sha256
        : upstreamModified !== null && upstreamModified !== current.vleModified;
    if (!changedUpstream) return { result: movedByStudent ? "moved-by-you" : "unchanged" };

    const localHash = await hashFile(local);
    if (localHash === current.sha256) {
      const { sha256 } = await fetchTo(local); // untouched by the student: replace in place
      record(localPath, sha256);
      return { result: "updated", line: `updated ${display}` };
    }

    // The student edited it: keep their version, save the new one beside it.
    const day = ctx.now.toISOString().slice(0, 10);
    const beside = await freeSibling(local, `updated ${day}`);
    const { sha256 } = await fetchTo(beside);
    manifest.set(job.vleId, { ...current, vleModified: upstreamModified ?? current.vleModified });
    record(toRelative(root, beside), sha256, `${job.vleId}#updated:${upstreamModified ?? day}`);
    return { result: "kept-your-edit", line: `${display} changed on the VLE; your edited copy was kept, the new version is saved as ${basename(beside)}` };
  } catch (error) {
    if (error instanceof VleError && error.code === "invalid_token") throw error;
    return { result: "failed", line: `could not download ${display}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A few new files are named; many become one line with a count per category. */
export function describeNewFiles(label: string, added: { name: string; category: string }[]): string[] {
  if (added.length === 0) return [];
  if (added.length <= 5) return added.map((f) => `${label} · new file ${f.name}`);
  const byCategory = new Map<string, number>();
  for (const f of added) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  const parts = [...byCategory].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} ${n}`);
  return [`${label} · ${added.length} new files (${parts.join(", ")})`];
}

/* ------------------------------------------------------------- file helpers */

function emptyCounts(): CourseReport["files"] {
  return {
    new: 0,
    updated: 0,
    unchanged: 0,
    "kept-your-edit": 0,
    "moved-by-you": 0,
    "deleted-by-you": 0,
    failed: 0,
    videosSkipped: 0,
  };
}

/** `relative` joined under `root`, refusing anything that would leave it. */
export function safeJoin(root: string, relative: string): string {
  const base = resolve(root);
  const full = resolve(base, ...relative.split("/"));
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`Refusing a path outside the folder: ${relative}`);
  return full;
}

const toRelative = (root: string, full: string) => full.slice(root.length + 1).split(sep).join("/");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** "name.pdf" → "name (updated 2026-10-16).pdf", then "(… 2)" if that is taken too. */
async function freeSibling(path: string, tag: string): Promise<string> {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${tag}${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
}

const sha256Text = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function writeHtml(tmp: string, html: string): Promise<{ sha256: string }> {
  await writeFile(tmp, html, "utf8");
  return { sha256: sha256Text(html) };
}

async function downloadTo(adapter: UniversityAdapter, credentials: Credentials, file: VleFile, tmp: string): Promise<{ sha256: string }> {
  const body = await adapter.download(credentials, file);
  const reader = body.getReader();
  const hash = createHash("sha256");
  const out = createWriteStream(tmp);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (error) {
    out.destroy();
    await reader.cancel().catch(() => {});
    await rm(tmp, { force: true });
    throw error;
  }
  return { sha256: hash.digest("hex") };
}

/** A student-moved file: same content, somewhere else inside the course's folder. */
async function findByHash(root: string, job: FileJob, sha256: string): Promise<string | null> {
  const courseDir = safeJoin(root, job.relativePath.split("/").slice(0, 2).join("/"));
  for (const file of await listFiles(courseDir)) {
    if ((await hashFile(file)) === sha256) return file;
  }
  return null;
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

async function runPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (next < items.length && failure === undefined) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

/* ------------------------------------------------------------- state files */

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeText(path: string, text: string, io: Partial<DeadlineFileOps> = {}): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await (io.writeFile ?? writeFile)(tmp, text, "utf8");
    await (io.rename ?? renameWithRetry)(tmp, path);
  } finally {
    await (io.rm ?? rm)(tmp, { force: true });
  }
}

const writeJson = (path: string, value: unknown, io: Partial<DeadlineFileOps> = {}) => writeText(path, `${JSON.stringify(value, null, 2)}\n`, io);

/** The kept forum posts of one module, replacing last sync's; none kept removes the file. */
async function writeForumHighlights(root: string, placement: ModulePlacement, highlights: ForumHighlight[]): Promise<void> {
  const path = join(root, STATE_DIR, "forum", `${sanitizeSegment(placement.year)}__${sanitizeSegment(placement.folder)}.json`);
  if (highlights.length === 0) await rm(path, { force: true });
  else await writeJson(path, highlights);
}

async function clearTmp(root: string): Promise<void> {
  await rm(join(root, STATE_DIR, "tmp"), { recursive: true, force: true });
  await mkdir(join(root, STATE_DIR, "tmp"), { recursive: true });
}

function sortAll(deadlines: Deadline[]): Deadline[] {
  return [...deadlines].sort((a, b) => {
    if (a.due && b.due && a.due.iso !== b.due.iso) return Date.parse(a.due.iso) - Date.parse(b.due.iso);
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

/** Newest section first, under a single "# Changes" heading. */
async function prependChanges(root: string, now: Date, lines: string[]): Promise<void> {
  const path = join(root, "Changes.md");
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => ((acc[part.type] = part.value), acc), {});
  const section = `## ${stamp.year}-${stamp.month}-${stamp.day} ${stamp.hour}:${stamp.minute}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
  let existing = "";
  try {
    existing = (await readFile(path, "utf8")).replace(/^# Changes\s*\n+/, "");
  } catch {
    /* first run */
  }
  await writeText(path, `# Changes\n\n${section}${existing ? `\n${existing}` : ""}`);
}
