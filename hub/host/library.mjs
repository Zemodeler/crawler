/**
 * The library: Study Hub's view of the My Studies folder Crawler fills.
 *
 *   My Studies/
 *     Deadlines.json
 *     2026-27/
 *       ECS505U - Software Engineering/   ← one module (a Study Hub course)
 *
 * Students can add deadlines, mark them done, and resolve dates they have
 * checked (status `user-verified`). Every path from the page is checked to stay
 * inside the root, so a crafted `../` can never reach the rest of the disk.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";

// The same rules the Converter applies in the page: one definition, so the
// host can never allow a write the page would refuse, or the reverse.
import { isSafeRelativePath, isWritablePath } from "../lib/course-format.ts";
import { PROFILES } from "../lib/subject-profiles.ts";
import { readDeadlineFile, withDeadlineLock, writeDeadlineFile } from "../../src/deadline-store.ts";

const YEAR = /^\d{4}-\d{2}$/;
/** Where the sync puts modules with no academic year in their name or dates (src/naming.ts). */
const UNDATED = "Undated";
const isYearFolder = (name) => YEAR.test(name) || name === UNDATED;
const TEXT_EXTS = new Set(["md", "txt", "csv"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;

function hasControlCharacters(value, allowWhitespace = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    if (allowWhitespace && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || code === 127;
  });
}

export const RAW_MIME = {
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** STUDYHUB_LIBRARY overrides the default, which is where Crawler syncs to. */
export function libraryRoot() {
  return resolve(process.env.STUDYHUB_LIBRARY || join(homedir(), "Documents", "My Studies"));
}

/** The absolute path for a page-supplied relative path, or null if it would leave the root. */
export function resolveInside(root, relative) {
  if (typeof relative !== "string" || !relative || relative.length > 600) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\\]/.test(relative) || relative.startsWith("/") || /^[a-zA-Z]:/.test(relative)) return null;
  const segments = relative.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || s.startsWith("."))) return null;
  const full = resolve(root, ...segments);
  if (!full.startsWith(root + sep)) return null;
  // A junction or symlink inside the library must not lead outside it either.
  try {
    const real = realpathSync(full);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch {
    return null;
  }
  return full;
}

async function walk(root, dir, prefix, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, path, out);
    else if (entry.isFile()) {
      const info = await stat(full).catch(() => null);
      if (info) out.push({ path, size: info.size, modified: info.mtimeMs });
    }
  }
}

/**
 * Years (newest first), the modules in each, and every file below the modules.
 * A module is any folder two levels down: `<year>/<module>/`.
 */
export async function listLibrary(root = libraryRoot()) {
  if (!existsSync(root)) return { found: false, years: [], files: [] };
  const years = [];
  const files = [];
  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  // Newest year first; undated modules after every dated year.
  const folders = top.filter((e) => e.isDirectory() && isYearFolder(e.name)).map((e) => e.name);
  const ordered = [...folders.filter((name) => name !== UNDATED).sort().reverse(), ...folders.filter((name) => name === UNDATED)];
  for (const year of ordered) {
    const inner = await readdir(join(root, year), { withFileTypes: true }).catch(() => []);
    const modules = inner
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    years.push({ year, modules });
    for (const folder of modules) await walk(root, join(root, year, folder), `${year}/${folder}`, files);
  }
  return { found: true, years, files };
}

/** Text of the small text files asked for, keyed by path. Anything else is skipped. */
export async function readTexts(root, paths) {
  const out = {};
  for (const path of Array.isArray(paths) ? paths.slice(0, 5_000) : []) {
    const ext = String(path).split(".").pop()?.toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    const full = resolveInside(root, path);
    if (!full) continue;
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || info.size > MAX_TEXT_BYTES) continue;
    out[path] = await readFile(full, "utf8").catch(() => undefined);
  }
  return out;
}

export async function readDeadlines(root = libraryRoot()) {
  return readDeadlineFile(root);
}

export async function readAssessments(root = libraryRoot()) {
  try {
    const parsed = JSON.parse(await readFile(join(root, "Assessments.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeDeadlines(root, deadlines) {
  await writeDeadlineFile(root, deadlines);
}

/** Match Crawler's Instants: London wall time, with all-day dates at London midnight. */
function londonInstant(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(date)) return null;
  const allDay = date.length === 10;
  const wall = Date.parse(`${date.slice(0, 10)}T${allDay ? "00:00" : date.slice(11)}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== `${date.slice(0, 10)}T${allDay ? "00:00" : date.slice(11)}`) return null;
  const offset = (utc) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utc;
  };
  // Try the offsets on either side of a clock change and round-trip each
  // candidate through London wall time. The earlier match is the BST occurrence
  // of October's repeated hour; March's skipped hour has no match.
  const day = 24 * 60 * 60 * 1000;
  const candidates = [wall - offset(wall - day), wall - offset(wall + day)].sort((a, b) => a - b);
  const utc = candidates.find((candidate) => candidate + offset(candidate) === wall);
  if (utc === undefined) return { error: "That time does not exist in the UK: clocks go forward at 01:00 on that day." };
  return { iso: new Date(utc).toISOString(), allDay, tz: "Europe/London" };
}

async function addDeadlineUnlocked(root, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Enter a deadline." };
  const { module, year, title, kind, date, weight, formative, note } = body;
  const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !hasControlCharacters(v);
  if (!text(module, 100) || !/^[A-Za-z0-9_-]+$/.test(module)) return { error: "Choose a module." };
  if (typeof year !== "string" || (year !== UNDATED && (!YEAR.test(year) || Number(year.slice(5)) !== (Number(year.slice(0, 4)) + 1) % 100))) return { error: "Choose an academic year." };
  const tree = await listLibrary(root);
  if (!tree.years.some((y) => y.year === year && y.modules.some((f) => f.split(" - ")[0].trim() === module))) return { error: "Choose a module in your library." };
  if (!text(title, 500)) return { error: "Enter a title (up to 500 characters)." };
  if (!["coursework", "exam", "quiz", "presentation", "lab", "other"].includes(kind)) return { error: "Choose a deadline type." };
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(date)) return { error: "Enter a date and optional time." };
  const due = londonInstant(date);
  if (!due) return { error: "Enter a valid date and time." };
  if (due.error) return due;
  if (weight !== undefined && (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 100)) return { error: "Weight must be between 0 and 100." };
  if (formative !== undefined && typeof formative !== "boolean") return { error: "Formative must be true or false." };
  if (note !== undefined && (typeof note !== "string" || note.length > 4000 || hasControlCharacters(note, true))) return { error: "Enter a note of up to 4000 characters." };
  const deadline = {
    id: `user:${module}:${randomBytes(12).toString("hex")}`, module, year, title: title.trim(), kind,
    status: "user-verified", due, sources: [],
    history: [{ at: new Date().toISOString(), field: "added", from: null, to: due.iso }],
    ...(weight !== undefined ? { weight } : {}), ...(formative !== undefined ? { formative } : {}),
    ...(note !== undefined ? { userNote: note } : {}),
  };
  const deadlines = await readDeadlines(root);
  deadlines.push(deadline);
  await writeDeadlines(root, deadlines);
  return { deadline };
}

async function removeDeadlineUnlocked(root, body) {
  if (typeof body?.id !== "string" || !body.id.startsWith("user:")) return { error: "Only deadlines you added can be removed." };
  const deadlines = await readDeadlines(root);
  if (!deadlines.some((d) => d.id === body.id)) return { error: "No deadline with that id." };
  await writeDeadlines(root, deadlines.filter((d) => d.id !== body.id));
  return { ok: true };
}

async function setDeadlineDoneUnlocked(root, body) {
  if (typeof body?.id !== "string" || typeof body?.done !== "boolean") return { error: "Choose a deadline and whether it is done." };
  const deadlines = await readDeadlines(root);
  const deadline = deadlines.find((d) => d.id === body.id);
  if (!deadline) return { error: "No deadline with that id." };
  if (body.done) deadline.done = true;
  else delete deadline.done;
  await writeDeadlines(root, deadlines);
  return { deadline };
}

/**
 * The student settles a deadline: either one of its sources' dates, or a date
 * they type. Written back as `user-verified`, which Crawler never overwrites.
 */
async function resolveDeadlineUnlocked(root, body) {
  const deadlines = await readDeadlines(root);
  const item = deadlines.find((d) => d.id === body?.id);
  if (!item) return { error: "No deadline with that id." };

  let due;
  if (Number.isInteger(body.sourceIndex)) {
    due = item.sources?.[body.sourceIndex]?.date;
    if (!due) return { error: "That source has no date." };
  } else if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(body.date)) {
    due = londonInstant(body.date);
    if (!due) return { error: "Enter a valid date and time." };
    if (due.error) return due;
  } else return { error: "Choose a source or enter a date." };

  const at = new Date().toISOString();
  item.history = [
    ...(item.history || []),
    { at, field: "due", from: item.due?.iso ?? null, to: due.iso },
    { at, field: "status", from: item.status, to: "user-verified" },
  ];
  item.due = due;
  item.status = "user-verified";
  delete item.checkReason;

  // Write beside, then swap, so a crash never leaves half a file.
  await writeDeadlines(root, deadlines);
  return { deadline: item };
}

export const addDeadline = (root, body) => withDeadlineLock(root, () => addDeadlineUnlocked(root, body));
export const removeDeadline = (root, body) => withDeadlineLock(root, () => removeDeadlineUnlocked(root, body));
export const setDeadlineDone = (root, body) => withDeadlineLock(root, () => setDeadlineDoneUnlocked(root, body));
export const resolveDeadline = (root, body) => withDeadlineLock(root, () => resolveDeadlineUnlocked(root, body));

export function rawStream(root, relative) {
  const full = resolveInside(root, relative);
  if (!full) return null;
  return { stream: () => createReadStream(full), mime: RAW_MIME[extname(full).toLowerCase()] || "application/octet-stream", full };
}

/* ------------------------------------------------------- module files (Converter) */

const MAX_WRITE_BYTES = 4 * 1024 * 1024;

/** The module folder for `<year>/<module>`, or null if it is not one. */
function moduleDir(root, module) {
  if (typeof module !== "string") return null;
  const [year, name, ...rest] = module.split("/");
  if (rest.length || !isYearFolder(year || "") || !name) return null;
  const dir = resolveInside(root, `${year}/${name}`);
  try {
    return dir && statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * A path inside one module that the Converter may touch: Study Hub's writable
 * area (the hub, Revision/, Flashcards/, the materials index and .study-hub/).
 * Downloaded course files are never in it, so they can be read but not changed.
 */
function moduleFilePath(root, module, path) {
  const dir = moduleDir(root, module);
  if (!dir || !isSafeRelativePath(path) || !isWritablePath(path)) return null;
  const full = resolve(dir, ...path.split("/"));
  return full.startsWith(dir + sep) ? full : null;
}

/** Text of a file in a module's writable area, or null when it does not exist. */
export async function readModuleFile(root, module, path) {
  const full = moduleFilePath(root, module, path);
  if (!full) return { error: "That file is outside Study Hub's area of this module." };
  try {
    if (!realpathSync(full).startsWith(realpathSync(moduleDir(root, module)) + sep)) return { error: "That file is outside this module." };
    return { text: await readFile(full, "utf8") };
  } catch {
    return { text: null };
  }
}

/**
 * Removes a generated revision file a later automatic run replaced. Only
 * Revision/ and Flashcards/ files; the caller checked the student left it as written.
 */
export async function removeModuleFile(root, module, path) {
  if (!/^(?:Revision|Flashcards)\//.test(path)) return { error: "Only generated revision files can be removed." };
  const full = moduleFilePath(root, module, path);
  if (!full) return { error: "That file is outside Study Hub's area of this module." };
  try {
    if (!realpathSync(full).startsWith(realpathSync(moduleDir(root, module)) + sep)) return { error: "That file is outside this module." };
    await rm(full);
    return { ok: true };
  } catch {
    return { ok: true }; // Already gone.
  }
}

/** Writes one Converter file. The page decides create vs update; the host only enforces where. */
export async function writeModuleFile(root, module, path, content) {
  const full = moduleFilePath(root, module, path);
  if (!full) return { error: "Study Hub can only write its own files: the hub, Revision, Flashcards and the materials index." };
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_WRITE_BYTES) return { error: "That file is too large." };
  if (path.toLowerCase() === ".study-hub/profile.json") {
    let choice;
    try { choice = JSON.parse(content); } catch { return { error: "Invalid subject profile." }; }
    if (!choice || !Object.hasOwn(PROFILES, choice.profile) ||
        !["student", "suggested"].includes(choice.chosenBy) ||
        typeof choice.at !== "string" || !Number.isFinite(Date.parse(choice.at)) ||
        new Date(choice.at).toISOString() !== choice.at ||
        Object.keys(choice).some((key) => !["profile", "chosenBy", "at"].includes(key)))
      return { error: "Invalid subject profile." };
  }
  let ancestor = full;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realDir = realpathSync(moduleDir(root, module));
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realDir && !realAncestor.startsWith(realDir + sep)) return { error: "That file is outside this module." };
  await mkdir(dirname(full), { recursive: true });
  const temp = `${full}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, full);
  return { ok: true };
}

/* ------------------------------------------------------- the student's own files */

// Kept in step with OWN_FILES_DIR in lib/course-format.ts. Crawler's sync only
// writes files it downloaded and never deletes unknown ones, so this is safe.
const OWN_FILES_DIR = "Course Materials/My Files";
const OWN_NOTES_DIR = `${OWN_FILES_DIR}/Notes`;
const OWN_FILE_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".md", ".txt", ".csv", ".png", ".jpg", ".jpeg", ".gif"]);
export const MAX_OWN_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NAME = 150;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name the student gave, cleaned up, or null when it cannot be one. */
export function ownFileName(name) {
  if (typeof name !== "string") return null;
  const clean = name.trim().replace(/[. ]+$/, "");
  if (!clean || clean.length > MAX_NAME || clean.startsWith(".") || hasControlCharacters(clean)) return null;
  if (/[\\/:*?"<>|]/.test(clean)) return null;
  if (WINDOWS_RESERVED.test(clean.split(".")[0])) return null;
  return clean;
}

/** The real module folder, or null; the same junction check writeModuleFile makes. */
function realModuleDir(root, module) {
  const dir = moduleDir(root, module);
  if (!dir) return null;
  try {
    const real = realpathSync(dir);
    const realRoot = realpathSync(root);
    return real.startsWith(realRoot + sep) ? dir : null;
  } catch {
    return null;
  }
}

/** Makes `<module>/<relativeDir>` and checks it did not resolve outside the module. */
async function ownDir(dir, relativeDir) {
  const full = resolve(dir, ...relativeDir.split("/"));
  await mkdir(full, { recursive: true });
  const realDir = realpathSync(dir);
  const real = realpathSync(full);
  return real.startsWith(realDir + sep) ? full : null;
}

/** `name`, or `name (2)`, `name (3)`… whichever does not exist yet in `dir`. */
function freeName(dir, name) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return null;
}

/**
 * Writes a file the student added (a Buffer, or an async iterable of chunks) to
 * the module's My Files folder. Never overwrites: a clash gets " (2)".
 */
export async function writeOwnFile(root, module, name, body) {
  const dir = realModuleDir(root, module);
  if (!dir) return { error: "That module is not in your library." };
  const clean = ownFileName(name);
  if (!clean) return { error: "That file name cannot be used." };
  if (!OWN_FILE_EXTS.has(extname(clean).toLowerCase())) return { error: "Study Hub cannot open that kind of file." };
  const target = await ownDir(dir, OWN_FILES_DIR);
  if (!target) return { error: "That folder is outside this module." };
  const temp = join(target, `.upload-${randomBytes(6).toString("hex")}.tmp`);
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of Buffer.isBuffer(body) ? [body] : body) {
      size += chunk.length;
      if (size > MAX_OWN_FILE_BYTES) return { error: "That file is larger than 50 MB." };
      chunks.push(chunk);
    }
    await writeFile(temp, Buffer.concat(chunks), { flag: "wx" });
    const final = freeName(target, clean);
    if (!final) return { error: "Too many files with that name." };
    await rename(temp, join(target, final));
    return { ok: true, path: `${OWN_FILES_DIR}/${final}` };
  } finally {
    await rm(temp, { force: true });
  }
}

/** Creates a Markdown note, or updates one when `path` is an existing note under My Files/Notes. */
export async function writeOwnNote(root, body) {
  const { module, title, text, path } = body ?? {};
  const dir = realModuleDir(root, module);
  if (!dir) return { error: "That module is not in your library." };
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_TEXT_BYTES) return { error: "That note is too large." };
  const notes = await ownDir(dir, OWN_NOTES_DIR);
  if (!notes) return { error: "That folder is outside this module." };
  let name;
  if (path !== undefined && path !== null && path !== "") {
    if (typeof path !== "string" || !path.startsWith(`${OWN_NOTES_DIR}/`)) return { error: "Only your own notes can be changed." };
    name = ownFileName(path.slice(OWN_NOTES_DIR.length + 1));
    if (!name || extname(name).toLowerCase() !== ".md" || !existsSync(join(notes, name))) return { error: "That note no longer exists." };
  } else {
    const clean = ownFileName(typeof title === "string" ? title.replace(/[\\/:*?"<>|]/g, "-") : "");
    if (!clean) return { error: "Give the note a title." };
    name = freeName(notes, `${clean.slice(0, MAX_NAME - 8)}.md`);
    if (!name) return { error: "Too many notes with that title." };
  }
  const full = join(notes, name);
  const temp = `${full}.${process.pid}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, full);
  return { ok: true, path: `${OWN_NOTES_DIR}/${name}` };
}

/** Deletes one file the student added; nothing outside My Files. */
export async function removeOwnFile(root, body) {
  const { module, path } = body ?? {};
  const dir = realModuleDir(root, module);
  if (!dir) return { error: "That module is not in your library." };
  if (typeof path !== "string" || !path.startsWith(`${OWN_FILES_DIR}/`) || !isSafeRelativePath(path)) return { error: "Only files you added can be removed." };
  const full = resolveInside(root, `${module}/${path}`);
  if (!full) return { ok: true }; // Already gone (or never there).
  const realOwn = realpathSync(resolve(dir, ...OWN_FILES_DIR.split("/")));
  if (!realpathSync(full).startsWith(realOwn + sep)) return { error: "Only files you added can be removed." };
  if (!statSync(full).isFile()) return { error: "Only files you added can be removed." };
  await rm(full);
  return { ok: true };
}
