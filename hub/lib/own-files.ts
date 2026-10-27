/**
 * The student's own files and notes in a module (Course Materials/My Files),
 * written through Study Hub's host. `module` is "year/module".
 */

const GUARD = { "x-study-hub-host": "1" };

export type OwnFileResult = { ok: true; path: string };

async function call<T>(path: string, init: RequestInit = {}, contentType = "application/json"): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...GUARD, ...(init.body ? { "content-type": contentType } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Study Hub could not save to your library (${response.status}).`);
  return body as T;
}

export const uploadOwnFile = (module: string, file: File) =>
  call<OwnFileResult>(
    `/api/library/own-file?${new URLSearchParams({ module, name: file.name })}`,
    { method: "POST", body: file },
    "application/octet-stream",
  );

export const saveOwnNote = (module: string, note: { title: string; text: string; path?: string }) =>
  call<OwnFileResult>("/api/library/own-note", { method: "PUT", body: JSON.stringify({ module, ...note }) });

export const removeOwnFile = (module: string, path: string) =>
  call<{ ok: true }>("/api/library/own-file/remove", { method: "POST", body: JSON.stringify({ module, path }) });
