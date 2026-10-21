/** Shared by the crawler and desktop host. All deadline writers use this lock. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rmdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./fs-retry.ts";
import type { Deadline } from "./types.ts";

/** Optional, per-call file operations let failure tests exercise the real transaction path. */
export type DeadlineFileOps = {
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  writeFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options: { force: true }) => Promise<void>;
};

const fileOps: DeadlineFileOps = { readFile, writeFile, rename: renameWithRetry, rm };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value: unknown) => object(value) && typeof value.iso === "string" && Number.isFinite(Date.parse(value.iso)) && typeof value.allDay === "boolean" && value.tz === "Europe/London";
const source = (value: unknown) => object(value) && ["vle-field", "document", "announcement", "page"].includes(value.type as string) &&
  ["structured", "quoted"].includes(value.strength as string) && typeof value.url === "string" &&
  typeof value.quote === "string" && (value.date === null || instant(value.date)) && typeof value.seenAt === "string" &&
  (value.localPath === undefined || typeof value.localPath === "string") &&
  (value.page === undefined || (Number.isInteger(value.page) && (value.page as number) >= 0)) &&
  (value.line === undefined || (Number.isInteger(value.line) && (value.line as number) >= 0)) &&
  (value.origin === undefined || value.origin === "rule" || value.origin === "ai");
const change = (value: unknown) => object(value) && typeof value.at === "string" &&
  ["due", "status", "title", "weight", "removed", "added"].includes(value.field as string) &&
  (value.from === null || typeof value.from === "string") && (value.to === null || typeof value.to === "string") &&
  (value.source === undefined || source(value.source));
const deadline = (value: unknown) => object(value) &&
  typeof value.id === "string" && typeof value.module === "string" && typeof value.year === "string" && typeof value.title === "string" &&
  ["coursework", "exam", "quiz", "presentation", "lab", "other"].includes(value.kind as string) &&
  ["confirmed", "conflict", "tbc", "needs-check", "user-verified", "cancelled"].includes(value.status as string) &&
  (value.due === null || instant(value.due)) &&
  (value.window === undefined || (object(value.window) && instant(value.window.from) && instant(value.window.to))) &&
  (value.weight === undefined || (typeof value.weight === "number" && Number.isFinite(value.weight))) &&
  (value.formative === undefined || typeof value.formative === "boolean") &&
  (value.checkReason === undefined || typeof value.checkReason === "string") &&
  (value.submitUrl === undefined || typeof value.submitUrl === "string") &&
  (value.userNote === undefined || typeof value.userNote === "string") &&
  (value.done === undefined || typeof value.done === "boolean") &&
  Array.isArray(value.sources) && value.sources.every(source) && Array.isArray(value.history) && value.history.every(change);

export async function readDeadlineFile(root: string, io: Partial<DeadlineFileOps> = {}): Promise<Deadline[]> {
  const path = join(root, "Deadlines.json");
  let text: string;
  try {
    text = await (io.readFile ?? fileOps.readFile)(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Cannot read ${path}: invalid JSON. Restore or repair this file before saving deadlines.`); }
  if (!Array.isArray(parsed) || parsed.some((d) => !deadline(d)) ||
    new Set(parsed.map((d) => d.id)).size !== parsed.length) {
    throw new Error(`Cannot read ${path}: invalid deadline records. Restore or repair this file before saving deadlines.`);
  }
  return parsed as Deadline[];
}

/** A directory lock also coordinates separate CLI and desktop processes.
 * Never steal a lock by age: a slow live process may still own it.
 */
export async function withDeadlineLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  return withDirectoryLock(root, "deadlines", 10_000, work);
}

/** Exclude overlapping full syncs before either touches manifests or temp files. */
export async function withSyncLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  return withDirectoryLock(root, "sync", 0, work);
}

async function withDirectoryLock<T>(root: string, name: string, waitMs: number, work: () => Promise<T>): Promise<T> {
  const state = join(root, ".crawler");
  const lock = join(state, `${name}.lock`);
  await mkdir(state, { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= until) {
        throw new Error(`${name === "sync" ? "A sync is already running" : "Deadlines are busy"} (${lock}). Retry after the other writer finishes. If an app crashed, close all Crawler and Study Hub processes before removing this lock directory.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await work(); }
  finally { await rmdir(lock); }
}

/** Caller must hold withDeadlineLock across its read, mutation, and write. */
export async function writeDeadlineFile(root: string, deadlines: Deadline[], io: Partial<DeadlineFileOps> = {}): Promise<void> {
  const target = join(root, "Deadlines.json");
  const temp = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await (io.writeFile ?? fileOps.writeFile)(temp, `${JSON.stringify(deadlines, null, 2)}\n`, "utf8");
    await (io.rename ?? fileOps.rename)(temp, target);
  } finally {
    await (io.rm ?? fileOps.rm)(temp, { force: true });
  }
}
