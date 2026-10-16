/**
 * The host library: the My Studies folder, read through Study Hub's own host
 * instead of a folder picker. Only available when `isHosted()`.
 *
 *   My Studies/<year>/<module>/   one module = one Study Hub course
 *   My Studies/Deadlines.json     every module's deadlines, written by Crawler
 */

import { PROFILES, inferProfile, type SubjectId } from "./subject-profiles.ts";
import { SUPPORTED_EXTS, inferCategory, topicLabel } from "./course-format.ts";
import type { LocalFile } from "./course-fs.ts";

const GUARD = { "x-study-hub-host": "1" };

export type LibraryYear = { year: string; modules: string[] };
export type LibraryEntry = { path: string; size: number; modified: number };
export type LibraryTree = { root: string; found: boolean; years: LibraryYear[]; files: LibraryEntry[] };

export type Instant = { iso: string; allDay: boolean; tz: string };
export type DeadlineSource = {
  type: "vle-field" | "document" | "announcement" | "page";
  strength: "structured" | "quoted";
  url: string;
  localPath?: string;
  page?: number;
  quote: string;
  date: Instant | null;
};
export type DeadlineStatus = "confirmed" | "conflict" | "tbc" | "needs-check" | "user-verified" | "cancelled";
export type Deadline = {
  id: string;
  module: string;
  year: string;
  title: string;
  kind: "coursework" | "exam" | "quiz" | "presentation" | "lab" | "other";
  status: DeadlineStatus;
  due: Instant | null;
  weight?: number;
  formative?: boolean;
  checkReason?: string;
  submitUrl?: string;
  sources: DeadlineSource[];
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...GUARD, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Study Hub could not read your library (${response.status}).`);
  return body as T;
}

export const fetchTree = () => call<LibraryTree>("/api/library/tree");
export const fetchDeadlines = () => call<{ deadlines: Deadline[] }>("/api/library/deadlines").then((r) => r.deadlines);
export const resolveDeadline = (id: string, choice: { sourceIndex: number } | { date: string }) =>
  call<{ deadline: Deadline }>("/api/library/deadlines/resolve", {
    method: "POST",
    body: JSON.stringify({ id, ...choice }),
  }).then((r) => r.deadline);

/** URL of a library file, e.g. for opening a PDF at a page. */
export const libraryUrl = (path: string) => `/library/${path.split("/").map(encodeURIComponent).join("/")}`;

/** `ECS505U - Software Engineering` → `ECS505U`. */
export const moduleCode = (folder: string) => folder.split(" - ")[0].trim();

/**
 * A File-shaped stand-in that fetches its bytes only when read, so opening a
 * module with 300 MB of slides does not download them all into the page.
 */
function lazyFile(entry: LibraryEntry, name: string): File {
  const url = libraryUrl(entry.path);
  const bytes = () => fetch(url).then((r) => r.arrayBuffer());
  return {
    name,
    size: entry.size,
    lastModified: entry.modified,
    type: "",
    arrayBuffer: bytes,
    text: () => fetch(url).then((r) => r.text()),
  } as unknown as File;
}

/** One module's files, with paths relative to the module folder as a picked folder would have. */
export async function loadModule(tree: LibraryTree, year: string, module: string): Promise<LocalFile[]> {
  const prefix = `${year}/${module}/`;
  const entries = tree.files.filter((f) => f.path.startsWith(prefix));
  const textPaths = entries.filter((f) => /\.(md|txt|csv)$/i.test(f.path)).map((f) => f.path);
  const { texts } = textPaths.length
    ? await call<{ texts: Record<string, string> }>("/api/library/texts", {
        method: "POST",
        body: JSON.stringify({ paths: textPaths }),
      })
    : { texts: {} as Record<string, string> };

  const files: LocalFile[] = [];
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length);
    const name = path.split("/").pop()!;
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (!SUPPORTED_EXTS.has(ext)) continue;
    files.push({
      path,
      name,
      ext,
      file: lazyFile(entry, name),
      text: texts[entry.path],
      category: inferCategory(path, ext),
      topic: topicLabel(path),
      url: libraryUrl(entry.path),
    });
  }
  return files;
}

/** Module colours: always shown beside the module code, never alone. */
const PALETTE = ["#0d756d", "#c85f45", "#5b6fb0", "#a07a1f", "#7a4f9a", "#2f7fa8", "#8a6a55", "#4d8a3f"];
export function moduleColor(modules: string[], module: string): string {
  const index = modules.indexOf(module);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
}

/** The current academic year folder: September onwards starts a new year. */
export function currentAcademicYear(now = new Date()): string {
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ active module */

const ACTIVE_KEY = "studyhub:library:active";

/** `<year>/<module>`: the key progress and flashcard data are stored under. */
export function savedActiveModule(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveActiveModule(key: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, key);
  } catch {
    /* progress still works for this session */
  }
}

/** The remembered module if it still exists, else the first folder of the current (or newest) year. */
export function pickModule(tree: LibraryTree, remembered = savedActiveModule()): { year: string; module: string } | null {
  for (const { year, modules } of tree.years)
    for (const folder of modules) if (`${year}/${folder}` === remembered) return { year, module: folder };
  const current = tree.years.find((y) => y.year === currentAcademicYear() && y.modules.length);
  const fallback = current || tree.years.find((y) => y.modules.length);
  return fallback ? { year: fallback.year, module: fallback.modules[0] } : null;
}

/**
 * Progress used to be keyed by the folder name alone. Under the library two
 * years can hold a folder of the same name, so keys gain the year. The first
 * time a module opens under its new key, its old data is copied across once.
 */
export function migrateModuleKeys(key: string) {
  const folder = key.split("/").pop()!;
  for (const prefix of ["studyhub:", "studyhub:view:", "studyhub:flashcards:", "studyhub:formatcheck:"]) {
    try {
      const old = localStorage.getItem(`${prefix}${folder}`);
      if (old !== null && localStorage.getItem(`${prefix}${key}`) === null) localStorage.setItem(`${prefix}${key}`, old);
    } catch {
      /* nothing to migrate */
    }
  }
}

/* ------------------------------------------------------------ Converter */

type HostDir = import("./course-fs.ts").DirectoryHandle;

function notFound(path: string): DOMException {
  return new DOMException(`${path} does not exist.`, "NotFoundError");
}

/**
 * A stand-in for a picked folder, so the Converter (which reads and writes
 * through File System Access handles) works on a library module unchanged.
 * Reads and writes go through the host, which allows only Study Hub's own
 * files (the hub, Revision/, Flashcards/, the materials index, .study-hub/).
 * Listing is not supported: the Converter gets its file list from loadModule.
 */
export function hostModuleHandle(moduleKey: string, prefix = ""): HostDir {
  const name = prefix ? prefix.split("/").pop()! : moduleKey.split("/").pop()!;
  const join = (child: string) => (prefix ? `${prefix}/${child}` : child);
  const dir = {
    kind: "directory" as const,
    name,
    isSameEntry: async () => false,
    async *values() {},
    async queryPermission() {
      return "granted" as PermissionState;
    },
    async requestPermission() {
      return "granted" as PermissionState;
    },
    async getDirectoryHandle(child: string) {
      return hostModuleHandle(moduleKey, join(child));
    },
    async getFileHandle(child: string) {
      const path = join(child);
      return {
        kind: "file" as const,
        name: child,
        isSameEntry: async () => false,
        async getFile() {
          const { text } = await call<{ text: string | null }>(
            `/api/library/module-file?module=${encodeURIComponent(moduleKey)}&path=${encodeURIComponent(path)}`,
          );
          if (text === null) throw notFound(path);
          return new File([text], child, { type: "text/plain" });
        },
        async createWritable() {
          const parts: BlobPart[] = [];
          return {
            async write(data: string | BufferSource | Blob) {
              parts.push(data as BlobPart);
            },
            async close() {
              const content = await new Blob(parts).text();
              await call("/api/library/module-file", {
                method: "PUT",
                body: JSON.stringify({ module: moduleKey, path, content }),
              });
            },
            async abort() {
              parts.length = 0;
            },
          };
        },
      };
    },
  };
  return dir as unknown as HostDir;
}


export type ModuleProfile = { profile: SubjectId; confirmed: boolean; reason: string };

/** A read-only folder import can suggest a subject without a directory handle. */
export function suggestModuleProfile(name: string, files: Pick<LocalFile, "path">[] = []): ModuleProfile {
  if (files.some((f) => /(?:^|\/)Foundations and Cases\.csv$/.test(f.path)) ||
      files.some((f) => /(?:Problem Question Technique \+ Issue-Spotting Map|Master Issue-Spotting Checklist|Model Problem-Question Paragraphs|Case Coverage Index)\.md$/.test(f.path)))
    return { profile: "law", confirmed: true, reason: "Existing law revision files." };
  const suggestion = inferProfile(moduleCode(name), name);
  return { profile: suggestion.id, confirmed: false, reason: suggestion.reason };
}

/** Reads a saved choice or a suggestion; legacy law files migrate without writes. */
export async function getModuleProfile(module: string | HostDir, files: Pick<LocalFile, "path">[] = []): Promise<ModuleProfile> {
  const name = typeof module === "string" ? module.split("/").pop()! : module.name;
  const handle = typeof module === "string" ? hostModuleHandle(module) : module;
  let text: string | null = null;
  try {
    const dir = await handle.getDirectoryHandle(".study-hub");
    text = await (await (await dir.getFileHandle("profile.json")).getFile()).text();
  } catch (error) {
    if ((error as Error).name !== "NotFoundError") throw error;
  }
  if (text !== null) {
    try {
      const saved = JSON.parse(text);
      if (saved && Object.hasOwn(PROFILES, saved.profile) && ["student", "suggested"].includes(saved.chosenBy))
        return { profile: saved.profile, confirmed: true, reason: "Saved subject choice." };
    } catch { /* Invalid old settings fall back to inference. */ }
  }
  return suggestModuleProfile(name, files);
}

export async function setModuleProfile(module: string | HostDir, profile: SubjectId, chosenBy: "student" | "suggested" = "student"): Promise<void> {
  if (!Object.hasOwn(PROFILES, profile) || !["student", "suggested"].includes(chosenBy)) throw new Error("Invalid subject profile.");
  const content = JSON.stringify({ profile, chosenBy, at: new Date().toISOString() }) + "\n";
  if (typeof module === "string") {
    await call("/api/library/module-file", { method: "PUT", body: JSON.stringify({ module, path: ".study-hub/profile.json", content }) });
    return;
  }
  if (module.requestPermission && await module.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Write permission is required to save the subject.");
  const dir = await module.getDirectoryHandle(".study-hub", { create: true });
  const file = await dir.getFileHandle("profile.json", { create: true });
  if (!file.createWritable) throw new Error("This folder cannot be written.");
  const writer = await file.createWritable();
  await writer.write(content);
  await writer.close();
}
