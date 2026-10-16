/**
 * The library: Study Hub's view of the My Studies folder Crawler fills.
 *
 *   My Studies/
 *     Deadlines.json
 *     2026-27/
 *       ECS505U - Software Engineering/   ← one module (a Study Hub course)
 *
 * Read-only except for one narrow write: resolving a deadline the student has
 * checked (status `user-verified`). Every path from the page is checked to stay
 * inside the root, so a crafted `../` can never reach the rest of the disk.
 */

import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";

// The same rules the Converter applies in the page: one definition, so the
// host can never allow a write the page would refuse, or the reverse.
import { isSafeRelativePath, isWritablePath } from "../lib/course-format.ts";
import { PROFILES } from "../lib/subject-profiles.ts";

const YEAR = /^\d{4}-\d{2}$/;
const TEXT_EXTS = new Set(["md", "txt", "csv"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;

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
  for (const year of top.filter((e) => e.isDirectory() && YEAR.test(e.name)).map((e) => e.name).sort().reverse()) {
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
  try {
    const parsed = JSON.parse(await readFile(join(root, "Deadlines.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The student settles a deadline: either one of its sources' dates, or a date
 * they type. Written back as `user-verified`, which Crawler never overwrites.
 */
export async function resolveDeadline(root, body) {
  const deadlines = await readDeadlines(root);
  const item = deadlines.find((d) => d.id === body?.id);
  if (!item) return { error: "No deadline with that id." };

  let due;
  if (Number.isInteger(body.sourceIndex)) {
    due = item.sources?.[body.sourceIndex]?.date;
    if (!due) return { error: "That source has no date." };
  } else if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(body.date)) {
    const allDay = body.date.length === 10;
    due = { iso: allDay ? body.date : `${body.date}:00`, allDay, tz: "Europe/London" };
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
  const target = join(root, "Deadlines.json");
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(deadlines, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return { deadline: item };
}

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
  if (rest.length || !YEAR.test(year || "") || !name) return null;
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
