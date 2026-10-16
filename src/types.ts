/**
 * Shared types for the Crawler engine. Everything above the adapter layer
 * (naming, sorting, deadlines, sync) sees only these, never raw VLE JSON.
 * See docs/design/02 (adapters) and docs/design/03 (folder and data model).
 *
 * Source files use only erasable TypeScript, so Node runs them directly.
 */

/* ------------------------------------------------------------- VLE side */

/** What an adapter returns from login, kept by the caller in a TokenStore. */
export type Credentials = {
  site: string; // "https://qmplus.qmul.ac.uk"
  token: string;
  privateToken: string | null;
};

/** Persists credentials encrypted (Electron safeStorage in the app). */
export interface TokenStore {
  load(site: string): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
  clear(site: string): Promise<void>;
}

/** One enrolled course as the VLE describes it. Naming is done elsewhere. */
export type Course = {
  id: number;
  shortname: string; // "ECS505U 2026/27"
  fullname: string; // "ECS505U Software Engineering 2026/27"
  startdate: number | null; // unix seconds
  enddate: number | null;
  url: string;
};

export type VleFile = {
  filename: string;
  /** Sub-path inside a folder activity, "/" when none. */
  filepath: string;
  /** Download URL WITHOUT credentials; the adapter adds them in download(). */
  url: string;
  size: number;
  mimetype: string | null;
  modified: number | null; // unix seconds
};

/** Where an item sits in the course, used as sorting evidence. */
export type Placement = {
  section: string;
  sectionIndex: number;
  activity: string;
  activityType: string; // VLE-native type, e.g. Moodle modname "resource", "assign", "page"
  activityId: number;
  activityUrl: string;
};

export type VleItem =
  | ({ kind: "file"; file: VleFile } & Placement)
  | ({ kind: "page"; html: string; files: VleFile[] } & Placement)
  | ({ kind: "link"; target: string } & Placement)
  | ({ kind: "external-tool"; toolName: string; instance?: number } & Placement)
  | {
      kind: "assignment";
      id: number;
      activityId: number;
      title: string;
      due: number | null; // unix seconds
      cutoff: number | null;
      introHtml: string;
      briefFiles: VleFile[];
      url: string;
      modified: number | null;
    }
  | {
      kind: "quiz";
      id: number;
      activityId: number;
      title: string;
      opens: number | null;
      closes: number | null;
      url: string;
    }
  | {
      kind: "event";
      id: number;
      title: string;
      start: number; // unix seconds
      activityType: string | null; // "assign", "quiz", … or null for course/site events
      url: string;
    }
  | {
      kind: "announcement";
      id: number;
      subject: string;
      bodyHtml: string;
      posted: number;
      url: string;
    };

export interface UniversityAdapter {
  id: string; // "qmul"
  platform: "moodle" | "brightspace";
  displayName: string;
  site: string;
  /** Interactive sign-in in a real browser window; see LoginBrowser. */
  login(browser: LoginBrowser): Promise<Credentials>;
  whoAmI(credentials: Credentials): Promise<{ userId: number; permittedFunctions: string[] }>;
  listCourses(credentials: Credentials): Promise<Course[]>;
  listItems(credentials: Credentials, course: Course): Promise<VleItem[]>;
  ltiLaunch?(credentials: Credentials, instance: number): Promise<{ endpoint: string; fields: URLSearchParams }>;
  download(credentials: Credentials, file: VleFile): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Supplied by the host app (Electron). Opens `url` in an isolated window and
 * resolves with the first navigation to a URL starting with `captureScheme`.
 */
export interface LoginBrowser {
  capture(url: string, captureScheme: string): Promise<string>;
}

/** Thrown by adapters; `code` drives what the UI tells the student. */
export class VleError extends Error {
  readonly code: "invalid_token" | "access_denied" | "unavailable" | "bad_response";
  constructor(code: VleError["code"], message: string) {
    super(message);
    this.name = "VleError";
    this.code = code;
  }
}

/* ------------------------------------------------------------- folder side */

export const CATEGORIES = [
  "Lectures",
  "Transcripts",
  "Labs and Seminars",
  "Past Papers",
  "Reference",
  "Assessment Guidance",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Where a course lands: My Studies/<year>/<module>/ */
export type ModulePlacement = {
  code: string | null; // "ECS505U"
  title: string; // "Software Engineering"
  folder: string; // "ECS505U - Software Engineering"
  year: string; // "2026-27" or "Undated"
  isModule: boolean; // false for non-module sites like "Academic Integrity…"
};

export type ManifestEntry = {
  vleId: string;
  module: string; // course shortname
  sourceUrl: string; // never contains a token
  localPath: string; // relative to My Studies, forward slashes
  category: Category;
  categoryReason: string;
  vleModified: string | null; // ISO
  sha256: string;
  writtenAt: string; // ISO
};

/* ------------------------------------------------------------- deadlines */

export type Instant = { iso: string; allDay: boolean; tz: "Europe/London" };

export type Source = {
  type: "vle-field" | "document" | "announcement" | "page";
  strength: "structured" | "quoted";
  url: string;
  localPath?: string;
  page?: number;
  line?: number;
  quote: string;
  date: Instant | null;
  seenAt: string; // ISO
  /**
   * Who found a quoted source. Rules re-read every document each sync, so a
   * rule source that is not found again is gone; the AI only reads changed
   * documents, so its sources are kept until the document changes.
   */
  origin?: "rule" | "ai";
};

export type Change = {
  at: string; // ISO
  field: "due" | "status" | "title" | "weight" | "removed" | "added";
  from: string | null;
  to: string | null;
  source?: Source;
};

export type DeadlineStatus = "confirmed" | "conflict" | "tbc" | "needs-check" | "user-verified" | "cancelled";

export type Deadline = {
  id: string;
  module: string; // module code if known, else course shortname
  year: string; // academic year folder, "2026-27"
  title: string;
  kind: "coursework" | "exam" | "quiz" | "presentation" | "lab" | "other";
  status: DeadlineStatus;
  due: Instant | null;
  window?: { from: Instant; to: Instant };
  weight?: number; // % of module
  formative?: boolean;
  checkReason?: string;
  submitUrl?: string;
  sources: Source[];
  history: Change[];
  userNote?: string;
};

/* ------------------------------------------------------------- AI (host-provided) */

export interface AiRunner {
  available(): Promise<{ cli: "claude" | "codex" | null }>;
  structured<T>(request: { system: string; prompt: string; schema: object }): Promise<T>;
}
