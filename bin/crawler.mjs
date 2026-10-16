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
import { homedir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli.ts";
import { createLoginBrowser, createTokenStore } from "./electron-env.mjs";

app.setName("Crawler");
if (process.env.CRAWLER_DATA) app.setPath("userData", process.env.CRAWLER_DATA);

const tokenStore = createTokenStore({ safeStorage, dir: join(app.getPath("userData"), "tokens") });
const loginBrowser = createLoginBrowser({ BrowserWindow, session });

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
