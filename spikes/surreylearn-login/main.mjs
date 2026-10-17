/**
 * Spike: SurreyLearn (D2L Brightspace) login and API probe.
 *
 * Opens SurreyLearn's login page in an Electron window. The student signs in
 * through Microsoft SAML (MFA included). When the window reaches /d2l/home we
 * read the session's cookies and, from Node's fetch with a Cookie header (not
 * from the window), probe the Brightspace REST API a student session may call:
 * versions, whoami, enrollments, and for two courses the content table of
 * contents, dropbox, quizzes, calendar, news and forums. On 401/403 we retry
 * with an X-Csrf-Token and via the window session's own fetch, and record which
 * variant worked.
 *
 * Cookie values are never printed or written in plain text. The cookie header
 * is kept encrypted with safeStorage in out/session.bin, so `--inspect` can
 * reuse it later and measure how long a session lives. The report in out/
 * holds only status codes and JSON key shapes (values redacted except counts,
 * ISO dates and course Name/Code).
 *
 * Run (borrowing Study Hub's Electron, as the QMplus spike does):
 *   ../universal-study-hub/node_modules/electron/dist/electron.exe spikes/surreylearn-login/main.mjs
 *   ../universal-study-hub/node_modules/electron/dist/electron.exe spikes/surreylearn-login/main.mjs --inspect
 */

import { app, BrowserWindow, safeStorage, session } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SESSION_FILE = join(OUT, "session.bin");
const HOST = "surreylearn.surrey.ac.uk";
const SITE = `https://${HOST}`;
const HOME = `${SITE}/d2l/home`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const PAUSE_MS = 300;
const COURSE_SAMPLE = 2;

app.setName("Crawler Spike");

function log(message) {
  console.log(`[surreylearn-login] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:?\d{2})?)?$/;
const KEPT_STRINGS = new Set(["Name", "Code"]);

/** Keys and types of a JSON value; keeps counts, ISO dates and course Name/Code only. */
function shape(value, key = "", depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { type: "array", count: value.length, item: value.length ? shape(value[0], "", depth + 1) : null };
  }
  if (typeof value === "object") {
    if (depth > 6) return "object";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k, depth + 1)]));
  }
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) return value;
    if (KEPT_STRINGS.has(key)) return `string: ${value}`;
    return "string";
  }
  return typeof value;
}

/** Path only, for logs and the report (no query values). */
function pathOf(path) {
  return path.split("?")[0];
}

// ---- requests ---------------------------------------------------------------

let cookieHeader = "";
let loginSession = null; // only set after an interactive sign-in
let csrf = undefined; // undefined = not tried, null = unavailable, string = token
const xsrfInfo = { tried: false };

async function rawGet(path, extraHeaders = {}) {
  await sleep(PAUSE_MS);
  const response = await fetch(`${SITE}${path}`, {
    headers: { cookie: cookieHeader, accept: "application/json", ...extraHeaders },
    redirect: "manual",
  });
  return response;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function csrfToken() {
  if (csrf !== undefined) return csrf;
  xsrfInfo.tried = true;
  try {
    const response = await rawGet("/d2l/lp/auth/xsrf-tokens");
    xsrfInfo.status = response.status;
    const json = response.ok ? await readJson(response) : undefined;
    xsrfInfo.exists = response.ok && json !== undefined;
    xsrfInfo.keys = json && typeof json === "object" ? Object.keys(json) : null;
    csrf = json?.referrerToken ?? json?.ReferrerToken ?? json?.token ?? null;
  } catch (error) {
    xsrfInfo.error = error.message;
    csrf = null;
  }
  return csrf;
}

/** GET with cookies; on 401/403 retry with X-Csrf-Token, then via the window session. */
async function probe(path) {
  const entry = { path: pathOf(path) };
  let response = await rawGet(path);
  entry.status = response.status;
  entry.variant = "cookie";
  if (response.status === 401 || response.status === 403) {
    entry.attempts = [{ variant: "cookie", status: response.status }];
    const token = await csrfToken();
    if (token) {
      response = await rawGet(path, { "x-csrf-token": token });
      entry.attempts.push({ variant: "cookie+csrf", status: response.status });
      entry.status = response.status;
      entry.variant = "cookie+csrf";
    }
    if (!response.ok && loginSession) {
      await sleep(PAUSE_MS);
      response = await loginSession.fetch(`${SITE}${path}`, { headers: { accept: "application/json" } });
      entry.attempts.push({ variant: "session.fetch", status: response.status });
      entry.status = response.status;
      entry.variant = "session.fetch";
    }
    entry.worked = response.ok ? entry.variant : null;
  }
  entry.contentType = response.headers.get("content-type");
  const json = response.ok ? await readJson(response) : undefined;
  if (json !== undefined) entry.shape = shape(json);
  log(`${entry.status} ${entry.path} (${entry.variant})`);
  return { entry, json };
}

function latest(versions, code) {
  const product = (versions || []).find((v) => v.ProductCode === code);
  return product?.LatestVersion ?? product?.SupportedVersions?.at(-1) ?? null;
}

function firstFileTopic(modules) {
  for (const module of modules || []) {
    for (const topic of module.Topics || []) {
      if (topic.Url && (topic.TypeIdentifier === "File" || /\/content\/enforced\//.test(topic.Url))) return topic;
    }
    const nested = firstFileTopic(module.Modules);
    if (nested) return nested;
  }
  return null;
}

async function inspect(savedAt) {
  const report = { checkedAt: new Date().toISOString(), sessionSavedAt: savedAt ?? null, probes: [] };
  if (savedAt) report.sessionAgeMinutes = Math.round((Date.now() - Date.parse(savedAt)) / 60000);
  const record = async (path) => {
    const result = await probe(path);
    report.probes.push(result.entry);
    return result;
  };

  const versions = await record("/d2l/api/versions/");
  const lp = latest(versions.json, "lp");
  const le = latest(versions.json, "le");
  report.versions = { lp, le };
  if (!lp || !le) {
    report.error = "Could not pick lp/le versions.";
    return report;
  }

  await record(`/d2l/api/lp/${lp}/users/whoami`);

  const courses = [];
  let bookmark = null;
  let pages = 0;
  do {
    const query = `?orgUnitTypeId=3${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ""}`;
    const { entry, json } = await probe(`/d2l/api/lp/${lp}/enrollments/myenrollments/${query}`);
    if (pages === 0) report.probes.push(entry);
    pages += 1;
    if (!json) break;
    courses.push(...(json.Items || []));
    bookmark = json.PagingInfo?.HasMoreItems ? json.PagingInfo.Bookmark : null;
  } while (bookmark && pages < 50);
  report.enrollments = {
    pages,
    count: courses.length,
    sample: courses.slice(0, 12).map((c) => ({ Name: c.OrgUnit?.Name, Code: c.OrgUnit?.Code })),
  };

  let fileTopic = null;
  for (const course of courses.slice(0, COURSE_SAMPLE)) {
    const id = course.OrgUnit?.Id;
    if (!id) continue;
    const toc = await record(`/d2l/api/le/${le}/${id}/content/toc`);
    fileTopic ??= firstFileTopic(toc.json?.Modules);
    for (const tail of ["dropbox/folders/", "quizzes/", "calendar/events/", "news/", "discussions/forums/"]) {
      await record(`/d2l/api/le/${le}/${id}/${tail}`);
    }
  }

  report.xsrfTokens = xsrfInfo;
  report.fileDownload = fileTopic ? await probeFile(fileTopic.Url) : { skipped: "no file topic found" };
  return report;
}

async function probeFile(url) {
  const path = url.startsWith("http") ? new URL(url).pathname : url;
  const result = { path: "(topic file url)" };
  for (const [method, headers] of [
    ["HEAD", {}],
    ["GET", { range: "bytes=0-0" }],
  ]) {
    await sleep(PAUSE_MS);
    const response = await fetch(`${SITE}${path}`, { method, headers: { cookie: cookieHeader, ...headers }, redirect: "manual" });
    await response.arrayBuffer().catch(() => {});
    result[method === "HEAD" ? "head" : "rangedGet"] = {
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
    log(`${response.status} file ${method}`);
  }
  return result;
}

// ---- session storage and reports --------------------------------------------

function saveSession(header) {
  if (!safeStorage.isEncryptionAvailable()) {
    log("OS encryption unavailable — session kept in memory only, not saved.");
    return null;
  }
  const savedAt = new Date().toISOString();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(SESSION_FILE, safeStorage.encryptString(JSON.stringify({ site: SITE, savedAt, cookie: header })));
  return savedAt;
}

function loadSession() {
  let blob;
  try {
    blob = readFileSync(SESSION_FILE);
  } catch {
    throw new Error(`No saved session at ${SESSION_FILE}. Run without --inspect and sign in first.`);
  }
  return JSON.parse(safeStorage.decryptString(blob));
}

function cookieSummary(cookies) {
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : "session",
  }));
}

function writeReport(report) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const lines = [
    "# SurreyLearn probe",
    "",
    `- Checked: ${report.checkedAt}`,
    `- Session saved: ${report.sessionSavedAt ?? "not saved"}${report.sessionAgeMinutes != null ? ` (${report.sessionAgeMinutes} min old)` : ""}`,
    `- Versions: lp ${report.versions?.lp ?? "?"}, le ${report.versions?.le ?? "?"}`,
    `- Enrollments: ${report.enrollments?.count ?? "?"} courses over ${report.enrollments?.pages ?? "?"} page(s)`,
    `- xsrf-tokens: ${report.xsrfTokens?.tried ? `status ${report.xsrfTokens.status ?? "error"}, keys ${JSON.stringify(report.xsrfTokens.keys ?? null)}` : "not needed"}`,
    `- File download: ${JSON.stringify(report.fileDownload ?? null)}`,
  ];
  if (report.cookies) lines.push(`- Cookies: ${report.cookies.map((c) => c.name).join(", ")}`);
  if (report.error) lines.push(`- Error: ${report.error}`);
  lines.push("", "| Status | Variant | Path |", "| --- | --- | --- |");
  for (const p of report.probes) lines.push(`| ${p.status} | ${p.worked === undefined ? p.variant : (p.worked ?? "none worked")} | ${p.path} |`);
  writeFileSync(join(OUT, "report.md"), lines.join("\n") + "\n");
  log(`REPORT written to ${OUT}`);
}

// ---- app --------------------------------------------------------------------

// Closing the login window must not quit the app before the report is written.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  // --inspect: reuse the saved cookie header instead of signing in again.
  if (process.argv.includes("--inspect")) {
    try {
      const saved = loadSession();
      cookieHeader = saved.cookie;
      writeReport(await inspect(saved.savedAt));
      app.exit(0);
    } catch (error) {
      log(`FAILED ${error.message}`);
      app.exit(1);
    }
    return;
  }

  // A fresh, in-memory session: nothing from the student's browser is visible.
  loginSession = session.fromPartition("surreylearn-login");
  // Some identity providers turn away an "Electron" user agent.
  loginSession.setUserAgent(loginSession.getUserAgent().replace(/\s?Electron\/\S+/, ""));

  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    try {
      const cookies = await loginSession.cookies.get({ domain: HOST });
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      log(`Signed in; ${cookies.length} cookies for ${HOST}.`);
      const savedAt = saveSession(cookieHeader);
      if (savedAt) log(`Session stored encrypted at ${SESSION_FILE}`);
      const report = await inspect(savedAt);
      report.cookies = cookieSummary(cookies);
      writeReport(report);
      window.close();
      app.exit(0);
    } catch (error) {
      log(`FAILED ${error.message}`);
      app.exit(1);
    }
  };

  const window = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Sign in to SurreyLearn",
    autoHideMenuBar: true,
    webPreferences: { session: loginSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Show where the student is in the flow, without logging query strings.
  window.webContents.on("did-navigate", (_event, url) => {
    try {
      const { host, pathname } = new URL(url);
      log(`at ${host}${pathname}`);
    } catch {
      /* not a URL worth logging */
    }
    if (url.startsWith(HOME)) finish();
  });
  window.on("closed", () => {
    if (!settled) {
      log("FAILED Window closed before sign-in finished.");
      app.exit(2);
    }
  });

  setTimeout(() => {
    if (!settled) {
      log("FAILED Not signed in within 10 minutes.");
      app.exit(3);
    }
  }, LOGIN_TIMEOUT_MS).unref();

  log("Opening SurreyLearn sign-in. Sign in in the window that just appeared.");
  await window.loadURL(`${SITE}/d2l/login`).catch(() => {});
});
