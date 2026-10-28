/**
 * Study Hub Host — serves the built site and runs the AI CLI from one process.
 *
 * WHY THIS REPLACES THE BRIDGE
 * The bridge needed a pairing code because the page and the CLI relay lived
 * on different origins, and any website can try to reach localhost. Here the
 * host serves the page itself, so page and API share one origin:
 *
 *  - every HTML response sets a per-launch secret as an HttpOnly,
 *    SameSite=Strict cookie — a foreign site can neither read nor send it
 *  - every /api/* request must carry that cookie and a custom header (which
 *    forces a CORS preflight the host never approves), come from a loopback
 *    Host (defeats DNS rebinding), and, when the browser sends an Origin,
 *    come from this exact origin
 *
 * The user never sees or pastes anything. The CLI spawn guards are the old
 * bridge's, unchanged (see cli.mjs).
 *
 * Usage: node host/index.mjs [--port=3000]   (after `pnpm build`)
 * Prints `STUDYHUB_HOST_READY {"port":N}` once listening.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { cpSync, createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CLI_SETTINGS, findCli, runCli } from "./cli.mjs";
import { addDeadline, removeDeadline, setDeadlineDone, readAssessments, libraryRoot, listLibrary, rawStream, readDeadlines, readModuleFile, readTexts, removeOwnFile, resolveDeadline, writeModuleFile, writeOwnFile, writeOwnNote, MAX_OWN_FILE_BYTES } from "./library.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist");
/** The client half of the snapshot the server bundle came from; set by loadSite. */
let CLIENT = join(DIST, "client");
const VERSION = "0.1.0-spike";
const PORTS = [3000, 3001, 3002, 3003, 3004, 3005];
const GUARD_HEADER = "x-study-hub-host";
const SESSION_COOKIE = "studyhub_session";
/** Not a secret: lets the page know synchronously that it is being hosted. */
const HOSTED_COOKIE = "studyhub_host";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const SECRET = randomBytes(16).toString("hex");

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------------------------------------- auth */

function cookies(request) {
  const out = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function secretMatches(candidate) {
  const a = Buffer.from(String(candidate || ""), "utf8");
  const b = Buffer.from(SECRET, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostIsLoopback(request, port) {
  const host = String(request.headers.host || "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/** Same-origin only. A browser always sends Origin on a cross-origin request. */
function originAllowed(request, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function sessionCookies() {
  return [
    `${SESSION_COOKIE}=${SECRET}; HttpOnly; SameSite=Strict; Path=/`,
    `${HOSTED_COOKIE}=1; SameSite=Strict; Path=/`,
  ];
}

/* ------------------------------------------------------------- helpers */

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("Request too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/** A file under dist/client, or null. Never escapes that folder. */
function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const full = normalize(join(CLIENT, decoded));
  if (!full.startsWith(CLIENT + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function serveStatic(response, file) {
  const immutable = file.includes(`${sep}_next${sep}static${sep}`);
  response.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(response);
}

/* ------------------------------------------------------------- AI API */

/**
 * The CLIs found so far. A CLI can appear after start-up (the student installs
 * or signs in to one while Study Hub is open) or move (the desktop apps update
 * into a new version folder), so detection is not a one-off:
 *
 *  - `?refresh=1` on /healthz searches again — the page's "Check again"
 *  - a missing CLI, or one whose path no longer exists, is searched for again
 *    whenever it is asked about, at most once per REDETECT_MS
 *  - a run that fails because the executable vanished searches and retries once
 *
 * Detection runs each candidate's `--version` synchronously; it is rare enough
 * that briefly blocking the server is acceptable.
 */
const KINDS = ["claude", "codex", "gemini"];
const REDETECT_MS = 5_000;
let clis = {};
const lastSearch = {};

function detect(kind) {
  clis[kind] = findCli(kind);
  lastSearch[kind] = Date.now();
  return clis[kind];
}

function detectClis() {
  for (const kind of KINDS) detect(kind);
  return clis;
}

function isStale(cli) {
  return !cli?.path || (/[\\/]/.test(cli.path) && !existsSync(cli.path));
}

/** The CLI to use for `kind`, searching again if it is missing or has moved. */
function currentCli(kind) {
  const cli = clis[kind];
  if (isStale(cli) && Date.now() - (lastSearch[kind] || 0) >= REDETECT_MS) return detect(kind);
  return cli;
}

/**
 * One CLI run at a time per lane. Automatic study packs run in the background
 * lane, so a request the student starts never waits behind them or is refused.
 */
const running = { foreground: 0, background: 0 };

async function handleAi(request, response, url) {
  if (url.pathname === "/api/ai/healthz" && request.method === "GET") {
    if (url.searchParams.get("refresh") === "1") detectClis();
    else for (const kind of KINDS) currentCli(kind);
    sendJson(response, 200, {
      name: "study-hub-host",
      version: VERSION,
      port: 0,
      clis: {
        claude: { present: Boolean(clis.claude.path), version: clis.claude.version },
        codex: { present: Boolean(clis.codex.path), version: clis.codex.version },
        gemini: { present: Boolean(clis.gemini.path), version: clis.gemini.version },
      },
      searched: [...new Set(KINDS.flatMap((kind) => clis[kind].searched))].slice(0, 24),
      capabilities: {
        claudeWeb: Boolean(CLI_SETTINGS.claude.webArgs),
        codexWeb: Boolean(CLI_SETTINGS.codex.webArgs),
        geminiWeb: Boolean(CLI_SETTINGS.gemini.webArgs),
      },
    });
    return;
  }

  if (url.pathname !== "/api/ai/v1/generate" || request.method !== "POST") {
    sendJson(response, 404, { code: "not_found", message: "No such endpoint." });
    return;
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    sendJson(response, 400, { code: "bad_request", message: error.message });
    return;
  }

  const kind = body.provider === "openai" ? "codex" : body.provider === "google" ? "gemini" : "claude";
  const cli = currentCli(kind);
  if (body.probe) {
    if (!cli?.path) {
      sendJson(response, 200, { code: "cli_not_found", message: `\`${kind}\` was not found.`, detail: cli?.searched?.join(", ") });
      return;
    }
    sendJson(response, 200, { ok: true, model: `${kind} ${cli.version || ""}`.trim() });
    return;
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    sendJson(response, 400, { code: "bad_request", message: "No prompt supplied." });
    return;
  }
  const lane = body.background === true ? "background" : "foreground";
  if (running[lane] > 0) {
    sendJson(response, 429, { code: "rate_limited", message: "Already running a request." });
    return;
  }

  running[lane]++;
  const label = new Date().toTimeString().slice(0, 8);
  console.log(`[${label}] ${kind}: ${body.prompt.length} chars in…`);
  const run = (found) =>
    runCli(found, kind, body.prompt, typeof body.model === "string" ? body.model : "", body.webAccess === true);
  try {
    let text;
    try {
      text = await run(cli);
    } catch (error) {
      if (error?.code !== "cli_moved") throw error;
      // Moved since it was found: search again and retry once.
      console.log(`[${label}] ${kind} moved; searching again…`);
      const found = detect(kind);
      if (!found.path)
        throw { code: "cli_not_found", message: `Could not find the \`${kind}\` command any more.`, detail: `Searched: ${found.searched.join(", ")}` };
      text = await run(found);
    }
    console.log(`[${label}] ${kind}: ${text.length} chars out.`);
    sendJson(response, 200, { text, model: kind });
  } catch (error) {
    const failure = error && error.code ? error : { code: "cli_incompatible", message: String(error) };
    console.log(`[${label}] ${kind} failed: ${failure.message}`);
    sendJson(response, 500, failure);
  } finally {
    running[lane]--;
  }
}

/** A raw (non-JSON) request body, refused past `limit` bytes before it is all read. */
function readRawBody(request, limit) {
  return new Promise((resolveBody, reject) => {
    if (Number(request.headers["content-length"]) > limit) {
      reject(new Error("That file is larger than 50 MB."));
      request.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("That file is larger than 50 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/* ------------------------------------------------------------- library API */

async function handleLibrary(request, response, url) {
  const root = libraryRoot();
  if (url.pathname === "/api/library/tree" && request.method === "GET") {
    sendJson(response, 200, { root, ...(await listLibrary(root)) });
    return;
  }
  if (url.pathname === "/api/library/texts" && request.method === "POST") {
    const body = await readBody(request).catch(() => ({}));
    sendJson(response, 200, { texts: await readTexts(root, body.paths) });
    return;
  }
  if (url.pathname === "/api/library/deadlines" && request.method === "GET") {
    sendJson(response, 200, { deadlines: await readDeadlines(root) });
    return;
  }
  if (url.pathname === "/api/library/assessments" && request.method === "GET") {
    sendJson(response, 200, { assessments: await readAssessments(root) });
    return;
  }
  const deadlineMutation = new Map([
    ["/api/library/deadlines/add", addDeadline],
    ["/api/library/deadlines/remove", removeDeadline],
    ["/api/library/deadlines/done", setDeadlineDone],
  ]).get(url.pathname);
  if (deadlineMutation && request.method === "POST") {
    const body = await readBody(request).catch(() => ({}));
    const result = await deadlineMutation(root, body);
    sendJson(response, result.error ? 400 : 200, result.error ? { code: "bad_request", message: result.error } : result);
    return;
  }
  if (url.pathname === "/api/library/deadlines/resolve" && request.method === "POST") {
    const body = await readBody(request).catch(() => ({}));
    const result = await resolveDeadline(root, body);
    sendJson(response, result.error ? 400 : 200, result.error ? { code: "bad_request", message: result.error } : result);
    return;
  }
  if (url.pathname === "/api/library/own-file" && request.method === "POST") {
    let content;
    try {
      content = await readRawBody(request, MAX_OWN_FILE_BYTES);
    } catch (error) {
      sendJson(response, 413, { code: "too_large", message: error.message });
      return;
    }
    const result = await writeOwnFile(root, url.searchParams.get("module"), url.searchParams.get("name"), content);
    sendJson(response, result.error ? 400 : 200, result.error ? { code: "bad_request", message: result.error } : result);
    return;
  }
  const ownMutation = new Map([
    ["PUT /api/library/own-note", writeOwnNote],
    ["POST /api/library/own-file/remove", removeOwnFile],
  ]).get(`${request.method} ${url.pathname}`);
  if (ownMutation) {
    const body = await readBody(request).catch(() => ({}));
    const result = await ownMutation(root, body);
    sendJson(response, result.error ? 400 : 200, result.error ? { code: "bad_request", message: result.error } : result);
    return;
  }
  if (url.pathname === "/api/library/module-file" && request.method === "GET") {
    const result = await readModuleFile(root, url.searchParams.get("module"), url.searchParams.get("path"));
    sendJson(response, result.error ? 400 : 200, result.error ? { code: "bad_request", message: result.error } : result);
    return;
  }
  if (url.pathname === "/api/library/module-file" && request.method === "PUT") {
    const body = await readBody(request).catch(() => ({}));
    const result = await writeModuleFile(root, body.module, body.path, body.content);
    sendJson(response, result.error ? 400 : 200, result.error ? { code: "bad_request", message: result.error } : result);
    return;
  }
  sendJson(response, 404, { code: "not_found", message: "No such endpoint." });
}

/**
 * `/library/<path>` streams one file, so a PDF can open at `#page=N` in its own
 * window. It is a navigation, so it cannot carry the guard header; the
 * SameSite=Strict session cookie and Sec-Fetch-Site keep other sites out.
 */
function serveLibraryFile(request, response, url) {
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    sendJson(response, 403, { code: "bad_origin", message: "Cross-site requests are refused." });
    return;
  }
  if (!secretMatches(cookies(request)[SESSION_COOKIE])) {
    sendJson(response, 401, { code: "no_session", message: "Reload Study Hub to start a new session." });
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice("/library/".length));
  } catch {
    relative = "";
  }
  const file = rawStream(libraryRoot(), relative);
  if (!file || !existsSync(file.full) || !statSync(file.full).isFile()) {
    sendJson(response, 404, { code: "not_found", message: "That file is not in your library." });
    return;
  }
  response.writeHead(200, {
    "content-type": file.mime,
    "content-length": statSync(file.full).size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Chromium's PDF viewer refuses sandboxed documents; everything else is sandboxed.
    ...(file.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox" }),
  });
  file.stream().pipe(response);
}

/* ------------------------------------------------------------- setup API */

/**
 * First launch and syncing. Only the desktop shell can sign in (it owns the
 * windows), so it hands the host a `setup` object; a plain `node host` has none.
 */
export async function handleSetup(setup, request, response, url) {
  if (!setup) {
    sendJson(response, 404, { code: "no_setup", message: "Signing in needs the Study Hub desktop app." });
    return;
  }
  if (url.pathname === "/api/setup/status" && request.method === "GET") {
    sendJson(response, 200, await setup.status());
    return;
  }
  if (url.pathname === "/api/setup/packs" && request.method === "GET") {
    sendJson(response, 200, setup.packsStatus?.() ?? { state: "idle", module: null });
    return;
  }
  const action = {
    "/api/setup/university": setup.selectUniversity,
    "/api/setup/sign-in": setup.signIn,
    "/api/setup/sync": setup.startSync,
    "/api/setup/module/open": setup.openModuleFolder,
    "/api/setup/library/claim": setup.claimLibrary,
    "/api/setup/library/fresh": setup.freshLibrary,
    "/api/setup/schedule": setup.setSchedule,
    "/api/setup/packs/rebuild": setup.packsRebuild,
    "/api/setup/calendar/connect": setup.calendarConnect,
    "/api/setup/calendar/sync": setup.calendarSync,
    "/api/setup/calendar/disconnect": setup.calendarDisconnect,
  }[url.pathname];
  if (action && request.method === "POST") {
    const body = await readBody(request).catch(() => ({}));
    const result = await action(body && typeof body === "object" ? body : {});
    sendJson(response, result.error ? 400 : 200, result.error ? { code: result.code ?? "setup_failed", message: result.error } : result);
    return;
  }
  sendJson(response, 404, { code: "not_found", message: "No such endpoint." });
}

/* ------------------------------------------------------------- server */

const SNAPSHOT_PREFIX = "studyhub-build-";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Serves a private copy of the build rather than dist/ itself. The server bundle
 * stays in memory for the life of the app, so if `pnpm build` runs meanwhile its
 * pages would ask for client chunks the rebuild has just deleted, and every page
 * not yet visited would fail with "This page couldn't load". A copy keyed by
 * BUILD_ID keeps the server and client halves from the same build.
 */
function snapshotBuild() {
  const buildId = readFileSync(join(DIST, "server", "BUILD_ID"), "utf8").trim();
  const root = join(tmpdir(), `${SNAPSHOT_PREFIX}${buildId.replace(/[^\w-]/g, "")}`);
  if (!existsSync(join(root, "complete"))) {
    rmSync(root, { recursive: true, force: true });
    cpSync(DIST, root, { recursive: true });
    cpSync(join(DIST, "server", "BUILD_ID"), join(root, "complete"));
  }
  // Marks the copy as in use, so the pruning below in another app leaves it alone.
  utimesSync(root, new Date(), new Date());
  for (const name of readdirSync(tmpdir())) {
    const old = join(tmpdir(), name);
    if (!name.startsWith(SNAPSHOT_PREFIX) || old === root) continue;
    try {
      if (Date.now() - statSync(old).mtimeMs > WEEK_MS) rmSync(old, { recursive: true, force: true });
    } catch {
      /* another app may still be using it */
    }
  }
  return root;
}

async function loadSite() {
  const entry = join(DIST, "server", "index.js");
  if (!existsSync(entry)) throw new Error(`No build found at ${entry}. Run \`pnpm build\` first.`);
  const root = snapshotBuild();
  CLIENT = join(root, "client");
  return (await import(pathToFileURL(join(root, "server", "index.js")).href)).default;
}

function toWebRequest(request, port) {
  const url = `http://127.0.0.1:${port}${request.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeWebResponse(response, web) {
  const headers = {};
  web.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    headers[name] = value;
  });
  const setCookie = web.headers.getSetCookie?.() || [];
  const isHtml = (web.headers.get("content-type") || "").includes("text/html");
  const allCookies = [...setCookie, ...(isHtml ? sessionCookies() : [])];
  if (allCookies.length) headers["set-cookie"] = allCookies;
  response.writeHead(web.status, headers);
  if (!web.body) return response.end();
  for await (const chunk of web.body) response.write(chunk);
  response.end();
}

export async function startHost({ port: preferred, setup } = {}) {
  const site = await loadSite();
  detectClis();

  const env = {
    ASSETS: {
      fetch: async (assetRequest) => {
        const file = staticFile(new URL(assetRequest.url).pathname);
        if (!file) return new Response("Not found", { status: 404 });
        return new Response(Readable.toWeb(createReadStream(file)), {
          headers: { "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream" },
        });
      },
    },
    IMAGES: null,
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const ports = preferred ? [preferred, ...PORTS.filter((p) => p !== preferred)] : PORTS;

  for (const port of ports) {
    const server = createServer(async (request, response) => {
      try {
        if (!hostIsLoopback(request, port)) {
          sendJson(response, 421, { code: "bad_host", message: "Study Hub only answers on 127.0.0.1." });
          return;
        }
        const url = new URL(request.url, `http://127.0.0.1:${port}`);

        if (url.pathname.startsWith("/api/")) {
          if (!originAllowed(request, port)) {
            sendJson(response, 403, { code: "bad_origin", message: "Cross-origin requests are refused." });
            return;
          }
          if (request.headers[GUARD_HEADER] !== "1") {
            sendJson(response, 400, { code: "bad_request", message: "Missing the Study Hub header." });
            return;
          }
          if (!secretMatches(cookies(request)[SESSION_COOKIE])) {
            sendJson(response, 401, { code: "no_session", message: "Reload Study Hub to start a new session." });
            return;
          }
          if (url.pathname.startsWith("/api/ai/")) return await handleAi(request, response, url);
          if (url.pathname.startsWith("/api/library/")) return await handleLibrary(request, response, url);
          if (url.pathname.startsWith("/api/setup/")) return await handleSetup(setup, request, response, url);
          sendJson(response, 404, { code: "not_found", message: "No such endpoint." });
          return;
        }

        if (url.pathname.startsWith("/library/") && request.method === "GET")
          return serveLibraryFile(request, response, url);
        if (request.method === "GET" || request.method === "HEAD") {
          const file = staticFile(url.pathname);
          if (file) return serveStatic(response, file);
        }
        await writeWebResponse(response, await site.fetch(toWebRequest(request, port), env, ctx));
      } catch (error) {
        console.error(error);
        if (!response.headersSent) sendJson(response, 500, { code: "host_error", message: "Something went wrong." });
        else response.end();
      }
    });

    const listening = await new Promise((resolveListen) => {
      server.once("error", (error) => resolveListen(error.code === "EADDRINUSE" ? null : Promise.reject(error)));
      // 127.0.0.1 only. Binding 0.0.0.0 would expose this to the whole network.
      server.listen(port, "127.0.0.1", () => resolveListen(server));
    });
    if (listening) return { server, port, url: `http://127.0.0.1:${port}/`, clis };
  }
  throw new Error(`Ports ${PORTS[0]}-${PORTS[PORTS.length - 1]} are all in use.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const { port, clis: found } = await startHost({ port: portArg ? Number(portArg.slice(7)) : undefined });
  for (const [name, cli] of Object.entries(found))
    console.log(`  ${cli.path ? "found  " : "missing"}  ${name}${cli.version ? `  ${cli.version}` : ""}${cli.path ? `  (${cli.path})` : ""}`);
  console.log(`  Study Hub: http://127.0.0.1:${port}/`);
  console.log(`STUDYHUB_HOST_READY ${JSON.stringify({ port })}`);
}
