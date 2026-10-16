/**
 * File sorting: which Course Materials category a VLE file goes in, and the
 * download plan for one course. Rules only; see docs/design/03 (Sorting files).
 */

import { decodeEntities, sanitizeSegment } from "./naming.ts";
import type { Category, ModulePlacement, VleFile, VleItem } from "./types.ts";

type Rule = { category: Category; tests: RegExp[] };

/** Checked in this order against each piece of evidence; the first match wins. */
const RULES: Rule[] = [
  {
    category: "Past Papers",
    tests: [/past\s*(exam\s*)?papers?|past\s*exams?|exam\s*paper|mock\s*exam|\b(19|20)\d{2}\s*exam/i],
  },
  {
    category: "Assessment Guidance",
    tests: [/coursework|assessment|assignment|\bbrief\b|specification|\bspec\b|marking|rubric|criteria|handbook|module\s*(guide|outline|info)/i],
  },
  {
    category: "Labs and Seminars",
    // "EX1" is case-sensitive: "ex1" or "Ex1" in prose is not an exercise sheet.
    tests: [/\blabs?\b|tutorials?|seminars?|worksheets?|exercises?|practicals?|problem\s*sheets?|\bsheet\s*\d/i, /(?<![A-Za-z])EX\d/],
  },
  { category: "Transcripts", tests: [/transcript|captions?|\.vtt$|\.srt$/i] },
  { category: "Lectures", tests: [/lectures?|slides?|\bweek\s*\d+|\blec\s*\d+|\bl\d{1,2}\b|\.pptx?$/i] },
  { category: "Reference", tests: [/reading|textbook|reference|resources?|cheat\s*sheet|notes/i] },
];

export type Evidence = {
  filename: string;
  activity?: string | null;
  activityType?: string | null;
  section?: string | null;
};

/** Category for one file: activity type, then file name, activity name, section name. */
export function categorize(evidence: Evidence): { category: Category; reason: string } {
  if (evidence.activityType === "assign") return { category: "Assessment Guidance", reason: 'activityType:"assign"' };
  const sources: [string, string | null | undefined][] = [
    ["file", evidence.filename],
    ["activity", evidence.activity],
    ["section", evidence.section],
  ];
  for (const [where, text] of sources) {
    if (!text) continue;
    for (const rule of RULES) {
      if (rule.tests.some((test) => test.test(text))) return { category: rule.category, reason: `${where}:"${text}"` };
    }
  }
  return { category: "Other", reason: "no rule matched" };
}

/** Videos are not downloaded (lecture recordings live in Echo360). */
export function isVideo(file: Pick<VleFile, "filename" | "mimetype">): boolean {
  return (file.mimetype ?? "").startsWith("video/") || /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(file.filename);
}

export type FileJob = {
  vleId: string;
  /** Relative to My Studies, forward slashes: "2026-27/ECS505U - …/Course Materials/Lectures/01 - x.pdf". */
  relativePath: string;
  category: Category;
  reason: string;
  file: VleFile;
  /** Set on a page activity's HTML job: the page body, so it need not be downloaded. */
  html?: string;
};

export type SkippedFile = { vleId: string; filename: string; why: "video" };

export type FilePlan = { jobs: FileJob[]; skipped: SkippedFile[] };

type Draft = {
  vleId: string;
  category: Category;
  reason: string;
  file: VleFile;
  html?: string;
  /** Folders under the category, already sanitised. */
  dirs: string[];
  name: string;
  /** For a page's HTML: the drafts of its files, which follow its final name. */
  pageFiles?: Draft[];
  sectionIndex: number;
};

const vleIdOf = (activityId: number, file: VleFile) => `moodle:file:${activityId}:${file.filepath || "/"}${file.filename}`;
const subDirs = (filepath: string) => filepath.split("/").filter(Boolean).map(sanitizeSegment);

/** Download plan for one course: one job per file, sorted and with collision-free paths. */
export function planFiles(items: VleItem[], placement: ModulePlacement): FilePlan {
  const drafts: Draft[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();
  const claim = (vleId: string) => (seen.has(vleId) ? false : (seen.add(vleId), true));

  for (const item of items) {
    if (item.kind === "file") {
      const vleId = vleIdOf(item.activityId, item.file);
      if (!claim(vleId)) continue;
      if (isVideo(item.file)) {
        skipped.push({ vleId, filename: item.file.filename, why: "video" });
        continue;
      }
      const activity = decodeEntities(item.activity);
      const section = decodeEntities(item.section);
      const { category, reason } = categorize({ filename: item.file.filename, activity, activityType: item.activityType, section });
      drafts.push({
        vleId,
        category,
        reason,
        file: item.file,
        dirs: item.activityType === "folder" ? [sanitizeSegment(activity), ...subDirs(item.file.filepath)] : [],
        name: sanitizeSegment(item.file.filename),
        sectionIndex: item.sectionIndex,
      });
    } else if (item.kind === "assignment") {
      for (const file of item.briefFiles) {
        const vleId = vleIdOf(item.activityId, file);
        if (!claim(vleId)) continue;
        if (isVideo(file)) {
          skipped.push({ vleId, filename: file.filename, why: "video" });
          continue;
        }
        const { category, reason } = categorize({ filename: file.filename, activity: item.title, activityType: "assign" });
        drafts.push({ vleId, category, reason, file, dirs: [], name: sanitizeSegment(file.filename), sectionIndex: Infinity });
      }
    } else if (item.kind === "page") {
      const activity = decodeEntities(item.activity);
      const section = decodeEntities(item.section);
      // item.html is the page body; item.files never holds the page's own
      // index.html, so any .html there is a real attachment and is downloaded.
      const htmlFile: VleFile = {
        filename: "index.html",
        filepath: "/",
        url: item.activityUrl,
        size: item.html.length,
        mimetype: "text/html",
        modified: null,
      };
      const vleId = `moodle:page:${item.activityId}`;
      if (!claim(vleId)) continue;
      const { category, reason } = categorize({ filename: `${activity}.html`, activity, activityType: item.activityType, section });
      const pageFiles: Draft[] = [];
      for (const file of item.files) {
        const fileId = vleIdOf(item.activityId, file);
        if (!claim(fileId)) continue;
        if (isVideo(file)) {
          skipped.push({ vleId: fileId, filename: file.filename, why: "video" });
          continue;
        }
        pageFiles.push({
          vleId: fileId,
          category,
          reason,
          file,
          dirs: subDirs(file.filepath),
          name: sanitizeSegment(file.filename),
          sectionIndex: item.sectionIndex,
        });
      }
      drafts.push({
        vleId,
        category,
        reason,
        file: htmlFile,
        html: item.html,
        dirs: [],
        name: sanitizeSegment(`${activity}.html`),
        pageFiles,
        sectionIndex: item.sectionIndex,
      });
    }
  }

  // Lectures sort in teaching order: section, then position in the course.
  const lectures = drafts
    .map((draft, order) => ({ draft, order }))
    .filter(({ draft }) => draft.category === "Lectures")
    .sort((a, b) => a.draft.sectionIndex - b.draft.sectionIndex || a.order - b.order);
  lectures.forEach(({ draft }, index) => {
    draft.name = sanitizeSegment(`${String(index + 1).padStart(2, "0")} - ${draft.name}`);
  });

  const base = [sanitizeSegment(placement.year), sanitizeSegment(placement.folder), "Course Materials"];
  const paths = pathTable();
  const jobs: FileJob[] = [];
  const push = (draft: Draft, path: string) => {
    const job: FileJob = { vleId: draft.vleId, relativePath: path, category: draft.category, reason: draft.reason, file: draft.file };
    if (draft.html !== undefined) job.html = draft.html;
    jobs.push(job);
  };
  for (const draft of drafts) {
    const dir = paths.dir([...base, draft.category, ...draft.dirs]);
    const path = paths.file(dir, draft.name);
    push(draft, path);
    if (!draft.pageFiles) continue;
    const filesDir = `${path.slice(dir.length + 1).replace(/\.html?$/i, "")} files`;
    for (const file of draft.pageFiles) push(file, paths.file(paths.dir([...dir.split("/"), filesDir, ...file.dirs]), file.name));
  }
  return { jobs, skipped };
}

/**
 * Paths handed out so far, compared case-insensitively: Windows and macOS would
 * put "Notes.pdf" and "notes.pdf" in one file, and cannot hold a file "Assets"
 * next to a folder "assets". A clash gets " (2)", " (3)", … on the newcomer:
 * before a file's extension, or at the end of the folder segment that clashed.
 */
function pathTable() {
  const files = new Set<string>();
  const dirs = new Set<string>();
  /** Folder asked for (lower-cased, under its resolved parent) → the folder it got. */
  const folders = new Map<string, string>();
  const taken = (path: string) => files.has(path.toLowerCase()) || dirs.has(path.toLowerCase());
  const free = (path: string, cut: number) => {
    let candidate = path;
    for (let n = 2; taken(candidate); n++) candidate = `${path.slice(0, cut)} (${n})${path.slice(cut)}`;
    return candidate;
  };
  return {
    /** The folder for these segments, reusing one already made under any spelling. */
    dir(segments: string[]): string {
      let path = "";
      for (const segment of segments) {
        const wanted = path ? `${path}/${segment}` : segment;
        let got = folders.get(wanted.toLowerCase());
        if (got === undefined) {
          got = free(wanted, wanted.length);
          folders.set(wanted.toLowerCase(), got);
          folders.set(got.toLowerCase(), got);
          dirs.add(got.toLowerCase());
        }
        path = got;
      }
      return path;
    },
    file(dir: string, name: string): string {
      const dot = name.lastIndexOf(".");
      const path = free(`${dir}/${name}`, dot > 0 ? dir.length + 1 + dot : dir.length + 1 + name.length);
      files.add(path.toLowerCase());
      return path;
    },
  };
}
