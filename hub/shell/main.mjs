/**
 * Study Hub desktop shell (spike).
 *
 * Starts the host in this process and opens it in an app window. No helper,
 * no pairing, no folder of its own to start: one double-click.
 *
 *   electron shell/main.mjs              open Study Hub
 *   electron shell/main.mjs --selftest   drive the AI settings page headlessly:
 *                                        choose "My subscription", press
 *                                        "Test connection", report and quit
 *   electron shell/main.mjs --sync       open Study Hub and sync every module now
 */

import { app, BrowserWindow, Menu, MenuItem, Notification, Tray, dialog, nativeImage, safeStorage, session, shell } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHost } from "../host/index.mjs";
import { libraryRoot } from "../host/library.mjs";
import { formatLibrary } from "../host/auto-format.mjs";
import { LOGIN_ITEM, createBackground } from "./background.mjs";
import { createSetup } from "./setup.mjs";
import { createAutoGenerator } from "./auto-generate.mjs";
import { listLibrary } from "../host/library.mjs";
import { showUpdateInstructions } from "./updates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELFTEST = process.argv.includes("--selftest");
const providerArg = process.argv.find((arg) => arg.startsWith("--provider="));
const PROVIDER = providerArg ? providerArg.slice(11) : "anthropic";
// Started at login: stay in the tray until the student opens the window.
const BACKGROUND_FLAG = process.argv.includes("--background");
const SYNC_FLAG = process.argv.includes("--sync");

// Names the userData folder, where the encrypted university sign-in is kept.
app.setName("Study Hub");
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let hostUrl = null;
let quitting = false;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: "Study Hub",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links off the host open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: target.startsWith(url) ? "allow" : "deny" };
  });
  // Closing the window keeps Study Hub in the tray, so scheduled syncs and
  // reminders keep running; "Quit Study Hub" in the tray menu really quits.
  mainWindow.on("close", (event) => {
    if (!quitting && !SELFTEST) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
  return mainWindow;
}

async function selftest(window, url) {
  const js = (code) => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js(code)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  await window.loadURL(`${url}connect`);
  await js(`localStorage.setItem("studyhub:ai:settings", JSON.stringify({provider:${JSON.stringify(PROVIDER)},transport:"subscription",model:"",remember:false})); true`);
  await window.loadURL(`${url}connect`);

  const hosted = await js(`document.cookie.includes("studyhub_host=1")`);
  const sessionReadable = await js(`document.cookie.includes("studyhub_session")`);
  const builtIn = await waitFor(`document.body.innerText.includes("Built in")`, 15_000);
  // "Check again" makes the host search for the CLI afresh; it must come back found.
  const recheckButton = `[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Check again")`;
  await waitFor(`Boolean(${recheckButton}) && !${recheckButton}.disabled`, 15_000);
  await js(`${recheckButton}.click(); true`);
  const recheckStarted = await waitFor(`${recheckButton}.disabled`, 2_000);
  const recheckFound =
    (await waitFor(`!${recheckButton}.disabled`, 60_000)) &&
    (await js(`[...document.querySelectorAll(".badge-ok")].some(b => / found$/.test(b.textContent.trim()))`));
  const enabled = await waitFor(
    `[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Test connection" && !b.disabled)`,
    20_000,
  );
  if (enabled)
    await js(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Test connection").click(); true`);
  const connected = enabled && (await waitFor(`document.body.innerText.includes("Connected")`, 60_000));
  const pairingShown = await js(`document.body.innerText.includes("Pairing code")`);
  // There is no bridge any more, so the page should never mention one.
  const bridgeWording = await js(
    `(document.body.innerText.match(/[^.\\n]*(bridge|local helper|pairing)[^.\\n]*/gi) || []).slice(0, 5)`,
  );
  const pressed = await js(
    `[...document.querySelectorAll("button.choice[aria-pressed=true] b")].map(b => b.textContent).join(" + ")`,
  );
  // A hidden window may hold a stale frame; scroll the result into view and
  // let it repaint before capturing.
  await js(`window.scrollTo(0, document.body.scrollHeight); true`);
  window.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 500));

  const outDir = join(HERE, "..", "outputs");
  mkdirSync(outDir, { recursive: true });
  const image = await window.webContents.capturePage();
  const shot = join(outDir, `selftest-${PROVIDER}.png`);
  (await import("node:fs")).writeFileSync(shot, image.toPNG());

  const result = {
    provider: PROVIDER, hosted, sessionReadable, builtIn, recheckStarted, recheckFound, enabled, connected, pairingShown, bridgeWording, pressed, screenshot: shot,
  };
  console.log(`SELFTEST ${JSON.stringify(result)}`);
  return hosted && !sessionReadable && builtIn && recheckFound && connected && !pairingShown && bridgeWording.length === 0;
}

/** Shows the window on `path` (relative to the site), creating it if needed. */
function openPage(path) {
  if (!hostUrl) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow(hostUrl);
  mainWindow.loadURL(`${hostUrl}${path}`);
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(async () => {
  const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]);
  menu.append(new MenuItem({ label: "Updates", submenu: [
    { label: "Update instructions…", click: () => void showUpdateInstructions({ dialog, version: app.getVersion() }) },
  ] }));
  Menu.setApplicationMenu(menu);
  let host;
  let setup;
  try {
    await formatLibrary(libraryRoot()).catch((error) => console.error(`Study Hub materials index: ${error.message}`));
    setup = createSetup({ app, BrowserWindow, safeStorage, session, shell, dialog, libraryRoot, parent: () => mainWindow });
    host = await startHost({ setup });
  } catch (error) {
    console.error(`Could not start Study Hub: ${error.message}`);
    app.exit(1);
    return;
  }
  for (const [name, cli] of Object.entries(host.clis))
    console.log(`  ${cli.path ? "found  " : "missing"}  ${name}${cli.version ? `  ${cli.version}` : ""}`);
  console.log(`  Study Hub: ${host.url}`);

  hostUrl = host.url;
  const window = createWindow(host.url);
  if (SELFTEST) {
    const ok = await selftest(window, host.url).catch((error) => {
      console.error(error);
      return false;
    });
    host.server.close();
    app.exit(ok ? 0 : 1);
    return;
  }
  const background = createBackground({
    app, Notification, Tray, Menu, nativeImage,
    iconPath: join(HERE, "..", "public", "icon.png"),
    setup, libraryRoot, openPage,
  });
  const packLog = join(app.getPath("userData"), "study-packs.log");
  const packs = createAutoGenerator({
    BrowserWindow, Notification, hostUrl: () => hostUrl, libraryRoot, prefs: setup.prefs,
    log: (line) => {
      console.log(line);
      try {
        appendFileSync(packLog, `${new Date().toISOString()} ${line}\n`);
      } catch { /* The log is a convenience. */ }
    },
  });
  setup.packsStatus = () => ({ state: packs.status().state, module: packs.status().module });
  // Every module of the newest year: the ones the startup run covers.
  const newestModules = async () => {
    const tree = await listLibrary(libraryRoot());
    const year = tree.years[0]?.year; // newest first
    return year ? tree.years[0].modules.map((m) => `${year}/${m}`) : [];
  };
  setup.packsRebuild = async ({ module, all }) => {
    if (all !== true && (typeof module !== "string" || !module.includes("/"))) return { error: "No module given." };
    if (setup.prefs().autoGenerate === false || !["claude", "codex", "gemini"].includes(setup.prefs().assistant))
      return { error: "Choose “My subscription” in AI settings first, so Study Hub can use your assistant." };
    if (all === true) {
      const modules = await newestModules();
      if (!modules.length) return { error: "There are no modules to rebuild yet." };
      void packs.rebuildAll(modules);
    } else void packs.rebuild(module);
    return { ok: true };
  };
  setup.onSynced = (result) => {
    background.onSynced(result);
    void packs.afterSync(result.courses.filter((c) => c.status === "synced").map((c) => c.folder));
  };
  background.start();
  if (SYNC_FLAG) void setup.startBackgroundSync("tray");
  // Modules synced before automatic packs existed get theirs now; up-to-date ones are skipped.
  newestModules()
    .then((modules) => (modules.length ? packs.afterSync(modules) : []))
    .catch((error) => console.error(`Study packs: ${error.message}`));
  const startedAtLogin = BACKGROUND_FLAG || (process.platform === "darwin" && app.getLoginItemSettings(LOGIN_ITEM).wasOpenedAtLogin);
  if (startedAtLogin) await window.loadURL(host.url);
  else {
    await window.loadURL(host.url);
    window.show();
  }
});

// macOS: clicking the Dock icon brings the hidden window back.
app.on("activate", () => openPage(""));

app.on("before-quit", () => {
  quitting = true;
});

app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// The tray keeps the app alive; quitting goes through the tray menu.
app.on("window-all-closed", () => {
  if (SELFTEST) app.quit();
});
