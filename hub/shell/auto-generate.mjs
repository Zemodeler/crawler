/**
 * Automatic study packs after a sync. Each synced module opens /auto in a
 * hidden window, one module at a time, with the student's assistant on its
 * lighter model (claude-sonnet-5-5 or gpt-6-luna). The page decides whether the
 * module needs a run; this file waits for it, removes the files a run replaced
 * under new names, and tells the student what was built.
 *
 * Turned off with `autoGenerate: false` in sync-prefs.json; the model can be
 * changed there with `autoModel`.
 */

import { removeModuleFile } from "../host/library.mjs";

const POLL_MS = 3000;
/** A module with many topics takes long on a light model; past this it is abandoned. */
const MODULE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export function createAutoGenerator({ BrowserWindow, Notification, hostUrl, libraryRoot, prefs, log = console.log }) {
  let queue = Promise.resolve();
  let status = { state: "idle", module: null, results: [] };

  async function runOne(moduleKey, assistant, model, force = false) {
    const params = new URLSearchParams({ module: moduleKey, assistant, ...(model ? { model } : {}), ...(force ? { force: "1" } : {}) });
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    const started = Date.now();
    let seen = 0;
    try {
      await window.loadURL(`${hostUrl()}auto?${params}`);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (window.isDestroyed()) return { status: "failed", module: moduleKey, reason: "The window closed." };
        const state = await window.webContents.executeJavaScript("window.__studyHubAuto ? JSON.stringify(window.__studyHubAuto) : null");
        if (state) {
          const parsed = JSON.parse(state);
          for (const line of parsed.log.slice(seen)) log(`Study packs: ${line}`);
          seen = parsed.log.length;
          if (parsed.result) return parsed.result;
        }
        if (Date.now() - started > MODULE_TIMEOUT_MS) return { status: "failed", module: moduleKey, reason: "Took longer than 3 hours." };
      }
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async function runAll(folders, force = false) {
    const settings = prefs();
    const assistant = settings.assistant;
    if (settings.autoGenerate === false || !["claude", "codex", "gemini"].includes(assistant)) return [];
    const model = typeof settings.autoModel === "string" && settings.autoModel ? settings.autoModel : "";
    const results = [];
    status = { state: "running", module: null, results };
    for (const moduleKey of folders) {
      status.module = moduleKey;
      const result = await runOne(moduleKey, assistant, model, force).catch((error) => ({ status: "failed", module: moduleKey, reason: error.message }));
      if (result.status === "done") {
        for (const path of result.stale ?? []) await removeModuleFile(libraryRoot(), moduleKey, path);
      }
      log(`Study packs: ${moduleKey} ${result.status} — ${result.reason}`);
      results.push(result);
      tell(result);
    }
    status = { state: "idle", module: null, results };
    return results;
  }

  function tell(result) {
    if (result.status === "skipped" || !Notification?.isSupported?.()) return;
    const name = result.module.split("/").pop();
    const body = result.status === "done"
      ? `${result.topics} topic${result.topics === 1 ? "" : "s"} with flashcards.${result.failedTopics.length ? ` ${result.failedTopics.length} topic(s) failed; open the Converter to retry.` : ""}`
      : `Could not build study packs: ${result.reason}`;
    new Notification({ title: result.status === "done" ? `Study packs ready: ${name}` : `Study packs: ${name}`, body }).show();
  }

  return {
    /** Queues a run over these "year/module" folders after any run already going. */
    afterSync(folders) {
      queue = queue.then(() => runAll(folders)).catch((error) => log(`Study packs: ${error.message}`));
      return queue;
    },
    /** Queues a forced rebuild of one "year/module": the assistant redoes its packs even when they are up to date. */
    rebuild(moduleKey) {
      queue = queue.then(() => runAll([moduleKey], true)).catch((error) => log(`Study packs: ${error.message}`));
      return queue;
    },
    status: () => status,
  };
}
