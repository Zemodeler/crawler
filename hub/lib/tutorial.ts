/**
 * Tutorial sheets: the module's own exercise sheets and their official
 * solutions, turned into a practice session that links every exercise to the
 * lecture slides it comes from and explains it for a beginner.
 *
 * This file is the deterministic half: the data model, finding which sheet,
 * solution and lecture belong together, checking slide links against the
 * real page text, the matrix notation, matching study packs, and storage.
 * Asking the model is in tutorial-generate.ts.
 *
 * Text fields use the reader's Markdown subset (**bold**, *italic*, `code`,
 * "- " bullets, one paragraph per line) plus one token for matrices:
 * [[5 3; 4 2]] is a 2x2 matrix, rows split by ";", cells by spaces or commas.
 */

import type { SelfMark } from "./practice.ts";

/* ------------------------------------------------------------------- model */

/** One lecture page an exercise relies on. `path` is relative to the module folder. */
export type SlideRef = {
  path: string;
  page: number;
  label: string;
  /** The slide works the same or a very similar example. */
  same?: boolean;
};

export type TutorialPart = {
  /** "a", "b", "i"…; empty for an exercise with a single part. */
  label: string;
  question: string;
  /** The short final answer, shown in bold when revealed. */
  final: string;
  /** The official working, as clear numbered steps. */
  working: string;
  /** Where the official sheet is wrong or ambiguous, and what is shown instead. */
  note?: string;
  /** A beginner walkthrough written on request, kept so it is only paid for once. */
  explain?: string;
};

export type Exercise = {
  /** Unique inside its sheet, e.g. "1", "3b". */
  id: string;
  /** As printed on the sheet: "1", "2", "Extra 1". */
  number: string;
  title: string;
  /** A short topic name, the same wording across the module. */
  topic: string;
  stem: string;
  hint?: string;
  /** "Before you start": the ideas and formulas it needs, in plain words. */
  basics: string;
  parts: TutorialPart[];
  refs: SlideRef[];
};

export type TutorialSheet = {
  /** Stable across re-conversion of the same files, see sheetId(). */
  id: string;
  /** "Week 6A", or the file's name when it has no week. */
  label: string;
  week: number | null;
  /** "A", "B" or "" */
  part: string;
  title: string;
  sheetPath?: string;
  solutionPath: string;
  lecturePath?: string;
  convertedAt: number;
  exercises: Exercise[];
};

export type TutorialFile = { version: 1; sheets: TutorialSheet[] };

export const EMPTY_TUTORIALS: TutorialFile = { version: 1, sheets: [] };

/** Where a module's converted sheets live: Study Hub's own hidden folder in the module. */
export const TUTORIAL_PATH = ".study-hub/tutorials.json";

/** Key of one exercise in progress records. */
export const exerciseKey = (sheet: Pick<TutorialSheet, "id">, exercise: Pick<Exercise, "id">) => `${sheet.id}/${exercise.id}`;

/** Sheets in teaching order: by week, then part, then label. */
export function sortSheets(sheets: TutorialSheet[]): TutorialSheet[] {
  return [...sheets].sort(
    (a, b) =>
      (a.week ?? 999) - (b.week ?? 999) ||
      a.part.localeCompare(b.part) ||
      a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

/** Adds or replaces one sheet, keeping the list in order. */
export function upsertSheet(file: TutorialFile, sheet: TutorialSheet): TutorialFile {
  return { version: 1, sheets: sortSheets([...file.sheets.filter((s) => s.id !== sheet.id), sheet]) };
}

/** Stores a beginner walkthrough on its part, returning a new file. */
export function withExplanation(
  file: TutorialFile,
  sheetId: string,
  exerciseId: string,
  partIndex: number,
  explain: string,
): TutorialFile {
  return {
    version: 1,
    sheets: file.sheets.map((s) =>
      s.id !== sheetId
        ? s
        : {
            ...s,
            exercises: s.exercises.map((e) =>
              e.id !== exerciseId ? e : { ...e, parts: e.parts.map((p, i) => (i === partIndex ? { ...p, explain } : p)) },
            ),
          },
    ),
  };
}

/* ----------------------------------------------------------------- pairing */

type Named = { path: string; name: string };

/** A sheet with its solutions and the lecture it belongs to, as found by file names. */
export type SheetPair = {
  id: string;
  label: string;
  week: number | null;
  part: string;
  sheetPath?: string;
  solutionPath: string;
  lecturePath?: string;
};

const stem = (name: string) => name.replace(/\.[a-z0-9]+$/i, "");
const SOLUTION = /solutions?|answers?|worked/i;
const READABLE = /\.(pdf|docx|pptx|txt|md)$/i;

/** The part of a name both a sheet and its solution share. */
function baseOf(name: string): string {
  return stem(name)
    .toLowerCase()
    .replace(/solutions?|answers?|worked/g, "")
    .replace(/\b20\d\d\b|(?<=\D)20\d\d(?=\D|$)/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Week and part of an exercise sheet: "exercise2A" → 2, "A"; "exercise4-part B" → 4, "B". */
export function sheetNumber(name: string): { week: number | null; part: string } {
  const n = stem(name).replace(/\b(?:ecs|com|[a-z]{2,4})\d{3,4}[a-z]?\b/gi, " ");
  const m = n.match(/(?:exercise|sheet|tutorial|problem|lab|seminar|week|worksheet|set|class)s?\s*[-_ ]*(\d{1,2})(?:\s*[-_ ]*(?:part\s*)?([A-D])(?![a-z]))?/i);
  if (!m) return { week: null, part: "" };
  return { week: Number(m[1]), part: (m[2] || "").toUpperCase() };
}

/** Week of a lecture file: "week3", "Lecture2", "Week 6". */
export function lectureWeek(name: string): number | null {
  const n = stem(name).replace(/\b(?:ecs|com|[a-z]{2,4})\d{3,4}[a-z]?\b/gi, " ");
  const m = n.match(/(?:week|lecture|wk|lec)\s*[-_ ]*(\d{1,2})(?!\d)/i);
  return m ? Number(m[1]) : null;
}

const isLecture = (f: Named) =>
  /\.(pdf|pptx)$/i.test(f.name) &&
  /lecture|slides|week|handout/i.test(f.path) &&
  !/solution|exercise|location|instruction|test time|exam paper|past paper|formula/i.test(f.name);

/** How complete a lecture deck looks, to choose between core slides, handouts and the complete deck. */
function lectureScore(name: string): number {
  const n = name.toLowerCase();
  let score = 0;
  if (/complete|full/.test(n)) score += 3;
  if (/solved|worked/.test(n)) score += 2;
  if (/lecture|slides/.test(n)) score += 1;
  if (/core/.test(n)) score -= 1;
  if (/handout/.test(n)) score -= 1;
  if (!/\.pdf$/.test(n)) score -= 2; // only PDFs open at a page
  return score;
}

/** The best lecture deck for a week, or undefined. */
export function lectureFor(week: number | null, files: Named[]): string | undefined {
  if (week === null) return undefined;
  const decks = files
    .filter((f) => isLecture(f) && lectureWeek(f.name) === week)
    .sort((a, b) => lectureScore(b.name) - lectureScore(a.name) || b.path.localeCompare(a.path, undefined, { numeric: true }));
  return decks[0]?.path;
}

export const sheetId = (pair: Pick<SheetPair, "solutionPath">) => `s-${baseOf(pair.solutionPath.split("/").pop() || pair.solutionPath) || "sheet"}`;

/**
 * Every solution file with its question sheet (same name without "solution")
 * and the week's lecture deck. A solution without a sheet is still a pair:
 * solution sheets normally repeat the questions.
 */
export function pairSheets(files: Named[]): SheetPair[] {
  const readable = files.filter((f) => READABLE.test(f.name) && !/^\./.test(f.name));
  const solutions = readable.filter((f) => SOLUTION.test(stem(f.name)) && !isLecture(f) && !/past paper|exam paper/i.test(f.path));
  const sheets = readable.filter((f) => !SOLUTION.test(stem(f.name)) && sheetNumber(f.name).week !== null && !isLecture(f));
  const pairs: SheetPair[] = [];
  for (const solution of solutions) {
    const base = baseOf(solution.name);
    const number = sheetNumber(solution.name);
    const sheet = sheets.find((s) => baseOf(s.name) === base);
    const label = number.week !== null ? `Week ${number.week}${number.part}` : stem(solution.name);
    pairs.push({
      id: sheetId({ solutionPath: solution.path }),
      label,
      week: number.week,
      part: number.part,
      ...(sheet ? { sheetPath: sheet.path } : {}),
      solutionPath: solution.path,
      ...(lectureFor(number.week, files) ? { lecturePath: lectureFor(number.week, files) } : {}),
    });
  }
  return pairs.sort(
    (a, b) => (a.week ?? 999) - (b.week ?? 999) || a.part.localeCompare(b.part) || a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

/** Lecture decks a student can pick from when a pair's lecture is wrong. */
export function lectureChoices(files: Named[]): Named[] {
  return files.filter(isLecture).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** Formula sheets and summaries worth keeping one click away in the material pane. */
export function referenceSheets(files: Named[]): Named[] {
  return files
    .filter((f) => /\.pdf$/i.test(f.name) && /formula|summary sheet|cheat ?sheet|key results/i.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/* ------------------------------------------------------------- slide links */

/** Splits extracted PDF text on the "--- Page N ---" markers source-extract.ts writes. Index 0 is page 1. */
export function splitPages(text: string): string[] {
  const pages: string[] = [];
  const re = /--- Page (\d+) ---\n?/g;
  let match: RegExpExecArray | null;
  let last: { page: number; at: number } | null = null;
  while ((match = re.exec(text))) {
    if (last) pages[last.page - 1] = text.slice(last.at, match.index).trim();
    last = { page: Number(match[1]), at: match.index + match[0].length };
  }
  if (last) pages[last.page - 1] = text.slice(last.at).trim();
  for (let i = 0; i < pages.length; i++) pages[i] ??= "";
  return pages;
}

const STOP = new Set(
  "the and for with from that this what when where which into onto over than then them they their there these those your about using used use how why are was were has have had not but can its his her our out per via of to in on at by an a is be or as it if".split(" "),
);

/** The words of a label worth looking for on a slide. */
export function keywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map((w) => w.replace(/(?:ies)$/, "y").replace(/(?<=[a-z]{3})s$/, "")),
    ),
  ];
}

/**
 * True when a slide link can be trusted: the page exists in the deck, and
 * at least one word of its label (or of the exercise topic) is on that page
 * or the page next to it. Slides break text oddly, so a neighbour counts.
 */
export function verifyRef(ref: Pick<SlideRef, "page" | "label">, pages: string[], topic = ""): boolean {
  if (!Number.isInteger(ref.page) || ref.page < 1 || ref.page > pages.length) return false;
  const words = keywords(`${ref.label} ${topic}`);
  if (!words.length) return true;
  const near = [pages[ref.page - 2], pages[ref.page - 1], pages[ref.page]].filter(Boolean).join(" ");
  const found = new Set(keywords(near));
  return words.some((w) => found.has(w));
}

/* -------------------------------------------------------------- study packs */

/** Study packs whose names share words with the exercise's topic or title, best first. */
export function packsFor<T extends Named>(exercise: Pick<Exercise, "topic" | "title">, packs: T[], max = 2): T[] {
  const wanted = keywords(`${exercise.topic} ${exercise.topic} ${exercise.title}`);
  if (!wanted.length) return [];
  return packs
    .map((pack) => {
      const words = new Set(keywords(stem(pack.name).replace(/study pack|topic pack/gi, " ")));
      return { pack, score: wanted.filter((w) => words.has(w)).length };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name))
    .slice(0, max)
    .map((p) => p.pack);
}

/* ------------------------------------------------------------------ matrices */

export type MathPiece = string | { matrix: string[][] };

const MATRIX = /\[\[([^\[\]]+)\]\]/g;

/** Splits text into plain runs and [[a b; c d]] matrices. A malformed matrix stays as text. */
export function splitMath(text: string): MathPiece[] {
  const out: MathPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(MATRIX)) {
    const rows = match[1]
      .split(";")
      .map((r) => r.trim().split(/[\s,]+/).filter(Boolean).map((c) => c.replace(/(^|[^\w])-(?=[\d\w(])/g, "$1−")));
    const width = rows[0]?.length ?? 0;
    if (!width || rows.some((r) => r.length !== width)) continue;
    if (match.index! > at) out.push(text.slice(at, match.index));
    out.push({ matrix: rows });
    at = match.index! + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Rows like "1 2; 3 4" as a matrix token, for code that builds text. */
export const matrixToken = (rows: (string | number)[][]) => `[[${rows.map((r) => r.join(" ")).join("; ")}]]`;

/* ------------------------------------------------------------------ progress */

export type TutorialProgress = {
  marks: Record<string, SelfMark>;
  notes: Record<string, string>;
  /** exerciseKey of the last exercise open. */
  current?: string;
};

export const EMPTY_PROGRESS: TutorialProgress = { marks: {}, notes: {} };

const progressKey = (course: string) => `studyhub:tutorial-progress:${course}`;

export function loadProgress(course: string): TutorialProgress {
  try {
    const parsed = JSON.parse(localStorage.getItem(progressKey(course)) || "null");
    if (!parsed || typeof parsed !== "object") return { marks: {}, notes: {} };
    return {
      marks: parsed.marks && typeof parsed.marks === "object" ? parsed.marks : {},
      notes: parsed.notes && typeof parsed.notes === "object" ? parsed.notes : {},
      ...(typeof parsed.current === "string" ? { current: parsed.current } : {}),
    };
  } catch {
    return { marks: {}, notes: {} };
  }
}

/** False when the browser refused the write. */
export function saveProgress(course: string, progress: TutorialProgress): boolean {
  try {
    localStorage.setItem(progressKey(course), JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

/** Counts for a sheet or the whole module: how many exercises are marked each way. */
export function tally(sheets: TutorialSheet[], progress: TutorialProgress) {
  let total = 0;
  const counts = { right: 0, partly: 0, wrong: 0 };
  for (const sheet of sheets)
    for (const exercise of sheet.exercises) {
      total++;
      const mark = progress.marks[exerciseKey(sheet, exercise)];
      if (mark) counts[mark]++;
    }
  return { total, ...counts, done: counts.right + counts.partly + counts.wrong };
}

/**
 * Reads a backup from the stand-alone practice pages ("Save progress"): a
 * flat object of "<prefix>:marks" → JSON {"6A-1": "ok" | "no"} and
 * "<prefix>:notes:<id>" → JSON string. Ids are "<week><part>-<number>".
 * Returns the progress merged over `into`, and how many marks were matched.
 */
export function importLegacyProgress(
  backup: Record<string, unknown>,
  sheets: TutorialSheet[],
  into: TutorialProgress,
): { progress: TutorialProgress; matched: number } {
  const find = (legacy: string) => {
    const m = legacy.match(/^(\d+)([A-D]?)-(.+)$/i);
    if (!m) return null;
    const sheet = sheets.find((s) => s.week === Number(m[1]) && s.part === m[2].toUpperCase());
    const exercise = sheet?.exercises.find((e) => e.number === m[3] || e.id === m[3]);
    return sheet && exercise ? exerciseKey(sheet, exercise) : null;
  };
  const parse = (v: unknown) => {
    try {
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return v;
    }
  };
  const progress: TutorialProgress = { marks: { ...into.marks }, notes: { ...into.notes }, ...(into.current ? { current: into.current } : {}) };
  let matched = 0;
  for (const [key, raw] of Object.entries(backup)) {
    if (/:marks$/.test(key)) {
      const marks = parse(raw);
      if (!marks || typeof marks !== "object") continue;
      for (const [legacy, value] of Object.entries(marks as Record<string, unknown>)) {
        const target = find(legacy);
        if (!target || (value !== "ok" && value !== "no")) continue;
        progress.marks[target] = value === "ok" ? "right" : "wrong";
        matched++;
      }
    }
    const note = key.match(/:notes:(.+)$/);
    if (note) {
      const target = find(note[1]);
      const text = parse(raw);
      if (target && typeof text === "string" && text.trim()) progress.notes[target] = text;
    }
  }
  return { progress, matched };
}

/* ------------------------------------------------------------------ storage */

const GUARD = { "x-study-hub-host": "1" };
const localKey = (course: string) => `studyhub:tutorials:${course}`;

/** Checks a parsed file has the right shape; anything else is treated as no sheets. */
export function parseTutorialFile(raw: unknown): TutorialFile {
  const file = raw as Partial<TutorialFile> | null;
  if (!file || file.version !== 1 || !Array.isArray(file.sheets)) return { version: 1, sheets: [] };
  const sheets = file.sheets.filter(
    (s): s is TutorialSheet =>
      Boolean(s) && typeof s.id === "string" && typeof s.label === "string" && typeof s.solutionPath === "string" && Array.isArray(s.exercises),
  );
  return { version: 1, sheets: sortSheets(sheets) };
}

/**
 * A module's converted sheets. In the desktop app they are a file in the
 * module's .study-hub folder, so they survive cleared browser data; in the
 * browser-only version they live in localStorage.
 */
export async function loadTutorials(course: string, hosted: boolean): Promise<TutorialFile> {
  if (!hosted) {
    try {
      return parseTutorialFile(JSON.parse(localStorage.getItem(localKey(course)) || "null"));
    } catch {
      return { version: 1, sheets: [] };
    }
  }
  const response = await fetch(`/api/library/module-file?${new URLSearchParams({ module: course, path: TUTORIAL_PATH })}`, { headers: GUARD });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Could not read the tutorial sheets (${response.status}).`);
  if (typeof body.text !== "string") return { version: 1, sheets: [] };
  try {
    return parseTutorialFile(JSON.parse(body.text));
  } catch {
    return { version: 1, sheets: [] };
  }
}

export async function saveTutorials(course: string, hosted: boolean, file: TutorialFile): Promise<void> {
  const content = JSON.stringify(file);
  if (!hosted) {
    localStorage.setItem(localKey(course), content);
    return;
  }
  const response = await fetch("/api/library/module-file", {
    method: "PUT",
    headers: { ...GUARD, "content-type": "application/json" },
    body: JSON.stringify({ module: course, path: TUTORIAL_PATH, content }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Could not save the tutorial sheets (${response.status}).`);
  }
}
