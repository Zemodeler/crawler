/**
 * First launch, syncing and Google Calendar, run by the desktop shell with
 * Crawler.
 *
 * The page drives it through the host (`/api/setup/*`): sign in to the
 * university in its own window, then sync My Studies in the background while
 * the page polls for progress. The university token and the Google token are
 * stored encrypted by the OS and never reach the page.
 *
 * A sync also reads documents, announcements and pages for deadlines. With an
 * assistant chosen (Claude or ChatGPT through the student's own subscription)
 * the documents rules flag are read by that CLI too, and every date it finds
 * must pass Crawler's quote check before it reaches the calendar.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ALL_UNIVERSITIES,
  checkLibraryOwner,
  checkLibraryOwnerUnlocked,
  claimLegacyLibrary,
  LEGACY_LIBRARY,
  withLibraryOwner,
  VleError,
  connectCalendar,
  describeFreshness,
  disconnectCalendar,
  getUniversity,
  readState,
  sync,
  syncCalendarFromRoot,
} from "crawler";
import { createCalendarTokenStore, createLoginBrowser, createTokenStore, readGoogleClient } from "crawler/electron";

import { createHostAiRunner } from "./ai-runner.mjs";
import { readSchedule, writeSchedule } from "./background.mjs";
import { formatLibrary } from "../host/auto-format.mjs";

const ASSISTANTS = new Set(["claude", "codex", "gemini"]);

export function createSetup({ app, BrowserWindow, safeStorage, session, shell, dialog, libraryRoot, parent }, dependencies = {}) {
  const userData = app.getPath("userData");
  const tokens = dependencies.tokens ?? createTokenStore({ safeStorage, dir: join(userData, "tokens") });
  const calendarTokens = dependencies.calendarTokens ?? createCalendarTokenStore({ safeStorage, dir: join(userData, "tokens") });
  const loginBrowser = createLoginBrowser({ BrowserWindow, session, parent });
  const universities = ALL_UNIVERSITIES.filter((u) => ["qmul", "surrey"].includes(u.id));
  const selected = () => universities.find((u) => u.id === prefs().university) ?? universities.find((u) => u.id === "qmul");
  const adapterFor = (university) => dependencies.adapter ?? (dependencies.getUniversity ?? getUniversity)(university.id);
  const runSync = dependencies.sync ?? sync;
  const prefsFile = join(userData, "sync-prefs.json");

  let signingIn = false;
  let onSynced = () => {};
  /** One sync at a time; the page polls this. */
  let run = emptyRun("idle");
  let calendarState = { busy: false, lastReport: null, error: null };

  function emptyRun(state) {
    return { state, course: null, coursesDone: 0, newFiles: 0, files: 0, failedCourses: [], error: null, finishedAt: null, summary: null };
  }

  function prefs() {
    try {
      return JSON.parse(readFileSync(prefsFile, "utf8")) || {};
    } catch {
      return {};
    }
  }
  function savePrefs(next) {
    mkdirSync(dirname(prefsFile), { recursive: true });
    writeFileSync(prefsFile, `${JSON.stringify({ ...prefs(), ...next }, null, 2)}\n`);
  }

  function checkLibrary(university) {
    return checkLibraryOwner(libraryRoot(), university.id, adapterFor(university).site);
  }

  async function selectUniversity(body = {}) {
    if (signingIn || run.state === "running") return { error: "Wait for sign-in or sync to finish before switching university." };
    const university = universities.find((u) => u.id === body.university);
    if (!university) return { error: "Choose a supported university." };
    try {
      await checkLibrary(university);
      savePrefs({ university: university.id });
      run = emptyRun("idle");
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  }

  function calendarEnv() {
    return {
      tokens: calendarTokens,
      openBrowser: (url) => shell.openExternal(url),
      ...readGoogleClient({ env: process.env, file: join(userData, "google-oauth.json") }),
    };
  }

  async function status() {
    const university = selected();
    const adapter = adapterFor(university);
    const credentials = await tokens.load(adapter.site);
    const root = libraryRoot();
    const lastSync = (await readState(root)).lastSync;
    const env = calendarEnv();
    let legacyLibrary = false;
    try {
      // Read-only, no lock: the page only needs to know whether to offer the two ways out.
      if (existsSync(join(root, ".crawler"))) await checkLibraryOwnerUnlocked(root, university.id, adapter.site);
    } catch (error) {
      legacyLibrary = error?.code === LEGACY_LIBRARY;
    }
    return {
      university: { id: university.id, name: university.displayName },
      universities: universities.map((u) => ({ id: u.id, name: u.displayName, experimental: u.id === "surrey" })),
      signedIn: Boolean(credentials),
      signingIn,
      sync: run,
      lastSync,
      freshness: describeFreshness(lastSync, new Date()),
      library: { root, legacy: legacyLibrary },
      schedule: await readSchedule(root),
      assistant: prefs().assistant ?? null,
      calendar: {
        configured: Boolean(env.clientId),
        connected: Boolean(await calendarTokens.load()),
        ...calendarState,
      },
    };
  }

  async function signIn() {
    if (run.state === "running") return { error: "Wait for sync to finish before signing in." };
    if (signingIn) return { error: "The sign-in window is already open." };
    signingIn = true;
    const university = selected();
    const adapter = adapterFor(university);
    try {
      await checkLibrary(university);
      const credentials = await adapter.login(loginBrowser);
      await withLibraryOwner(libraryRoot(), adapter, credentials, () => tokens.save(credentials));
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      signingIn = false;
    }
  }

  /**
   * Asked before the first AI read of more than 20 documents in a module, only
   * when the student started the sync (the page or the tray). A sync Study Hub
   * starts on its own never shows a dialog; it reads with rules and asks the
   * next time the student syncs.
   */
  function confirmAiFor(origin, assistant) {
    if (origin !== "page" && origin !== "tray") return async () => false;
    const name = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini" }[assistant];
    return async (documents) => {
      const candidate = typeof parent === "function" ? parent() : parent;
      // A sheet on a hidden window never appears (macOS) and would block the sync.
      const owner = candidate && !candidate.isDestroyed?.() && candidate.isVisible?.() ? candidate : null;
      const options = {
        type: "question",
        buttons: ["Read them", "Not now"],
        defaultId: 0,
        cancelId: 1,
        message: `Look for deadlines in ${documents} documents with ${name}?`,
        detail: `This runs ${name} once per document on your own subscription. Later syncs only send documents that changed. Every date it finds is checked against the document before it reaches your calendar.`,
      };
      const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      return response === 0;
    };
  }

  function summarize(result) {
    const text = result.courses.reduce(
      (sum, c) => ({
        verified: sum.verified + (c.text?.verified ?? 0),
        rejected: sum.rejected + (c.text?.rejected ?? 0),
        aiRuns: sum.aiRuns + (c.text?.aiRuns ?? 0),
        aiMs: sum.aiMs + (c.text?.aiMs ?? 0),
      }),
      { verified: 0, rejected: 0, aiRuns: 0, aiMs: 0 },
    );
    return {
      deadlines: result.deadlines.length,
      conflicts: result.deadlines.filter((d) => d.status === "conflict").length,
      needsCheck: result.deadlines.filter((d) => d.status === "needs-check").length,
      notifications: (result.notifications ?? []).length,
        extractionIssues: result.courses.flatMap((c) => [
          ...(c.extractionIssues ?? []).map((issue) => ({ module: c.shortname, ...issue })),
          ...(c.textError ? [{ module: c.shortname, file: "Module text", reason: "read-failed", message: "Deadline text checking did not finish; earlier evidence was retained." }] : []),
        ]),
      ...text,
    };
  }

  /** Calendar updates run one after another, never side by side (no duplicate events). */
  let calendarQueue = Promise.resolve();
  function syncCalendarAfter(root) {
    const next = calendarQueue.then(async () => {
      try {
        if (!(await calendarTokens.load())) return;
        calendarState = { ...calendarState, busy: true, error: null };
        const report = await syncCalendarFromRoot(root, calendarEnv());
        calendarState = { busy: false, lastReport: report ? { ...report, at: new Date().toISOString() } : calendarState.lastReport, error: null };
      } catch (error) {
        calendarState = { ...calendarState, busy: false, error: calendarMessage(error) };
      }
    });
    calendarQueue = next.catch(() => {});
    return next;
  }

  /** The page's "Sync now": `assistant` is the student's current choice, remembered for later syncs. */
  async function startSync(body = {}) {
    if (ASSISTANTS.has(body.assistant)) savePrefs({ assistant: body.assistant });
    else if (body.assistant === "none") savePrefs({ assistant: null });
    return begin("page");
  }

  /** A sync Study Hub starts itself ("schedule", "first") or from the tray ("tray"). */
  function startBackgroundSync(origin) {
    return begin(origin);
  }

  /**
   * A sync Study Hub or the tray started has no page waiting for its answer, so
   * a refusal is kept as a failed run (the sidebar shows it) and logged.
   */
  async function begin(origin) {
    const result = await tryBegin(origin);
    if (result.error && origin !== "page") {
      console.error(`Sync (${origin}): ${result.error}`);
      run = { ...emptyRun("failed"), error: result.error, code: result.code ?? null, finishedAt: new Date().toISOString() };
    }
    return result;
  }

  async function tryBegin(origin) {
    if (signingIn) return { error: "Wait for sign-in to finish before syncing." };
    if (run.state === "running") return { ok: true };
    const university = selected();
    const adapter = adapterFor(university);
    const previous = run;
    run = emptyRun("running"); // claimed before any await, so two callers cannot both start
    let credentials;
    let assistant;
    let root;
    try {
      credentials = await tokens.load(adapter.site);
      assistant = prefs().assistant ?? null;
      root = libraryRoot();
      await checkLibrary(university);
    } catch (error) {
      run = previous;
      return { error: error instanceof Error ? error.message : String(error), ...(error?.code === LEGACY_LIBRARY ? { code: LEGACY_LIBRARY } : {}) };
    }
    if (!credentials) {
      run = previous;
      return { error: `Sign in to ${university.displayName} first.` };
    }

    try {
      await withLibraryOwner(root, adapter, credentials, async () => {});
    } catch (error) {
      run = previous;
      return { error: error.message, ...(error?.code === LEGACY_LIBRARY ? { code: LEGACY_LIBRARY } : {}) };
    }
    Promise.resolve().then(() => runSync({
      adapter,
      credentials,
      root,
      ...(assistant ? { ai: createHostAiRunner(assistant), confirmAi: confirmAiFor(origin, assistant) } : {}),
      onProgress(event) {
        if (event.type === "course-start") run.course = event.course;
        else if (event.type === "course-done") run.coursesDone++;
        else if (event.type === "course-failed") {
          run.coursesDone++;
          run.failedCourses.push(event.course);
        } else if (event.type === "file") {
          run.files++;
          if (event.result === "new") run.newFiles++;
        }
      },
    }))
      .then(async (result) => {
        try {
          await formatLibrary(root, result.courses.filter((c) => c.status === "synced").map((c) => c.folder));
        } catch (error) {
          console.error(`Study Hub materials index: ${error.message}`);
        }
        run = { ...run, state: "done", course: null, finishedAt: new Date().toISOString(), summary: summarize(result) };
        try {
          onSynced(result);
        } catch (error) {
          console.error(`After sync: ${error.message}`);
        }
        await syncCalendarAfter(root);
      })
      .catch(async (error) => {
        const expired = error instanceof VleError && error.code === "invalid_token";
        if (expired) await tokens.clear(adapter.site);
        run = {
          ...run,
          state: "failed",
          course: null,
          error: expired ? "Your sign-in has expired. Sign in again to sync." : error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        };
      });
    return { ok: true };
  }

  function libraryBusy() {
    if (signingIn) return "Wait for sign-in to finish first.";
    if (run.state === "running") return "Wait for the sync to finish first.";
    if (api.packsStatus?.().state === "running") return "Wait for the study packs being built to finish first.";
    return null;
  }

  /**
   * Option 2 for a library from before ownership records: the signed-in
   * account claims it as it is, after the university confirms who is signed in.
   */
  async function claimLibrary() {
    const busy = libraryBusy();
    if (busy) return { error: busy };
    const university = selected();
    const adapter = adapterFor(university);
    const credentials = await tokens.load(adapter.site);
    if (!credentials) return { error: `Sign in to ${university.displayName} first.` };
    try {
      await claimLegacyLibrary(libraryRoot(), adapter, credentials);
      run = emptyRun("idle");
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Option 1: keep the old library untouched as "My Studies (backup <date>)"
   * beside it and start again in an empty folder, which the next sync claims.
   */
  async function freshLibrary() {
    const busy = libraryBusy();
    if (busy) return { error: busy };
    const root = libraryRoot();
    const date = new Date().toISOString().slice(0, 10);
    let backup = `${root} (backup ${date})`;
    for (let n = 2; existsSync(backup); n++) backup = `${root} (backup ${date} ${n})`;
    try {
      if (existsSync(root)) await rename(root, backup);
      await mkdir(root, { recursive: true });
    } catch (error) {
      const locked = ["EBUSY", "EPERM", "EACCES"].includes(error?.code);
      return {
        error: locked
          ? "Windows would not move the library: a file in it is open. Close it (or the folder in Explorer) and try again."
          : `Could not start a new library: ${error.message}`,
      };
    }
    run = emptyRun("idle");
    return { ok: true, backup };
  }

  async function setSchedule(body = {}) {
    try {
      await writeSchedule(libraryRoot(), Number(body.everyDays));
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  }

  async function calendarConnect() {
    if (calendarState.busy) return { error: "Google Calendar is busy; try again in a moment." };
    calendarState = { ...calendarState, busy: true, error: null };
    try {
      await connectCalendar(calendarEnv());
      calendarState = { ...calendarState, busy: false };
      await syncCalendarAfter(libraryRoot());
      return { ok: true };
    } catch (error) {
      calendarState = { ...calendarState, busy: false, error: calendarMessage(error) };
      return { error: calendarState.error };
    }
  }

  async function calendarSync() {
    if (!(await calendarTokens.load())) return { error: "Connect Google Calendar first." };
    await syncCalendarAfter(libraryRoot());
    return calendarState.error ? { error: calendarState.error } : { ok: true, report: calendarState.lastReport };
  }

  async function calendarDisconnect() {
    await disconnectCalendar(calendarEnv());
    calendarState = { busy: false, lastReport: null, error: null };
    return { ok: true };
  }

  // main.mjs adds packsStatus/packsRebuild once the pack queue exists.
  const api = {
    status,
    selectUniversity,
    signIn,
    startSync,
    startBackgroundSync,
    claimLibrary,
    freshLibrary,
    setSchedule,
    calendarConnect,
    calendarSync,
    calendarDisconnect,
    prefs,
    set onSynced(callback) {
      onSynced = callback;
    },
  };
  return api;
}

function calendarMessage(error) {
  if (error?.name === "GoogleAuthError" && error.code === "revoked") return "Google Calendar access was revoked. Connect it again.";
  if (error?.name === "GoogleAuthError" && error.code === "denied") return "Google Calendar access was not granted.";
  return error instanceof Error ? error.message : String(error);
}
