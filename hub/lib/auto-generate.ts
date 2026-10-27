/**
 * Automatic study packs: the Converter's plan → generate → write, run without
 * the review screens after a sync. The desktop shell opens /auto for each
 * synced module in a hidden window; this file decides whether the module needs
 * a run and does it.
 *
 * The safety rules are the Converter's own: every topic the plan proposes is
 * kept, only Study Hub's writable area is touched, and a file the student
 * edited is never overwritten (writeCourseFile pins it).
 */

import { createHostClient } from "./ai/host.ts";
import type { ProviderId } from "./ai/types.ts";
import { ConversionRun, readManifest } from "./conversion-run.ts";
import { fnv1a, validateCourse } from "./course-format.ts";
import type { LocalFile, Manifest } from "./course-fs.ts";
import { fetchTree, hostModuleHandle, loadModule, moduleCode, setModuleProfile } from "./library.ts";
import { getProfile, inferProfile, PROFILES, type SubjectId } from "./subject-profiles.ts";

/** The lighter model each assistant uses for automatic runs. */
export const AUTO_MODELS: Record<"claude" | "codex" | "gemini", string> = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-6-luna",
  // Empty: the gemini CLI's own default model.
  gemini: "",
};

/** New lecture files alone rebuild a module at most this often. */
export const MIN_REBUILD_DAYS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const LECTURES = /^Course Materials\/(?:Lectures|Transcripts)\//;
/** The student's own files and notes: added on purpose, so they rebuild at once. */
const OWN_FILES = /^Course Materials\/My Files\//;

export type AutoDecision = { run: false; reason: string } | { run: true; reason: string };

export type AutoResult =
  | { status: "skipped"; module: string; reason: string }
  | {
      status: "done";
      module: string;
      reason: string;
      topics: number;
      written: number;
      pinned: number;
      failedTopics: string[];
      /** Unedited files an earlier run wrote that this run replaced under other names. */
      stale: string[];
    }
  | { status: "failed"; module: string; reason: string };

/**
 * Whether a module needs an automatic run: no pack yet, a pack built for a
 * different subject (packs from before subject profiles were law), the
 * student's own files (Course Materials/My Files/) new or changed since the
 * last run, or lecture files new or changed and that run old enough.
 * A changed file is one whose size differs from the last run's fingerprint.
 */
export function needsRun(
  manifest: Manifest | null,
  profile: SubjectId,
  files: (Pick<LocalFile, "path"> & { file?: { size: number } })[],
  now = Date.now(),
): AutoDecision {
  const plan = manifest?.plan as { topics?: unknown[] } | undefined;
  if (!manifest || !plan?.topics?.length) return { run: true, reason: "This module has no study packs yet." };
  const built = manifest.profile ?? "law";
  if (built !== profile)
    return { run: true, reason: `Its packs were built for ${getProfile(built).label}, not ${getProfile(profile).label}.` };
  const seen = new Map(manifest.sourceFingerprints.map((f) => [f.path, f.size]));
  const changed = (f: (typeof files)[number]) =>
    !seen.has(f.path) || (f.file !== undefined && seen.get(f.path) !== f.file.size);
  const own = files.filter((f) => OWN_FILES.test(f.path) && changed(f));
  if (own.length)
    return { run: true, reason: `${count(own.length, "of your own files")} ${own.length === 1 ? "is" : "are"} new or changed since the packs were built.` };
  const fresh = files.filter((f) => LECTURES.test(f.path) && changed(f));
  if (!fresh.length) return { run: false, reason: "Its study packs are up to date." };
  const what = count(fresh.length, "lecture file");
  if (now - manifest.completedAt < MIN_REBUILD_DAYS * DAY_MS)
    return { run: false, reason: `${what} new or changed; packs were rebuilt less than ${MIN_REBUILD_DAYS} days ago.` };
  return { run: true, reason: `${what} new or changed since the packs were built.` };
}

/** "1 lecture file", "2 lecture files"; "1 of your own files" stays plural. */
function count(n: number, noun: string): string {
  return noun.startsWith("of ") ? `${n} ${noun}` : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The saved subject, else the one the module code or title suggests (not the old law files). */
async function subjectFor(moduleKey: string): Promise<SubjectId> {
  const handle = hostModuleHandle(moduleKey);
  try {
    const dir = await handle.getDirectoryHandle(".study-hub");
    const saved = JSON.parse(await (await (await dir.getFileHandle("profile.json")).getFile()).text());
    if (saved && Object.hasOwn(PROFILES, saved.profile)) return saved.profile as SubjectId;
  } catch {
    // No saved choice: suggest one below and save it, so the Converter page agrees.
  }
  const name = moduleKey.split("/").pop()!;
  const suggested = inferProfile(moduleCode(name), name).id;
  await setModuleProfile(moduleKey, suggested, "suggested");
  return suggested;
}

export async function autoGenerate(options: {
  moduleKey: string; // "2026-27/ECS505U - Software Engineering"
  assistant: "claude" | "codex" | "gemini";
  model?: string;
  force?: boolean;
  onLog?: (line: string) => void;
}): Promise<AutoResult> {
  const { moduleKey, assistant } = options;
  const log = options.onLog ?? (() => {});
  const [year, module] = [moduleKey.split("/")[0]!, moduleKey.split("/").slice(1).join("/")];
  try {
    const tree = await fetchTree();
    const files = await loadModule(tree, year, module);
    const handle = hostModuleHandle(moduleKey);
    const manifest = await readManifest(handle);
    const profileId = await subjectFor(moduleKey);
    const decision = options.force ? { run: true, reason: "Asked to rebuild." } : needsRun(manifest, profileId, files);
    if (!decision.run) return { status: "skipped", module: moduleKey, reason: decision.reason };
    log(`${module}: ${decision.reason}`);

    const profile = getProfile(profileId);
    const report = validateCourse(files, { courseName: handle.name, manifestPresent: Boolean(manifest) }, profile);
    const provider: ProviderId = assistant === "claude" ? "anthropic" : assistant === "codex" ? "openai" : "google";
    const client = createHostClient(provider, options.model ?? AUTO_MODELS[assistant], { background: true });
    let lastLine: unknown = null;
    const run = ConversionRun.create(handle.name, "generate", {
      onChange: (s) => {
        // Every patch reports the whole log; pass on only a line not seen yet.
        const last = s.log.at(-1);
        if (last && last !== lastLine) log(`${module}: ${last.text}`);
        lastLine = last ?? null;
      },
    }, { profile: profileId });

    const planned = await run.plan({ client, files, report });
    if (!planned || !planned.plan.topics.length) return { status: "failed", module: moduleKey, reason: "The assistant proposed no topics." };
    const existing = new Map(files.filter((f) => f.text).map((f) => [f.path, f.text!]));
    await run.generate({ client, plan: planned.plan, files, extracts: planned.extracts, existing });
    const failedTopics = run.state.topics.filter((t) => t.status === "failed").map((t) => t.label);
    const { results } = await run.commit({ handle, files, manifest, allowUpdate: true });

    // Files an earlier run wrote, that the student left as written, and that this run did not write again.
    const rewritten = new Set(run.state.staged.map((f) => f.path));
    const current = new Map(files.map((f) => [f.path, f.text]));
    const stale = (manifest?.files ?? [])
      .filter((f) => !rewritten.has(f.path) && /^(?:Revision|Flashcards)\//.test(f.path))
      .filter((f) => {
        const text = current.get(f.path);
        return text !== undefined && fnv1a(text) === f.sha;
      })
      .map((f) => f.path);

    return {
      status: "done",
      module: moduleKey,
      reason: decision.reason,
      topics: planned.plan.topics.length,
      written: results.filter((r) => r.action === "create" || r.action === "update").length,
      pinned: results.filter((r) => r.action === "pinned").length,
      failedTopics,
      stale,
    };
  } catch (error) {
    return { status: "failed", module: moduleKey, reason: (error as Error).message || String(error) };
  }
}
