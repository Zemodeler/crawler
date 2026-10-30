/**
 * Automatic updates from the project's GitHub releases (Windows installs only).
 *
 *  - asks GitHub for the latest published release a minute after launch and
 *    every 6 hours; drafts and pre-releases are never offered
 *  - downloads that release's installer for this machine in the background
 *    and checks it against the SHA-256 GitHub records for the file; a file
 *    that does not match is deleted, never run
 *  - asks once to restart (a notification when the window is hidden), never
 *    during a sync or a study-pack build; "Later" installs when Study Hub quits
 *  - installs with the same NSIS installer, silently, into the folder this
 *    copy runs from; the installer keeps My Studies and the app data
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The one place updates come from. Never inferred from package metadata. */
export const RELEASE_REPO = "Zemodeler/crawler";
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`;
const LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const API_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const INSTALLER = /^Study-Hub-(\d+\.\d+\.\d+)-win-[a-z0-9]+\.exe$/;

export const MANUAL_UPDATE = `Study Hub updates itself on Windows from ${RELEASES_PAGE}. On this computer it cannot: download the newest installer from that page, quit Study Hub from the tray/menu bar, then run it. Your My Studies library and Study Hub application data are kept.`;

/** Whether release version `latest` is newer than `current` (both x.y.z, an optional leading v). */
export function isNewer(latest, current) {
  const a = VERSION.exec(String(latest));
  const b = VERSION.exec(String(current));
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  return false;
}

/**
 * The update a GitHub "latest release" answer offers this machine, or null:
 * a newer x.y.z release with this platform's installer and its SHA-256.
 */
export function updateFrom(release, { version, arch }) {
  if (!release || release.draft || release.prerelease || !isNewer(release.tag_name, version)) return null;
  const next = VERSION.exec(release.tag_name).slice(1).join(".");
  const name = `Study-Hub-${next}-win-${arch}.exe`;
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => a?.name === name);
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? "")?.[1]?.toLowerCase();
  if (!asset || !sha256 || typeof asset.browser_download_url !== "string" || !asset.browser_download_url.startsWith("https://github.com/")) return null;
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) return null;
  return { version: next, name, url: asset.browser_download_url, size: asset.size, sha256 };
}

export async function checkForUpdate({ fetch = globalThis.fetch, version, arch = process.arch }) {
  const response = await fetch(LATEST_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": `Study-Hub/${version}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  // 404: no published release yet.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return updateFrom(await response.json(), { version, arch });
}

/** SHA-256 of a file on disk, or null if it is not there. */
async function fileSha256(path) {
  const hash = createHash("sha256");
  try {
    await pipeline(createReadStream(path), hash);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

/**
 * Downloads `update` into `dir` and resolves with the installer's path, only
 * once its size and SHA-256 match. A verified earlier download is reused.
 */
export async function downloadUpdate({ fetch = globalThis.fetch, update, dir, version }) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, update.name);
  if ((await fileSha256(target)) === update.sha256) return target;
  const partial = `${target}.part`;
  try {
    const response = await fetch(update.url, { headers: { "user-agent": `Study-Hub/${version}` }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`download answered ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const count = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > update.size) return done(new Error("the download is larger than the release says"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(partial));
    if (bytes !== update.size) throw new Error("the download is incomplete");
    if (hash.digest("hex") !== update.sha256) throw new Error("the download does not match the release checksum");
    await rename(partial, target);
    return target;
  } finally {
    await rm(partial, { force: true }).catch(() => {});
  }
}

/** Installers in `dir` other than `keep`: earlier downloads and ones already installed. */
export async function removeOldInstallers(dir, keep = null) {
  const names = await readdir(dir).catch(() => []);
  for (const name of names)
    if ((INSTALLER.test(name) || INSTALLER.test(name.replace(/\.part$/, ""))) && name !== keep) await rm(join(dir, name), { force: true }).catch(() => {});
}

/**
 * The installer's command line: silent, as an update (keeps app data), into
 * the folder this copy runs from. NSIS reads /D= raw, so it must come last
 * and unquoted: the caller spawns with windowsVerbatimArguments.
 */
export function installArgs(executable, { relaunch }) {
  return ["/S", "--updated", ...(relaunch ? ["--force-run"] : []), `/D=${dirname(executable)}`];
}

export function createUpdater({
  app, dialog, Notification, spawn, fetch = globalThis.fetch,
  window = () => null, busy = () => false, onChange = () => {}, log = console.log,
  platform = process.platform, arch = process.arch,
}) {
  const version = app.getVersion();
  const dir = join(app.getPath("userData"), "updates");
  const enabled = platform === "win32" && app.isPackaged;
  let state = { state: "idle", version: null, error: null };
  let installer = null;
  let asked = null;
  let installing = false;
  let timers = [];
  let checking = null;

  const set = (next) => {
    state = { ...state, ...next };
    onChange(state);
  };

  function install({ relaunch }) {
    if (!installer || installing) return false;
    installing = true;
    log(`Updates: installing Study Hub ${state.version}${relaunch ? " and restarting" : ""}`);
    const child = spawn(installer, installArgs(app.getPath("exe"), { relaunch }), {
      detached: true, stdio: "ignore", windowsVerbatimArguments: true,
    });
    child.unref?.();
    return true;
  }

  /** Restart into the new version now (the installer reopens Study Hub). */
  function restartNow() {
    if (busy()) {
      void dialog.showMessageBox({ type: "info", buttons: ["OK"], message: "Study Hub is busy", detail: "The update installs once the sync or study pack in progress finishes, or when you quit Study Hub." });
      return;
    }
    if (install({ relaunch: true })) app.quit();
  }

  async function ask() {
    if (state.state !== "ready" || asked === state.version || busy()) return;
    asked = state.version;
    const owner = window();
    if (!owner || owner.isDestroyed?.() || !owner.isVisible?.()) {
      if (!Notification?.isSupported?.()) return;
      const note = new Notification({ title: `Study Hub ${state.version} is ready`, body: "Click to restart and update. Otherwise it installs when you quit Study Hub." });
      note.on?.("click", () => restartNow());
      note.show();
      return;
    }
    const { response } = await dialog.showMessageBox(owner, {
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      message: `Study Hub ${state.version} is ready to install.`,
      detail: "Study Hub restarts in a few seconds. Your library and settings are kept. Choose Later to install it when you quit Study Hub.",
    });
    if (response === 0) restartNow();
  }

  async function check({ manual = false } = {}) {
    if (!enabled) {
      if (manual) await dialog.showMessageBox({ type: "info", title: "Update Study Hub", buttons: ["OK"], message: `Study Hub ${version}`, detail: MANUAL_UPDATE });
      return state;
    }
    checking ??= (async () => {
      try {
        if (state.state !== "ready") {
          set({ state: "checking", error: null });
          const update = await checkForUpdate({ fetch, version, arch });
          if (!update) {
            set({ state: "idle", version: null });
            await removeOldInstallers(dir);
          } else {
            set({ state: "downloading", version: update.version });
            log(`Updates: downloading Study Hub ${update.version}`);
            installer = await downloadUpdate({ fetch, update, dir, version });
            await removeOldInstallers(dir, update.name);
            set({ state: "ready" });
            log(`Updates: Study Hub ${update.version} downloaded and verified`);
          }
        }
      } catch (error) {
        installer = null;
        set({ state: "failed", error: error instanceof Error ? error.message : String(error) });
        log(`Updates: ${state.error}`);
      } finally {
        checking = null;
      }
    })();
    await checking;
    if (state.state === "ready") {
      if (manual) asked = null;
      await ask();
    } else if (manual) {
      await dialog.showMessageBox({
        type: state.state === "failed" ? "warning" : "info", buttons: ["OK"],
        message: state.state === "failed" ? "Study Hub could not check for updates." : `Study Hub ${version} is the newest version.`,
        ...(state.state === "failed" ? { detail: `${state.error}. It tries again later; new versions are also at ${RELEASES_PAGE}.` } : {}),
      });
    }
    return state;
  }

  return {
    enabled,
    status: () => state,
    start() {
      if (!enabled) return;
      timers.push(setTimeout(() => void check(), FIRST_CHECK_MS));
      // Also re-asks after a sync that was in the way has finished.
      timers.push(setInterval(() => void (state.state === "ready" ? ask() : check()), CHECK_EVERY_MS));
    },
    stop() {
      timers.forEach((t) => clearTimeout(t));
      timers = [];
    },
    check,
    restartNow,
    /** Asks again about a downloaded update, e.g. once a sync that was in the way has finished. */
    remind: () => ask(),
    /** Called before Study Hub quits: a downloaded update installs then, without reopening. */
    installOnQuit() {
      if (state.state === "ready") install({ relaunch: false });
    },
  };
}
