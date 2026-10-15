/**
 * M0 spike: QMplus token login.
 *
 * Opens QMplus's mobile-app launch page in an Electron window. The student
 * signs in through QM's own SAML page (MFA included). Moodle then redirects to
 * `moodlemobile://token=<base64>`, which this window captures instead of
 * following. We verify the signature, keep the token encrypted with
 * Electron's safeStorage (DPAPI / Keychain), and ask Moodle which web-service
 * functions this token may call.
 *
 * The token is never printed or written in plain text. The report in out/
 * holds only what the design needs: Moodle version, permitted functions, and
 * the shape of course names.
 *
 * Run (borrowing Study Hub's Electron until Crawler has its own):
 *   ../universal-study-hub/node_modules/electron/dist/electron.exe spikes/qmplus-login/main.mjs
 */

import { app, BrowserWindow, safeStorage, session } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SITE = "https://qmplus.qmul.ac.uk";
const SCHEME = "moodlemobile";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** The functions docs/design/02-university-adapters.md plans to use, plus useful extras. */
const WANTED = [
  "core_webservice_get_site_info",
  "core_enrol_get_users_courses",
  "core_course_get_contents",
  "core_course_get_courses_by_field",
  "mod_assign_get_assignments",
  "mod_quiz_get_quizzes_by_courses",
  "core_calendar_get_action_events_by_timesort",
  "core_calendar_get_calendar_upcoming_view",
  "core_calendar_get_calendar_events",
  "mod_forum_get_forums_by_courses",
  "mod_forum_get_forum_discussions",
  "mod_forum_get_discussion_posts",
  "mod_resource_get_resources_by_courses",
  "mod_page_get_pages_by_courses",
  "mod_folder_get_folders_by_courses",
  "mod_url_get_urls_by_courses",
  "mod_lti_get_tool_launch_data",
  "mod_lti_get_ltis_by_courses",
  "tool_mobile_get_autologin_key",
];

// Keeps the encrypted token under %APPDATA%\Crawler Spike, not "Electron".
app.setName("Crawler Spike");

const passport = randomBytes(16).toString("hex");
const launchUrl =
  `${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app` +
  `&passport=${passport}&urlscheme=${SCHEME}`;

function log(message) {
  console.log(`[qmplus-login] ${message}`);
}

/** `moodlemobile://token=BASE64(md5(wwwroot+passport):::token[:::privatetoken])` */
function decodeLaunch(url) {
  const match = url.match(/token=([^&#]+)/);
  if (!match) throw new Error("Redirect had no token parameter.");
  const decoded = Buffer.from(decodeURIComponent(match[1]), "base64").toString("utf8");
  const [signature, token, privateToken] = decoded.split(":::");
  const expected = createHash("md5").update(SITE + passport).digest("hex");
  const expectedSlash = createHash("md5").update(`${SITE}/` + passport).digest("hex");
  if (signature !== expected && signature !== expectedSlash)
    throw new Error("Token signature did not match this site and passport. Refusing it.");
  if (!token) throw new Error("Redirect carried no token.");
  return { token, privateToken: privateToken || null };
}

async function ws(token, wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction, moodlewsrestformat: "json" });
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  const response = await fetch(`${SITE}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json();
  if (json && json.exception) throw new Error(`${wsfunction}: ${json.errorcode} — ${json.message}`);
  return json;
}

async function inspect(token, privateToken) {
  const info = await ws(token, "core_webservice_get_site_info");
  const permitted = new Set((info.functions || []).map((f) => f.name));
  const report = {
    checkedAt: new Date().toISOString(),
    site: info.siteurl,
    release: info.release,
    version: info.version,
    mobileService: true,
    privateTokenIssued: Boolean(privateToken),
    downloadFiles: Boolean(info.downloadfiles),
    functionCount: permitted.size,
    wanted: Object.fromEntries(WANTED.map((name) => [name, permitted.has(name)])),
    courses: null,
  };

  try {
    const courses = await ws(token, "core_enrol_get_users_courses", { userid: info.userid });
    // Names only, to design folder naming. No ids, no grades, no people.
    report.courses = {
      count: courses.length,
      sample: courses.slice(0, 12).map((c) => ({ shortname: c.shortname, fullname: c.fullname })),
    };
  } catch (error) {
    report.courses = { error: error.message };
  }
  return report;
}

function tokenFile() {
  return join(app.getPath("userData"), "tokens", "qmplus.bin");
}

function loadToken() {
  const saved = JSON.parse(safeStorage.decryptString(readFileSync(tokenFile())));
  return { token: saved.token, privateToken: saved.privateToken };
}

async function writeReport(token, privateToken) {
  const report = await inspect(token, privateToken);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log(`REPORT ${JSON.stringify({ ...report, courses: report.courses?.count ?? report.courses })}`);
}

function saveToken(token, privateToken) {
  if (!safeStorage.isEncryptionAvailable()) {
    log("OS encryption unavailable — token kept in memory only, not saved.");
    return null;
  }
  const file = tokenFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, safeStorage.encryptString(JSON.stringify({ site: SITE, token, privateToken })));
  return file;
}

// Closing the login window must not quit the app before the report is written.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  // --inspect: reuse the saved token instead of signing in again.
  if (process.argv.includes("--inspect")) {
    try {
      const { token, privateToken } = loadToken();
      await writeReport(token, privateToken);
      app.exit(0);
    } catch (error) {
      log(`FAILED ${error.message}`);
      app.exit(1);
    }
    return;
  }

  // A fresh, in-memory session: no cookies survive this run, and nothing from
  // the student's normal browser is visible to it.
  const loginSession = session.fromPartition("qmplus-login");
  // Some identity providers turn away an "Electron" user agent.
  loginSession.setUserAgent(loginSession.getUserAgent().replace(/\s?Electron\/\S+/, ""));

  let settled = false;
  const finish = async (url) => {
    if (settled) return;
    settled = true;
    try {
      const { token, privateToken } = decodeLaunch(url);
      window.close();
      log("Token received and signature verified.");
      const saved = saveToken(token, privateToken);
      if (saved) log(`Token stored encrypted at ${saved}`);
      await writeReport(token, privateToken);
      app.exit(0);
    } catch (error) {
      log(`FAILED ${error.message}`);
      app.exit(1);
    }
  };

  // Catch the custom-scheme redirect however it arrives: as a scheme request,
  // an HTTP redirect, or a script navigation.
  loginSession.protocol.handle(SCHEME, (request) => {
    finish(request.url);
    return new Response("Signed in. You can close this window.", { headers: { "content-type": "text/plain" } });
  });

  const window = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Sign in to QMplus",
    autoHideMenuBar: true,
    webPreferences: { session: loginSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  for (const event of ["will-redirect", "will-navigate", "will-frame-navigate"]) {
    window.webContents.on(event, (details, maybeUrl) => {
      const url = typeof maybeUrl === "string" ? maybeUrl : details.url;
      if (url && url.startsWith(`${SCHEME}://`)) {
        details.preventDefault?.();
        finish(url);
      }
    });
  }
  // Show where the student is in the flow, without logging query strings.
  window.webContents.on("did-navigate", (_event, url) => {
    try {
      const { host, pathname } = new URL(url);
      log(`at ${host}${pathname}`);
    } catch {
      /* not a URL worth logging */
    }
  });
  window.on("closed", () => {
    if (!settled) {
      log("FAILED Window closed before sign-in finished.");
      app.exit(2);
    }
  });

  setTimeout(() => {
    if (!settled) {
      log("FAILED No token within 10 minutes.");
      app.exit(3);
    }
  }, LOGIN_TIMEOUT_MS).unref();

  log("Opening QMplus sign-in. Sign in in the window that just appeared.");
  // Navigation to the custom scheme aborts the load; that is the success path.
  await window.loadURL(launchUrl).catch(() => {});
});
