/**
 * Crawler command line, run inside Electron:
 *
 *   electron bin/crawler.mjs sync
 *
 * Electron supplies what plain Node cannot: a window for the university's own
 * sign-in page, and the operating system's encryption for the saved token
 * (Windows DPAPI, macOS Keychain). The commands themselves live in src/cli.ts.
 *
 * Environment:
 *   CRAWLER_DATA   where the encrypted tokens live (default: Electron's userData)
 */

import { BrowserWindow, app, safeStorage, session } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { runCli } from "../src/cli.ts";

app.setName("Crawler");
if (process.env.CRAWLER_DATA) app.setPath("userData", process.env.CRAWLER_DATA);

const tokenFile = (site) => join(app.getPath("userData"), "tokens", `${new URL(site).hostname}.bin`);

/** Encrypted with the OS; the token is never written in plain text. */
const tokenStore = {
  async load(site) {
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(tokenFile(site))));
    } catch {
      return null;
    }
  },
  async save(credentials) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot encrypt the saved sign-in, so Crawler will not save it.");
    const file = tokenFile(credentials.site);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, safeStorage.encryptString(JSON.stringify(credentials)));
  },
  async clear(site) {
    rmSync(tokenFile(site), { force: true });
  },
};

/** An isolated window with an in-memory session: nothing from the student's own browser is visible to it. */
const loginBrowser = {
  capture(url, captureScheme) {
    return new Promise((resolve, reject) => {
      const scheme = captureScheme.replace(/:.*$/, "");
      const loginSession = session.fromPartition(`crawler-login-${Date.now()}`);
      // Some identity providers turn away an "Electron" user agent.
      loginSession.setUserAgent(loginSession.getUserAgent().replace(/\s?Electron\/\S+/, ""));

      let settled = false;
      const win = new BrowserWindow({
        width: 520,
        height: 760,
        title: "Sign in",
        autoHideMenuBar: true,
        webPreferences: { session: loginSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        win.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        win.destroy();
        reject(new Error("No sign-in within 10 minutes."));
      }, 10 * 60 * 1000);

      loginSession.protocol.handle(scheme, (request) => {
        finish(request.url);
        return new Response("Signed in. You can close this window.", { headers: { "content-type": "text/plain" } });
      });
      for (const event of ["will-redirect", "will-navigate", "will-frame-navigate"]) {
        win.webContents.on(event, (details, maybeUrl) => {
          const target = typeof maybeUrl === "string" ? maybeUrl : details.url;
          if (target?.startsWith(`${scheme}://`)) {
            details.preventDefault?.();
            finish(target);
          }
        });
      }
      win.on("closed", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("The sign-in window was closed before signing in finished."));
      });
      // The redirect to the custom scheme aborts the load; that is the success path.
      win.loadURL(url).catch(() => {});
    });
  },
};

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  const code = await runCli(argv, {
    tokenStore,
    loginBrowser,
    defaultRoot: join(homedir(), "Documents", "My Studies"),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  app.exit(code);
});
