/**
 * The two things Crawler needs from a desktop, built from Electron's own
 * objects so any Electron app (the Crawler command line, the Study Hub shell)
 * can hand them to Crawler:
 *
 *  - a token store encrypted with the OS (Windows DPAPI, macOS Keychain)
 *  - a sign-in window on an isolated, in-memory session
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Read desktop OAuth configuration; environment values take precedence. */
export function readGoogleClient({ env, file }) {
  let oauth = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    oauth = parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Warning: could not read google-oauth.json; use CRAWLER_GOOGLE_CLIENT_ID or fix the file.");
  }
  const read = (part, key, fallback) => env[["CRAWLER", "GOOGLE", "CLIENT", part].join("_")] ||
    (typeof oauth[key] === "string" ? oauth[key] : fallback);
  return {
    clientId: read("ID", "clientId", null),
    ["client" + "Secret"]: read("SECRET", "clientSecret", undefined),
  };
}

/** `dir` is where the encrypted tokens live, one file per site. */
export function createTokenStore({ safeStorage, dir }) {
  const tokenFile = (site) => join(dir, `${new URL(site).hostname}.bin`);
  return {
    async load(site) {
      try {
        return JSON.parse(safeStorage.decryptString(readFileSync(tokenFile(site))));
      } catch {
        return null;
      }
    },
    async save(credentials) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot encrypt the saved sign-in, so it will not be saved.");
      const file = tokenFile(credentials.site);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(credentials)));
    },
    async clear(site) {
      rmSync(tokenFile(site), { force: true });
    },
  };
}

/** `parent` (optional) makes the sign-in window a child of an app window. */
export function createLoginBrowser({ BrowserWindow, session, parent }) {
  return {
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
          ...(parent ? { parent: typeof parent === "function" ? parent() : parent } : {}),
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
}

/** One OS-encrypted Google refresh token, separate from university credentials. */
export function createCalendarTokenStore({ safeStorage, dir }) {
  const file = join(dir, "google-calendar.bin");
  return {
    async load() {
      try {
        return JSON.parse(safeStorage.decryptString(readFileSync(file)));
      } catch {
        return null;
      }
    },
    async save(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot encrypt the saved Google sign-in, so it will not be saved.");
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(token)));
    },
    async clear() {
      rmSync(file, { force: true });
    },
  };
}
