import { PROFILES, type SubjectProfile } from "./subject-profiles.ts";

/**
 * The single source of truth for the Study Hub course format.
 *
 * Everything about the format lives here: what the folder looks like, how a file
 * is categorised, how a topic name becomes a path, how a course is validated,
 * and how every generated file is rendered. The reader (`app/page.tsx`), the
 * flashcard app, the validator and the AI conversion pipeline all import from
 * this module, so the generator necessarily writes what the reader can read.
 *
 * No React, no DOM, no FileSystemHandle — this file is pure so it can be unit
 * tested directly under `node --test`.
 */

/* ------------------------------------------------------------------ the spec */

export const SPEC = {
  version: 3,
  hub: "0 - START HERE.md",
  guidesDir: "Revision/Guides",
  packsDir: "Revision/Topic Packs",
  decksDir: "Flashcards",
  materialsDir: "Course Materials",
  materialsIndex: "Course Materials/00 - COURSE MATERIALS INDEX.md",
  sourceSubdirs: [
    "Lectures",
    "Transcripts",
    "Seminars",
    "Past Papers",
    "Reference",
    "Assessment Guidance",
  ],
  internalDir: ".study-hub",
  packSuffix: " (Topic Pack)",
  /**
   * Three decks per topic, in this order. The filenames are part of the format.
   * Append only — `FOUNDATIONS_SCHEMA`/`SCENARIOS_SCHEMA` in ai-conversion.ts look
   * up their card-count bounds from this array by `id`, but keeping the historical
   * order stable avoids ever reshuffling an existing user's deck folder.
   */
  decks: [
    { id: "foundations", file: "Foundations and Cases.csv", label: "Foundations and cases", min: 8, max: 60 },
    { id: "scenario", file: "Scenario to Case.csv", label: "Scenario to case", min: 6, max: 60 },
    { id: "pack-essentials", file: "Pack Essentials.csv", label: "Pack essentials", min: 8, max: 50 },
  ],
  csv: { header: ["Question", "Answer"], bom: true, eol: "\r\n" },
  /** `source: "derived"` guides are built from the packs and decks, with no AI call. */
  guides: [
    { n: 0, title: "Problem Question Technique + Issue-Spotting Map", source: "ai" },
    { n: 1, title: "How to Learn From Scratch", source: "ai" },
    { n: 2, title: "Five-Day First-Class Checklist", source: "ai" },
    { n: 3, title: "Master Issue-Spotting Checklist", source: "derived" },
    { n: 4, title: "Model Problem-Question Paragraphs", source: "ai" },
    { n: 5, title: "Case Coverage Index", source: "derived" },
  ],
  /**
   * Pack section letters and headings are owned by code. The model fills named
   * slots and never chooses a heading — that is what keeps every pack identical
   * in shape, which the reference folder itself failed to do.
   */
  packSections: [
    { letter: "A", key: "framework", heading: "Core framework (memorise this shape)" },
    { letter: "B", key: "rules", heading: "The law, rule-by-rule (with your case list)" },
    { letter: "C", key: "checklist", heading: "Issue-spotting checklist (run this on the facts)" },
    { letter: "D", key: "moves", heading: 'The "80+ moves" (how to score above a 2:1)' },
    { letter: "E", key: "worked", heading: "Worked micro-application" },
    { letter: "F", key: "traps", heading: "Common traps" },
  ],
  /** Mirrors the renderer in app/markdown.tsx. Nothing else is safe to emit. */
  markdown: {
    supported: [
      "ATX headings # to ######",
      "pipe tables with a header row",
      "task list items - [ ] and - [x]",
      "flat - and * bullet lists",
      "flat 1. and 1) numbered lists",
      "> blockquote lines",
      "--- horizontal rules",
      "inline **bold**, *italic*, `code`",
      "inline links [text](<target>)",
    ],
    forbidden: [
      "fenced code blocks",
      "images",
      "raw HTML",
      "YAML frontmatter",
      "nested lists",
      "footnotes",
      "reference-style links",
      "setext headings",
      "autolinks",
      "strikethrough",
    ],
  },
} as const;

export const TEXT_EXTS = new Set(["md", "txt", "csv"]);
export const SUPPORTED_EXTS = new Set([
  "md",
  "txt",
  "csv",
  "pdf",
  "docx",
  "pptx",
  "doc",
  "ppt",
  "xlsx",
  "xls",
]);
/** Extensions the writer is ever allowed to create. */
export const WRITABLE_EXTS = new Set(["md", "csv", "json"]);

export const CATEGORIES = [
  "Guides & hubs",
  "Study packs",
  "Flashcards",
  "Past papers",
  "Seminars",
  "Source materials",
  "Course materials",
] as const;
export type Category = (typeof CATEGORIES)[number];

/* ------------------------------------------------------ inference primitives */

/** Extracted verbatim from app/page.tsx so the reader and writer cannot drift. */
export function inferCategory(path: string, ext: string): Category {
  const p = path.toLowerCase();
  if (ext === "csv") return "Flashcards";
  if (p.includes("topic pack") || p.includes("study pack")) return "Study packs";
  if (p.includes("guide") || p.includes("start here") || p.includes("index"))
    return "Guides & hubs";
  if (p.includes("past paper")) return "Past papers";
  if (p.includes("seminar")) return "Seminars";
  if (
    p.includes("transcript") ||
    p.includes("lecture") ||
    ext === "txt" ||
    ext === "ppt" ||
    ext === "pptx"
  )
    return "Source materials";
  return "Course materials";
}

/** The human-facing topic name, e.g. "02 - Agreement (Offer & Acceptance)". */
export function topicLabel(path: string): string {
  const parts = path.split("/");
  const useful =
    [...parts].reverse().find((p) => /^\d{1,2}\s*[-–.]|topic/i.test(p)) ||
    parts.at(-2) ||
    "General";
  return useful
    .replace(/\.(md|csv|txt)$/i, "")
    .replace(/\s*\(Topic Pack\)/i, "")
    .trim();
}

/** The leading number of a topic label, if it has one. */
export function topicNumber(pathOrLabel: string): number | null {
  const match = topicLabel(pathOrLabel).match(/^(\d{1,2})\s*[-–.]/);
  return match ? Number(match[1]) : null;
}

/** The label with its number stripped, for display where numbering is implied. */
export function topicName(pathOrLabel: string): string {
  return topicLabel(pathOrLabel).replace(/^\d{1,2}\s*[-–.]\s*/, "").trim();
}

/**
 * The join key. A topic pack and its flashcard folder must resolve to the same
 * key or the dashboard counts zero cards for that pack and the sidebar lists the
 * topic twice. The reference Contract folder disagrees on `&` vs `and` for three
 * of fourteen topics, so we normalise at read time rather than renaming files —
 * a rename would change every card id and every saved checkbox key.
 */
export function canonicalTopicKey(labelOrPath: string): string {
  // A bare topic name ("Design Patterns") is its own label; only paths need
  // topicLabel, which would call an unnumbered name "General".
  const label = labelOrPath.includes("/")
    ? topicLabel(labelOrPath)
    : labelOrPath.replace(/\.(md|csv|txt)$/i, "").replace(/\s*\(Topic Pack\)/i, "").trim();
  return label
    .replace(/^\d{1,2}\s*[-–.]\s*/, "")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/* ------------------------------------------------------------ path builders */

export type TopicIdent = { number: number; name: string };

const WINDOWS_ILLEGAL = /[/\\:*?"<>|]/g;
const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * The one funnel every topic name passes through. Called once when a plan is
 * accepted; every path is then derived from the result, which is what makes the
 * pack filename and the deck folder name byte-identical by construction.
 */
export function normaliseTopicName(raw: string): string {
  const cleaned = raw
    .replace(/\s*&\s*/g, " and ")
    // Smart punctuation is folded BEFORE illegal characters are stripped, or a
    // curly quote would become a straight `"` that Windows refuses in a filename.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "")
    .replace(/[–—]/g, "-")
    .replace(WINDOWS_ILLEGAL, "-")
    .replace(/\s*\(Topic Pack\)\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 70)
    .trim();
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned} Topic` : cleaned || "Untitled Topic";
}

export function topicFolderName(t: TopicIdent): string {
  return `${String(t.number).padStart(2, "0")} - ${t.name}`;
}
export function packPath(t: TopicIdent): string {
  return `${SPEC.packsDir}/${topicFolderName(t)}${SPEC.packSuffix}.md`;
}
export function deckFile(deck: string, profile: SubjectProfile = PROFILES.law): string {
  const found = profile.decks.find((d) => d.id === deck);
  if (!found) throw new Error(`Unknown deck id: ${deck}`);
  return found.file;
}
export function deckPath(t: TopicIdent, deck: string, profile: SubjectProfile = PROFILES.law): string {
  return `${SPEC.decksDir}/${topicFolderName(t)}/${deckFile(deck, profile)}`;
}
export function guidePath(n: number, title?: string, profile: SubjectProfile = PROFILES.law): string {
  return `${SPEC.guidesDir}/${String(n).padStart(2, "0")} - ${profile.id === "law" && title !== undefined ? title : profile.guides.find((g) => g.n === n)?.title ?? title}.md`;
}

/**
 * Every path the writer may touch. The model never emits a path, so this is
 * defence in depth rather than the primary control.
 */
export function isWritablePath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (!WRITABLE_EXTS.has(ext)) return false;
  if (path === SPEC.hub) return true;
  if (path === SPEC.materialsIndex) return true;
  return (
    path.startsWith(`${SPEC.guidesDir}/`) ||
    path.startsWith(`${SPEC.packsDir}/`) ||
    path.startsWith(`${SPEC.decksDir}/`) ||
    path.startsWith(`${SPEC.internalDir}/`)
  );
}

/** Rejects anything that could escape the picked folder or upset Windows. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 400) return false;
  if (path !== path.normalize("NFC")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(path)) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split("/");
  if (segments.length > 4) return false;
  return segments.every((segment) => {
    if (!segment || segment === "." || segment === "..") return false;
    if (/[<>:"|?*]/.test(segment)) return false;
    if (/[ .]$/.test(segment)) return false;
    if (WINDOWS_RESERVED.test(segment)) return false;
    return true;
  });
}

/* ---------------------------------------------------------------- CSV codecs */

/** Extracted verbatim from app/page.tsx. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** BOM + CRLF + quote-every-field, matching the reference decks exactly. */
export function writeCsv(rows: string[][]): string {
  const body = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join(SPEC.csv.eol);
  return `${SPEC.csv.bom ? "\uFEFF" : ""}${body}${SPEC.csv.eol}`;
}

/** A CSV header row is valid if it names both required columns, in any case. */
export function csvHeaderIsValid(row: string[] | undefined): boolean {
  const headers = (row || []).map((v) => v.replace(/^\uFEFF/, "").trim().toLowerCase());
  return headers.includes("question") && headers.includes("answer");
}

/** Flattens model prose into something safe for a CSV cell (no markdown at all). */
export function plainForCsv(text: string): string {
  return String(text)
    .replace(/```+/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, " - ")
    .replace(/–/g, "-")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------ card identity */

/** Extracted verbatim from app/page.tsx. Renaming a deck or reordering its rows
 *  changes these ids, which is why the writer merges append-only. */
export function stableCardId(path: string, index: number, question: string): string {
  let hash = 2166136261;
  for (const char of `${path}:${index}:${question}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${path}:${(hash >>> 0).toString(36)}`;
}

export function fnv1a(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

/* ------------------------------------------------------------ link handling */

/** Extracted verbatim from app/page.tsx — the browser's tolerant normaliser. */
export function normaliseLinkTarget(path: string): string {
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a literal % is fine, leave it */
  }
  return path
    .replace(/^file:\/\//i, "")
    .replace(/^\/?[a-z]:/i, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

export const LINK_RE = /\[[^\]]+\]\((?:<([^>]+)>|([^)#]+))(?:#[^)]*)?\)/g;

/** Collapses `.` and `..` segments in a POSIX-ish path. */
export function resolvePosix(base: string, target: string): string {
  const stack = base ? base.split("/") : [];
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

/**
 * Resolve a markdown link target to a real inventory path.
 *
 * This is the reader's algorithm, extracted so the validator agrees with the UI
 * exactly. It is deliberately forgiving because real courses contain three
 * dialects of link: true relative paths (what we now emit), root-relative paths,
 * and absolute Windows paths with the course folder embedded (what the reference
 * folder is full of). Returns the matched inventory path, or null.
 */
export function resolveCourseLink(
  target: string,
  fromPath: string,
  courseName: string,
  inventoryPaths: string[],
): string | null {
  const clean = normaliseLinkTarget(target.split("#")[0]);
  if (!clean) return null;

  // An absolute path that runs through the course folder is re-rooted at it.
  let candidate = clean;
  if (courseName) {
    const at = clean.toLowerCase().indexOf(`${courseName.toLowerCase()}/`);
    if (at >= 0) candidate = clean.slice(at + courseName.length + 1);
  }
  // A bare filename is relative to the linking file's own directory.
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const candidates = [resolvePosix("", candidate)];
  if (dir) candidates.push(resolvePosix(dir, candidate));

  for (const option of candidates) {
    const needle = option.toLowerCase();
    const exact = inventoryPaths.find((p) => p.toLowerCase() === needle);
    if (exact) return exact;
  }
  for (const option of candidates) {
    const needle = option.toLowerCase();
    const suffix = inventoryPaths.find((p) => p.toLowerCase().endsWith(`/${needle}`));
    if (suffix) return suffix;
  }
  return null;
}

/**
 * A true relative path in angle brackets. Angle brackets are mandatory: pack
 * filenames contain parentheses, which the inline link regex cannot survive
 * unbracketed. A relative path is the only form that resolves correctly under
 * both the browser's root-relative resolver and a strict directory-relative one.
 */
export function relLink(fromPath: string, toPath: string, label: string): string {
  return `[${label}](<${relativePath(fromPath, toPath)}>)`;
}

export function relativePath(fromPath: string, toPath: string): string {
  const from = fromPath.split("/").slice(0, -1);
  const to = toPath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  const down = to.slice(shared);
  return [...Array(up).fill(".."), ...down].join("/") || to[to.length - 1];
}

/* --------------------------------------------------------------- validation */

export type Severity = "error" | "warning" | "info";
export type FixKind = "restructure" | "regenerate-links" | "ai-generate" | "manual" | "none";
export type IssueCode =
  | "empty-folder"
  | "no-hub"
  | "no-guides"
  | "no-packs"
  | "no-decks"
  | "no-source-materials"
  | "no-materials-index"
  | "csv-missing-columns"
  | "csv-no-rows"
  | "link-broken"
  | "link-absolute"
  | "pack-without-decks"
  | "decks-without-pack"
  | "topic-key-collision"
  | "pack-outside-canonical-dir"
  | "decks-outside-canonical-dir"
  | "duplicate-hub";

export type FormatIssue = {
  code: IssueCode;
  severity: Severity;
  message: string;
  path?: string;
  line?: number;
  detail?: { expected?: string; found?: string; target?: string; topicKey?: string };
  fix: FixKind;
};

export type TopicSummary = {
  key: string;
  label: string;
  name: string;
  number: number | null;
  packPath?: string;
  deckPaths: string[];
  cardCount: number;
  sourcePaths: string[];
  joined: boolean;
};

export type MissingPiece = {
  kind: "hub" | "guide" | "pack" | "deck" | "materials-index";
  path: string;
  topicKey?: string;
  needsAI: boolean;
  approxBytes: number;
};

export type FormatLevel = "empty" | "unformatted" | "partial" | "valid";

export type FormatReport = {
  courseName: string;
  fileCount: number;
  level: FormatLevel;
  /** The exact expression the dashboard used before this module existed. */
  legacyGate: boolean;
  has: {
    hub: boolean;
    guides: boolean;
    packs: boolean;
    decks: boolean;
    materialsIndex: boolean;
    sources: boolean;
  };
  topics: TopicSummary[];
  issues: FormatIssue[];
  missing: MissingPiece[];
  links: { total: number; broken: number; absolute: number };
  counts: { packs: number; decks: number; cards: number; guides: number; sources: number };
  canConvert: boolean;
  previouslyConverted: boolean;
  /** Changes when the folder materially changes, so an offer is made once. */
  hash: string;
};

/** The minimum a file must expose to be validated. `text` only for md/txt/csv. */
export type InventoryFile = {
  path: string;
  name?: string;
  ext?: string;
  size?: number;
  text?: string;
  category?: string;
};

const ERROR_CODES = new Set<IssueCode>([
  "empty-folder",
  "no-guides",
  "no-packs",
  "no-decks",
  "csv-missing-columns",
  "pack-without-decks",
  "decks-without-pack",
  "topic-key-collision",
  // A dead link is an error, not a nit: clicking it in the reader shows "that
  // linked file was not found", so the folder genuinely does not work as written.
  "link-broken",
]);

function extOf(file: InventoryFile): string {
  return (file.ext || file.path.split(".").pop() || "").toLowerCase();
}

export function validateCourse(
  files: InventoryFile[],
  options: { courseName?: string; manifestPresent?: boolean } = {},
  profile: SubjectProfile = PROFILES.law,
): FormatReport {
  const issues: FormatIssue[] = [];
  const add = (
    code: IssueCode,
    message: string,
    fix: FixKind,
    extra: Partial<FormatIssue> = {},
  ) =>
    issues.push({
      code,
      severity: extra.severity ?? (ERROR_CODES.has(code) ? "error" : "warning"),
      message,
      fix,
      ...extra,
    });

  const inventory = new Set(files.map((f) => f.path.toLowerCase()));
  const categoryOf = (f: InventoryFile) => f.category || inferCategory(f.path, extOf(f));

  /* --- structural presence. The guide rule keeps the old disjunction: either a
         file under Revision/Guides, or any *START HERE* markdown anywhere. --- */
  const mdFiles = files.filter((f) => extOf(f) === "md");
  const hubFiles = mdFiles.filter((f) => /start here|revision hub/i.test(f.path));
  const guideFiles = mdFiles.filter(
    (f) =>
      /(^|\/)revision\/guides\/.*\.md$/i.test(f.path) || /start here.*\.md$/i.test(f.path),
  );
  const packFiles = mdFiles.filter((f) => categoryOf(f) === "Study packs");
  const canonicalPacks = packFiles.filter((f) =>
    new RegExp(`(^|/)${SPEC.packsDir}/`, "i").test(f.path),
  );
  const csvFiles = files.filter((f) => extOf(f) === "csv");
  const canonicalDecks = csvFiles.filter((f) =>
    new RegExp(`(^|/)${SPEC.decksDir}/`, "i").test(f.path),
  );
  const sourceFiles = files.filter((f) =>
    ["Source materials", "Seminars", "Past papers", "Course materials"].includes(categoryOf(f)),
  );
  const materialsIndex = files.some((f) => /course materials index/i.test(f.path));

  const has = {
    hub: hubFiles.length > 0,
    guides: guideFiles.length > 0,
    packs: packFiles.length > 0,
    decks: csvFiles.length > 0,
    materialsIndex,
    sources: sourceFiles.length > 0,
  };

  if (files.length === 0)
    add("empty-folder", "This folder has no study files Study Hub can read.", "ai-generate");
  if (!has.hub && files.length)
    add("no-hub", `There is no "${SPEC.hub}" file to start from.`, "restructure");
  if (hubFiles.length > 1)
    add(
      "duplicate-hub",
      `${hubFiles.length} start-here files were found. Study Hub opens the first one, so the others may be stale.`,
      "manual",
      { detail: { found: hubFiles.map((f) => f.path).join(", ") } },
    );
  if (!has.guides && files.length)
    add("no-guides", `No revision guides were found under ${SPEC.guidesDir}.`, "ai-generate");
  if (!has.packs && files.length)
    add("no-packs", `No topic packs were found under ${SPEC.packsDir}.`, "ai-generate");
  if (!has.decks && files.length)
    add("no-decks", "No flashcard CSV files were found.", "ai-generate");
  if (!materialsIndex && sourceFiles.length)
    add(
      "no-materials-index",
      "Your original lectures and transcripts have no index file.",
      "restructure",
    );
  if (!has.sources && files.length)
    add(
      "no-source-materials",
      "No lectures, transcripts or seminar files were found to generate from.",
      "manual",
      { severity: "info" },
    );
  for (const pack of packFiles) {
    if (!canonicalPacks.includes(pack))
      add(
        "pack-outside-canonical-dir",
        `Topic pack is not under ${SPEC.packsDir}, so progress tracking may miss it.`,
        "manual",
        { path: pack.path },
      );
  }
  for (const deck of csvFiles) {
    if (!canonicalDecks.includes(deck))
      add(
        "decks-outside-canonical-dir",
        `Flashcard file is not under ${SPEC.decksDir}/, so it may not join a topic.`,
        "manual",
        { path: deck.path, severity: "info" },
      );
  }

  /* --- CSV content --- */
  let cardCount = 0;
  for (const file of csvFiles) {
    if (file.text === undefined) continue;
    const rows = parseCSV(file.text);
    if (!csvHeaderIsValid(rows[0])) {
      add(
        "csv-missing-columns",
        "This flashcard file needs a header row naming Question and Answer.",
        "manual",
        { path: file.path, line: 1, detail: { expected: "Question,Answer", found: (rows[0] || []).join(",") } },
      );
      continue;
    }
    const header = rows[0].map((v) => v.replace(/^\uFEFF/, "").trim().toLowerCase());
    const qi = header.indexOf("question");
    const ai = header.indexOf("answer");
    const usable = rows
      .slice(1)
      .filter((row) => (row[qi] || "").trim() && (row[ai] || "").trim());
    if (!usable.length)
      add("csv-no-rows", "This flashcard file has a header but no usable cards.", "manual", {
        path: file.path,
      });
    cardCount += usable.length;
  }

  /* --- links. Resolved under both semantics; only broken under both is an error. --- */
  let linkTotal = 0;
  let linkBroken = 0;
  let linkAbsolute = 0;
  const inventoryPaths = files.map((f) => f.path);
  const courseName = options.courseName || "";
  for (const file of mdFiles) {
    if (file.text === undefined) continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(LINK_RE)) {
        const raw = (match[1] || match[2] || "").trim();
        if (!raw || raw.startsWith("#") || /^[a-z]+:/i.test(raw)) continue;
        linkTotal++;
        const absolute = /^\/?[a-z]:/i.test(raw) || raw.startsWith("/");
        const found = resolveCourseLink(raw, file.path, courseName, inventoryPaths) !== null;
        if (absolute) {
          linkAbsolute++;
          add(
            "link-absolute",
            "This link uses an absolute path, so it breaks if the folder ever moves.",
            "regenerate-links",
            { path: file.path, line: i + 1, detail: { target: raw }, severity: "warning" },
          );
        }
        if (!found) {
          linkBroken++;
          add("link-broken", "This link points at a file that is not in the folder.", "regenerate-links", {
            path: file.path,
            line: i + 1,
            detail: { target: raw },
          });
        }
      }
    }
  }

  /* --- topics and the pack/deck join --- */
  const byKey = new Map<string, TopicSummary>();
  const touch = (path: string): TopicSummary => {
    const key = canonicalTopicKey(path);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key,
        label: topicLabel(path),
        name: topicName(path),
        number: topicNumber(path),
        deckPaths: [],
        cardCount: 0,
        sourcePaths: [],
        joined: false,
      };
      byKey.set(key, entry);
    }
    return entry;
  };
  const labelsPerKey = new Map<string, Set<string>>();
  for (const pack of packFiles) {
    const entry = touch(pack.path);
    if (entry.packPath) {
      add(
        "topic-key-collision",
        `Two topic packs resolve to the same topic: "${entry.packPath}" and "${pack.path}".`,
        "manual",
        { path: pack.path, detail: { topicKey: entry.key } },
      );
    } else entry.packPath = pack.path;
    if (entry.number === null) entry.number = topicNumber(pack.path);
    labelsPerKey.set(entry.key, (labelsPerKey.get(entry.key) || new Set()).add(topicLabel(pack.path)));
  }
  for (const deck of csvFiles) {
    const entry = touch(deck.path);
    entry.deckPaths.push(deck.path);
    if (deck.text !== undefined) {
      const rows = parseCSV(deck.text);
      if (csvHeaderIsValid(rows[0])) {
        const header = rows[0].map((v) => v.replace(/^\uFEFF/, "").trim().toLowerCase());
        const qi = header.indexOf("question");
        const ai = header.indexOf("answer");
        entry.cardCount += rows
          .slice(1)
          .filter((row) => (row[qi] || "").trim() && (row[ai] || "").trim()).length;
      }
    }
    labelsPerKey.set(entry.key, (labelsPerKey.get(entry.key) || new Set()).add(topicLabel(deck.path)));
  }
  for (const source of sourceFiles) {
    const key = canonicalTopicKey(source.path);
    const entry = byKey.get(key);
    if (entry) entry.sourcePaths.push(source.path);
  }
  for (const entry of byKey.values()) {
    entry.joined = Boolean(entry.packPath) && entry.deckPaths.length > 0;
    const variants = labelsPerKey.get(entry.key);
    if (variants && variants.size > 1)
      add(
        "topic-key-collision",
        `The same topic is spelled ${variants.size} different ways: ${[...variants]
          .map((v) => `"${v}"`)
          .join(" and ")}. Study Hub now treats them as one topic.`,
        "manual",
        { detail: { topicKey: entry.key, found: [...variants].join(" | ") }, severity: "warning" },
      );
    if (entry.packPath && !entry.deckPaths.length)
      add("pack-without-decks", `"${entry.label}" has a topic pack but no flashcards.`, "ai-generate", {
        path: entry.packPath,
        detail: { topicKey: entry.key },
      });
    if (!entry.packPath && entry.deckPaths.length)
      add("decks-without-pack", `"${entry.label}" has flashcards but no topic pack.`, "ai-generate", {
        path: entry.deckPaths[0],
        detail: { topicKey: entry.key },
      });
  }
  const topics = [...byKey.values()].sort(
    (a, b) => (a.number ?? 99) - (b.number ?? 99) || a.label.localeCompare(b.label),
  );

  /* --- what is missing, as exact paths --- */
  const missing: MissingPiece[] = [];
  if (!has.hub) missing.push({ kind: "hub", path: SPEC.hub, needsAI: false, approxBytes: 3500 });
  if (!materialsIndex && sourceFiles.length)
    missing.push({
      kind: "materials-index",
      path: SPEC.materialsIndex,
      needsAI: false,
      approxBytes: Math.max(1200, sourceFiles.length * 130),
    });
  for (const guide of profile.guides) {
    const path = guidePath(guide.n, guide.title, profile);
    if (!inventory.has(path.toLowerCase()))
      missing.push({
        kind: "guide",
        path,
        needsAI: guide.source === "ai",
        approxBytes: guide.source === "ai" ? 9000 : 4000,
      });
  }
  for (const entry of topics) {
    if (entry.number === null) continue;
    const ident: TopicIdent = { number: entry.number, name: normaliseTopicName(entry.name) };
    if (!entry.packPath)
      missing.push({
        kind: "pack",
        path: packPath(ident),
        topicKey: entry.key,
        needsAI: true,
        approxBytes: 16000,
      });
    for (const deck of profile.decks) {
      const path = deckPath(ident, deck.id, profile);
      if (!inventory.has(path.toLowerCase()))
        missing.push({
          kind: "deck",
          path,
          topicKey: entry.key,
          needsAI: true,
          approxBytes: 9000,
        });
    }
  }

  const legacyGate =
    files.some((f) => categoryOf(f) === "Guides & hubs") &&
    files.some((f) => categoryOf(f) === "Study packs") &&
    files.some((f) => categoryOf(f) === "Flashcards");

  const errors = issues.filter((i) => i.severity === "error");
  const level: FormatLevel =
    files.length === 0
      ? "empty"
      : !legacyGate
        ? "unformatted"
        : errors.length === 0 && topics.every((t) => t.joined)
          ? "valid"
          : "partial";

  return {
    courseName: options.courseName || "",
    fileCount: files.length,
    level,
    legacyGate,
    has,
    topics,
    issues,
    missing,
    links: { total: linkTotal, broken: linkBroken, absolute: linkAbsolute },
    counts: {
      packs: packFiles.length,
      decks: csvFiles.length,
      cards: cardCount,
      guides: guideFiles.length,
      sources: sourceFiles.length,
    },
    canConvert: sourceFiles.some((f) => f.text !== undefined) || sourceFiles.length > 0,
    previouslyConverted: Boolean(options.manifestPresent),
    hash: fnv1a(
      files
        .map((f) => `${f.path}:${f.size ?? f.text?.length ?? 0}`)
        .sort()
        .join("|"),
    ),
  };
}

/** Groups issues for the dialog, in display order. */
export function groupIssues(issues: FormatIssue[]) {
  const groups: { title: string; codes: IssueCode[] }[] = [
    { title: "Structure", codes: ["empty-folder", "no-hub", "duplicate-hub", "no-guides", "no-packs", "no-decks", "no-materials-index", "no-source-materials"] },
    { title: "Flashcard files", codes: ["csv-missing-columns", "csv-no-rows"] },
    { title: "Links", codes: ["link-broken", "link-absolute"] },
    { title: "Topics", codes: ["pack-without-decks", "decks-without-pack", "topic-key-collision", "pack-outside-canonical-dir", "decks-outside-canonical-dir"] },
  ];
  return groups
    .map((group) => ({
      title: group.title,
      issues: issues.filter((issue) => group.codes.includes(issue.code)),
    }))
    .filter((group) => group.issues.length > 0);
}
