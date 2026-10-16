/**
 * Browser filesystem and storage access for Study Hub.
 *
 * One definition of the File System Access handle types (the reader, the
 * flashcard app and the writer all shared three slightly different copies
 * before), one IndexedDB schema, and the create-only writer.
 *
 * The folder is always *opened* read-only. Write access is escalated lazily,
 * inside the click that asks for it, so "read-only, stays on your device"
 * remains literally true for anyone who never asks Study Hub to write.
 */

import {
  SUPPORTED_EXTS,
  TEXT_EXTS,
  inferCategory,
  isSafeRelativePath,
  isWritablePath,
  topicLabel,
  type Category,
} from "./course-format.ts";
import type { SubjectId } from "./subject-profiles.ts";

export type FsMode = "read" | "readwrite";

export type DirectoryHandle = FileSystemHandle & {
  kind: "directory";
  values(): AsyncIterableIterator<FileSystemHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<WritableFileHandle>;
  queryPermission?(opts: { mode: FsMode }): Promise<PermissionState>;
  requestPermission?(opts: { mode: FsMode }): Promise<PermissionState>;
};

export type WritableFileHandle = FileSystemFileHandle & {
  createWritable?(opts?: { keepExistingData?: boolean }): Promise<{
    write(data: string | BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
};

export type LocalFile = {
  path: string;
  name: string;
  ext: string;
  file: File;
  text?: string;
  category: Category;
  topic: string;
  /** Set for files served by the host library; open these by URL, not by blob. */
  url?: string;
};

/* ------------------------------------------------------------------- reading */

/** Recursive inventory. Skips dotfiles (so `.study-hub/` stays invisible) and node_modules. */
export async function collectDirectory(
  handle: DirectoryHandle,
  prefix = "",
): Promise<LocalFile[]> {
  const output: LocalFile[] = [];
  for await (const entry of handle.values()) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory")
      output.push(...(await collectDirectory(entry as DirectoryHandle, path)));
    else {
      const file = await (entry as FileSystemFileHandle).getFile();
      const ext = entry.name.split(".").pop()?.toLowerCase() || "";
      if (!SUPPORTED_EXTS.has(ext)) continue;
      const text = TEXT_EXTS.has(ext) ? await file.text() : undefined;
      output.push({
        path,
        name: entry.name,
        ext,
        file,
        text,
        category: inferCategory(path, ext),
        topic: topicLabel(path),
      });
    }
  }
  return output;
}

/** True when this folder has been converted before. Read separately because
 *  `collectDirectory` deliberately cannot see dot-directories. */
export async function readManifest(handle: DirectoryHandle): Promise<Manifest | null> {
  try {
    const dir = await handle.getDirectoryHandle(".study-hub");
    const fileHandle = await dir.getFileHandle("manifest.json");
    const text = await (await fileHandle.getFile()).text();
    return JSON.parse(text) as Manifest;
  } catch {
    return null;
  }
}

export type ManifestFile = {
  path: string;
  sha: string;
  bytes: number;
  generator: "code" | "ai";
  topicKey?: string;
  degraded?: boolean;
};

export type Manifest = {
  specVersion: number;
  runId: string;
  completedAt: number;
  provider?: string;
  model?: string;
  plan?: unknown;
  /** The subject profile the run used; absent in manifests written before profiles. */
  profile?: SubjectId;
  files: ManifestFile[];
  sourceFingerprints: { path: string; size: number }[];
};

/* ------------------------------------------------------------- permissions */

export async function hasPermission(handle: DirectoryHandle, mode: FsMode): Promise<boolean> {
  if (!handle.queryPermission) return true;
  return (await handle.queryPermission({ mode })) === "granted";
}

/**
 * Escalate read to readwrite. MUST be called synchronously inside a user
 * gesture (a click handler) or Chrome rejects it without prompting.
 */
export async function ensureReadWrite(handle: DirectoryHandle): Promise<boolean> {
  if (await hasPermission(handle, "readwrite")) return true;
  if (!handle.requestPermission) return false;
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- writing */

export type WriteAction = "create" | "update" | "skip" | "pinned" | "rejected";

export type WriteResult = {
  path: string;
  action: WriteAction;
  bytes: number;
  reason?: string;
};

/** Walks (and optionally creates) the directory chain for a relative path. */
async function dirFor(
  root: DirectoryHandle,
  path: string,
  create: boolean,
): Promise<DirectoryHandle> {
  const segments = path.split("/").slice(0, -1);
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
  return dir;
}

async function existingText(root: DirectoryHandle, path: string): Promise<string | null> {
  try {
    const dir = await dirFor(root, path, false);
    const handle = await dir.getFileHandle(path.split("/").pop()!);
    return await (await handle.getFile()).text();
  } catch {
    return null;
  }
}

/**
 * Write one file. Create-only unless the caller explicitly allows an update,
 * and an update is only ever allowed when the on-disk bytes still match what
 * Study Hub last wrote — if the user has edited the file, it is pinned and left
 * completely alone.
 */
export async function writeCourseFile(
  root: DirectoryHandle,
  path: string,
  content: string,
  options: { allowUpdate?: boolean; expectedSha?: string; shaOf?: (text: string) => string } = {},
): Promise<WriteResult> {
  const bytes = new TextEncoder().encode(content).length;
  if (!isSafeRelativePath(path))
    return { path, action: "rejected", bytes: 0, reason: "unsafe path" };
  if (!isWritablePath(path))
    return { path, action: "rejected", bytes: 0, reason: "path is outside the writable area" };

  const current = await existingText(root, path);
  if (current !== null) {
    if (current === content) return { path, action: "skip", bytes, reason: "already identical" };
    const sha = options.shaOf?.(current);
    const managed = options.expectedSha !== undefined && sha === options.expectedSha;
    if (!options.allowUpdate || !managed)
      return {
        path,
        action: "pinned",
        bytes,
        reason: managed ? "updates not requested" : "you edited this file",
      };
  }

  const dir = await dirFor(root, path, true);
  const handle = await dir.getFileHandle(path.split("/").pop()!, { create: true });
  if (!handle.createWritable) throw new Error("This browser cannot write files.");
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
  return { path, action: current === null ? "create" : "update", bytes };
}

/* ------------------------------------------------------------- IndexedDB v3 */

const DB_NAME = "study-hub";
const DB_VERSION = 3;
/** v2 stored only folder handles; v3 adds AI keys, run state, staged files and
 *  extracted source text. The upgrade is additive so remembered folders survive. */
export const STORES = ["handles", "secrets", "runs", "staged", "extracts"] as const;

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const store of STORES)
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Captures the result in the request's own `onsuccess` and resolves only once
 * the transaction completes — never reads `.result` from another request's
 * callback, which is the trap that broke `loadHandles`.
 */
function tx<T>(
  store: (typeof STORES)[number],
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        let value: T | undefined;
        if (request) request.onsuccess = () => (value = request.result);
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

export const idbGet = <T>(store: (typeof STORES)[number], key: string) =>
  tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>);
export const idbPut = (store: (typeof STORES)[number], key: string, value: unknown) =>
  tx(store, "readwrite", (s) => void s.put(value, key));
export const idbDelete = (store: (typeof STORES)[number], key: string) =>
  tx(store, "readwrite", (s) => void s.delete(key));
export const idbKeys = (store: (typeof STORES)[number]) =>
  tx<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>);

export async function saveHandle(handle: DirectoryHandle) {
  const db = await openDB();
  const transaction = db.transaction("handles", "readwrite");
  transaction.objectStore("handles").put(handle, `course:${handle.name}`);
  transaction.objectStore("handles").put(handle.name, "active");
}

/**
 * Both requests must finish before either result is read.
 *
 * IndexedDB fires success events in the order the requests were issued, so
 * reading the second request's `.result` from the first one's `onsuccess`
 * throws InvalidStateError — inside an event handler, where it neither rejects
 * the promise nor surfaces anywhere useful. The promise simply never settles
 * and the remembered folder silently never reloads. Waiting for the
 * transaction to complete is the fix.
 */
export async function loadHandles(): Promise<{ active?: string; handles: DirectoryHandle[] }> {
  const db = await openDB();
  return new Promise((resolve) => {
    const transaction = db.transaction("handles");
    const store = transaction.objectStore("handles");
    const allRequest = store.getAll();
    const activeRequest = store.get("active");
    let all: unknown[] = [];
    let active: string | undefined;
    allRequest.onsuccess = () => {
      all = allRequest.result || [];
    };
    activeRequest.onsuccess = () => {
      active = activeRequest.result;
    };
    transaction.oncomplete = () =>
      resolve({
        active,
        handles: all.filter((entry): entry is DirectoryHandle => (entry as DirectoryHandle)?.kind === "directory"),
      });
    transaction.onerror = () => resolve({ handles: [] });
    transaction.onabort = () => resolve({ handles: [] });
  });
}

/** True in Chromium, false in Firefox and Safari, which have no directory picker. */
export function supportsFolderAccess(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
