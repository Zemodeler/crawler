/** Shared by the crawler and desktop host. All deadline writers use this lock. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rmdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./fs-retry.ts";
import type { Deadline } from "./types.ts";

export async function readDeadlineFile(root: string): Promise<Deadline[]> {
  const path = join(root, "Deadlines.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Cannot read ${path}: invalid JSON. Restore or repair this file before saving deadlines.`); }
  if (!Array.isArray(parsed) || parsed.some((d) =>
    !d || typeof d !== "object" || typeof d.id !== "string" ||
    typeof d.module !== "string" || typeof d.year !== "string" ||
    !Array.isArray(d.sources) || !Array.isArray(d.history))) {
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
export async function writeDeadlineFile(root: string, deadlines: Deadline[]): Promise<void> {
  const target = join(root, "Deadlines.json");
  const temp = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(deadlines, null, 2)}\n`, "utf8");
    await renameWithRetry(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
