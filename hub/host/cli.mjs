/**
 * Finding and running the `claude` / `codex` / `gemini` CLI for the Study Hub host.
 *
 * Ported from the old bridge (bridge/index.mjs, now removed): same spawn guards
 * (shell:false, argv array, prompt on stdin, empty temp cwd, scrubbed env,
 * provider API keys stripped, file and shell tools disallowed), plus the
 * install locations the bridge never searched — the copies bundled inside the
 * Claude and Codex desktop apps, which is where the CLI lives on a machine
 * that never ran `npm install -g`.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

const RUN_TIMEOUT_MS = 180_000;
// A first start of a freshly installed exe can sit behind antivirus for a while.
const VERSION_TIMEOUT_MS = 20_000;
const AUTH_TIMEOUT_MS = 10_000;
// Detection blocks the host, so a kind with several slow or broken copies
// stops trying more of them after this long.
const KIND_BUDGET_MS = 25_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const CLI_SETTINGS = {
  claude: {
    args: [
      "--print",
      "--output-format",
      "text",
      "--disallowed-tools",
      "Bash,PowerShell,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task",
    ],
    // Chat turns the user explicitly opted into web access for. Filesystem and
    // shell tools stay off either way.
    webArgs: [
      "--print",
      "--output-format",
      "text",
      "--disallowed-tools",
      "Bash,PowerShell,Read,Write,Edit,Glob,Grep,NotebookEdit,Task",
    ],
    modelFlag: "--model",
  },
  codex: {
    args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check"],
    webArgs: null,
    modelFlag: "--model",
  },
  // Headless when stdin is not a terminal; the default approval mode refuses
  // every tool that would need confirmation, so it cannot edit or run commands.
  gemini: {
    args: ["--output-format", "text", "--approval-mode", "default"],
    webArgs: null,
    modelFlag: "--model",
  },
};

export const CLI_APPS = { claude: "Claude", codex: "Codex", gemini: "Gemini CLI" };

/** What the detection and the auth probe need from the machine; tests replace any of it. */
function defaultDeps() {
  return {
    spawnSync,
    existsSync,
    readFileSync,
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    now: Date.now,
  };
}

const withDeps = (overrides) => ({ ...defaultDeps(), ...overrides });

/**
 * CLI output can quote a credential (`codex login status` prints a fragment of
 * the API key it uses), so anything a CLI said passes through this before it
 * reaches an error or detail field.
 */
export function redactSecrets(text) {
  return String(text ?? "").replace(/\b(sk|key)[-_\w*]{4,}/gi, "[redacted]");
}

/** The line of `text` that says what went wrong, without colour codes or secrets, capped. */
export function summariseFailure(text, max = 220) {
  const lines = redactSecrets(text || "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const telling = lines.find((line) =>
    /error|fail|denied|invalid|unauthori[sz]ed|not (found|logged|signed)|log ?in|limit|quota|expired/i.test(line),
  );
  return (telling || lines[lines.length - 1]).slice(0, max);
}

/**
 * Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980), and a shell
 * is not acceptable here. An npm shim only runs `node "<script>" %*` (or, for
 * the native-binary packages, the `.exe` inside the package), so run that
 * target directly with the Node we are already in.
 */
function resolveWindowsShim(cmdPath, d) {
  try {
    const match = d.readFileSync(cmdPath, "utf8").match(/%~?dp0%?\\+([^"\r\n%]+?\.(?:c?js|mjs|exe))/i);
    if (!match) return null;
    const target = join(dirname(cmdPath), match[1].replace(/\\+/g, "/"));
    return d.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/** How to start the file at `path`: the program and any leading arguments, or why it cannot be started. */
function launchPlan(path, d) {
  if (d.platform !== "win32") return { command: path, prefixArgs: [] };
  const ext = extname(path).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { command: path, prefixArgs: [] };
  if (ext === ".cmd" || ext === ".bat") {
    const target = resolveWindowsShim(path, d);
    if (!target) return { error: "is an npm shim whose target script or program could not be located" };
    if (extname(target).toLowerCase() === ".exe") return { command: target, prefixArgs: [] };
    return { command: d.execPath, prefixArgs: [target] };
  }
  return { error: `is a ${ext || "extensionless"} shim Windows cannot run directly (use the .cmd or .exe next to it)` };
}

/** Newest-first executables matching `<root>/<a>/<b>/<file>`, by modified time. */
function nestedExecutables(root, depth, file) {
  const found = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // Follow links (symlinks, Windows junctions) the way the OS would.
      let stats;
      try {
        stats = entry.isSymbolicLink() ? statSync(path) : entry;
      } catch {
        continue;
      }
      if (level === depth) {
        if (stats.isFile() && entry.name.toLowerCase() === file.toLowerCase()) found.push(path);
      } else if (stats.isDirectory()) walk(path, level + 1);
    }
  };
  walk(root, 0);
  return found
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((hit) => hit.path);
}

/**
 * An app opened from Finder does not inherit the shell's PATH, so ask the
 * user's login shell where the command is.
 */
function loginShellLookup(name, d) {
  if (d.platform === "win32") return null;
  const shell = d.env.SHELL || "/bin/zsh";
  try {
    const result = d.spawnSync(shell, ["-lc", `command -v ${name}`], {
      shell: false,
      encoding: "utf8",
      timeout: 5_000,
    });
    const first = (result.stdout || "").trim().split("\n").pop();
    return first && first.startsWith("/") ? first : null;
  } catch {
    return null;
  }
}

/**
 * The PATH Windows itself would give a fresh program. A process launched from
 * Explorer or an installer keeps the PATH it started with, so a CLI installed
 * after Study Hub opened is not on it.
 */
function windowsRegistryPath(d) {
  const keys = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"];
  const dirs = [];
  for (const key of keys) {
    try {
      const result = d.spawnSync("reg", ["query", key, "/v", "Path"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 5_000,
      });
      const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(result?.stdout || "");
      if (!match) continue;
      const expanded = match[1]
        .trim()
        .replace(/%([^%]+)%/g, (all, name) => d.env[name] ?? d.env[name.toUpperCase()] ?? all);
      dirs.push(...expanded.split(";"));
    } catch {
      /* no reg.exe; the process PATH has to do */
    }
  }
  return dirs;
}

/**
 * Directories to look in: this process's PATH first, then the system's current
 * one. Reading the registry starts two processes, so a detection run reads it
 * once and hands the result to every findCli as `searchDirs`.
 */
export function cliSearchDirs(overrides = {}) {
  return searchDirs(withDeps(overrides));
}

function searchDirs(d) {
  const win = d.platform === "win32";
  const own = (d.env.PATH ?? d.env.Path ?? "").split(win ? ";" : ":");
  const seen = new Set();
  const dirs = [];
  for (const raw of win ? [...own, ...windowsRegistryPath(d)] : own) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    const key = win ? dir.toLowerCase() : dir;
    if (!dir || seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Executables called `name` on PATH, in PATH order. `where claude` lists the
 * extensionless npm sh script first, which Windows cannot run, so instead of
 * trusting its first line we look for the files Windows can start (.exe, then
 * the .cmd shim) ourselves.
 */
function pathLookup(name, d) {
  const exts = d.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const hits = [];
  for (const dir of d.searchDirs ?? searchDirs(d))
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (d.existsSync(candidate)) hits.push(candidate);
    }
  return hits;
}

function candidates(name, d) {
  const home = d.home;
  if (d.platform === "win32") {
    const appData = d.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData = d.env.LOCALAPPDATA || join(home, "AppData", "Local");
    const programFiles = d.env.ProgramFiles || "C:\\Program Files";
    const npmPrefix = d.env.npm_config_prefix || d.env.NPM_CONFIG_PREFIX;
    return [
      join(localAppData, "Programs", name, `${name}.exe`),
      join(appData, "npm", `${name}.cmd`),
      ...(npmPrefix ? [join(npmPrefix, `${name}.cmd`)] : []),
      join(programFiles, "nodejs", `${name}.cmd`),
      join(localAppData, "pnpm", `${name}.cmd`),
      join(home, ".local", "bin", `${name}.exe`),
      join(home, ".bun", "bin", `${name}.exe`),
      join(home, ".volta", "bin", `${name}.exe`),
      join(home, "scoop", "shims", `${name}.exe`),
      join(home, `.${name}`, "local", `${name}.exe`),
      // `winget install` puts a link here and the package itself below Packages.
      join(localAppData, "Microsoft", "WinGet", "Links", `${name}.exe`),
      ...nestedExecutables(join(localAppData, "Microsoft", "WinGet", "Packages"), 1, `${name}.exe`),
      // Bundled with the desktop apps: claude-code/<version>/<hash>/claude.exe
      // (or without the hash) and OpenAI/Codex/bin/<hash>/codex.exe.
      ...(name === "claude"
        ? [
            ...nestedExecutables(join(appData, "Claude", "claude-code"), 2, "claude.exe"),
            ...nestedExecutables(join(appData, "Claude", "claude-code"), 1, "claude.exe"),
          ]
        : []),
      ...(name === "codex"
        ? [
            ...nestedExecutables(join(localAppData, "OpenAI", "Codex", "bin"), 1, "codex.exe"),
            ...nestedExecutables(join(localAppData, "OpenAI", "Codex", "bin"), 0, "codex.exe"),
          ]
        : []),
    ];
  }
  return [
    loginShellLookup(name, d),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    join(home, ".local", "bin", name),
    join(home, ".npm-global", "bin", name),
    join(home, ".bun", "bin", name),
    join(home, `.${name}`, "local", name),
  ].filter(Boolean);
}

/**
 * Looks for the CLI and runs `--version` on each hit until one works.
 *
 * `path` is the copy that runs; when none does it is null and `error` says why
 * in words — not found, found but failed (with its output), or timed out (a
 * cold start behind antivirus can be slow) — and `failedPath` is the first copy
 * that was found but would not run, so the panel can still show where it looked.
 * Copies are run for at most KIND_BUDGET_MS in all; any left after that are
 * counted in `error` but not run.
 * `overrides` replaces the machine (spawnSync, existsSync, platform, env, now, …)
 * in tests; `searchDirs` (from cliSearchDirs) saves reading the registry again.
 */
export function findCli(name, overrides = {}) {
  const d = withDeps(overrides);
  const started = d.now();
  const searched = [];
  // On Windows the same file can be listed twice in different case.
  const seen = new Set();
  const failures = [];
  let untried = 0;
  const tryRun = (cmd) => {
    const key = d.platform === "win32" ? cmd.toLowerCase() : cmd;
    if (seen.has(key)) return null;
    seen.add(key);
    searched.push(cmd);
    if (/[\\/]/.test(cmd) && !d.existsSync(cmd)) return null;
    const plan = launchPlan(cmd, d);
    if (plan.error) {
      failures.push({ path: cmd, problem: plan.error });
      return null;
    }
    const timeout = Math.min(VERSION_TIMEOUT_MS, KIND_BUDGET_MS - (d.now() - started));
    if (timeout <= 0) {
      untried++;
      return null;
    }
    const result = d.spawnSync(plan.command, [...plan.prefixArgs, "--version"], {
      shell: false,
      windowsHide: true,
      timeout,
      encoding: "utf8",
      // Electron's own binary is process.execPath inside the shell; make it
      // behave as plain Node when running an npm shim's script.
      env: plan.prefixArgs.length ? { ...d.env, ELECTRON_RUN_AS_NODE: "1" } : d.env,
    });
    if (result?.error) {
      failures.push({
        path: cmd,
        problem:
          result.error.code === "ETIMEDOUT"
            ? `did not answer \`--version\` within ${Math.ceil(timeout / 1000)} seconds`
            : `could not be started: ${redactSecrets(result.error.message)}`,
      });
      return null;
    }
    if (result?.status !== 0) {
      const said = summariseFailure(result?.stderr || result?.stdout);
      failures.push({ path: cmd, problem: `failed \`--version\` with exit code ${result?.status}${said ? `: ${said}` : ""}` });
      return null;
    }
    return {
      path: cmd,
      command: plan.command,
      prefixArgs: plan.prefixArgs,
      version: redactSecrets((result.stdout || result.stderr || "").trim().split(/\r?\n/)[0]).slice(0, 80),
      searched,
      failedPath: null,
      error: null,
    };
  };

  for (const candidate of [...pathLookup(name, d), ...candidates(name, d)]) {
    const hit = tryRun(candidate);
    if (hit) return hit;
  }
  const first = failures[0];
  const others = failures.length - 1;
  const stopped = untried
    ? ` Stopped after ${KIND_BUDGET_MS / 1000} seconds; ${untried} more cop${untried > 1 ? "ies were" : "y was"} not tried.`
    : "";
  return {
    path: null,
    command: null,
    prefixArgs: [],
    version: null,
    searched,
    failedPath: first?.path ?? null,
    error: first
      ? `Found ${first.path} but it ${first.problem}.${others ? ` (${others} other cop${others > 1 ? "ies" : "y"} failed too.)` : ""}${stopped}`
      : `Not found: \`${name}\` is not on PATH or in the usual install locations.`,
  };
}

/**
 * Is the CLI signed in? Cheap evidence only, never a model call:
 *  - codex has `codex login status`; a version without it falls back to ~/.codex/auth.json
 *  - claude keeps its sign-in in ~/.claude/.credentials.json (or `oauthAccount`
 *    in ~/.claude.json); macOS uses the Keychain, so there it stays "unknown"
 *  - gemini keeps ~/.gemini/oauth_creds.json; no file can still mean an API key
 * Returns `{ authenticated: true | false | "unknown", detail }`. `detail` is our
 * own fixed text, never the CLI's output: /healthz hands it to the page, and
 * `codex login status` prints part of the API key it signed in with.
 */
export function probeAuth(kind, cli, overrides = {}) {
  const d = withDeps(overrides);
  const unknown = (detail = "") => ({ authenticated: "unknown", detail });
  if (!cli?.path) return unknown();
  const has = (...parts) => d.existsSync(join(d.home, ...parts));

  if (kind === "codex") {
    const result = d.spawnSync(cli.command, [...cli.prefixArgs, "login", "status"], {
      shell: false,
      windowsHide: true,
      timeout: AUTH_TIMEOUT_MS,
      encoding: "utf8",
      env: cli.prefixArgs.length ? { ...d.env, ELECTRON_RUN_AS_NODE: "1" } : d.env,
    });
    if (result?.error)
      return result.error.code === "ETIMEDOUT"
        ? unknown(`\`codex login status\` did not answer within ${AUTH_TIMEOUT_MS / 1000} seconds`)
        : unknown(`could not run \`codex login status\`: ${redactSecrets(result.error.message)}`);
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    const unsupported = /unrecogni[sz]ed|unexpected argument|unknown (command|subcommand)|invalid subcommand/i.test(text);
    if (!unsupported) {
      if (/not (logged|signed) in/i.test(text) || (result.status !== 0 && /log ?in|auth/i.test(text)))
        return { authenticated: false, detail: "Not signed in" };
      return result.status === 0
        ? { authenticated: true, detail: "Signed in (codex login status)" }
        : unknown(`\`codex login status\` exited with code ${result.status}`);
    }
    return has(".codex", "auth.json")
      ? { authenticated: true, detail: "Found ~/.codex/auth.json" }
      : { authenticated: false, detail: "No ~/.codex/auth.json" };
  }

  if (kind === "claude") {
    if (has(".claude", ".credentials.json")) return { authenticated: true, detail: "Found ~/.claude/.credentials.json" };
    try {
      if (/"oauthAccount"\s*:\s*\{/.test(d.readFileSync(join(d.home, ".claude.json"), "utf8")))
        return { authenticated: true, detail: "Signed-in account recorded in ~/.claude.json" };
    } catch {
      /* no config file */
    }
    return d.platform === "darwin"
      ? unknown("Claude keeps its sign-in in the macOS Keychain, which Study Hub does not read")
      : { authenticated: false, detail: "No saved sign-in found in ~/.claude" };
  }

  if (kind === "gemini")
    return has(".gemini", "oauth_creds.json")
      ? { authenticated: true, detail: "Found ~/.gemini/oauth_creds.json" }
      : unknown("No saved Google sign-in in ~/.gemini (an API key would not show up here)");

  return unknown();
}

/** Only what a CLI needs. Provider API keys are deliberately absent. */
function childEnv(extra = {}) {
  const allow = [
    "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "windir",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SHELL", "COMSPEC", "PATHEXT", "NODE_OPTIONS",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  ];
  const env = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, extra);
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}

/** Runs the CLI once; the prompt goes on stdin, never argv. */
export function runCli(cli, kind, prompt, model, webAccess) {
  return new Promise((resolve, reject) => {
    if (!cli?.path)
      return reject({
        code: "cli_not_found",
        message: cli?.error || `Could not find the \`${kind}\` command.`,
        detail: `Searched: ${cli?.searched?.join(", ") || "nothing"}`,
      });

    const settings = CLI_SETTINGS[kind];
    const args = [...cli.prefixArgs, ...(webAccess && settings.webArgs ? settings.webArgs : settings.args)];
    if (model && settings.modelFlag) args.push(settings.modelFlag, model);

    const cwd = mkdtempSync(join(tmpdir(), "studyhub-host-"));
    let child;
    try {
      child = spawn(cli.command, args, {
        shell: false,
        cwd,
        env: childEnv(cli.prefixArgs.length ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rmSync(cwd, { recursive: true, force: true });
      return reject({ code: "cli_incompatible", message: `\`${kind}\` could not be started: ${redactSecrets(error.message)}` });
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      else if (!killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      // ENOENT: the executable vanished since it was found — typically the
      // desktop app updated itself into a new version folder.
      if (error.code === "ENOENT")
        return reject({ code: "cli_moved", message: `\`${kind}\` is no longer where it was found.` });
      reject({ code: "cli_incompatible", message: `\`${kind}\` could not be started: ${redactSecrets(error.message)}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      // Some CLIs print their error on stdout (claude: "Invalid API key · Please run /login").
      const output = redactSecrets(stderr.trim() || stdout.trim());
      const said = summariseFailure(output);
      if (killed)
        return reject({
          code: "timeout",
          message: `\`${kind}\` did not finish within 3 minutes${said ? `; its last message was: ${said}` : ""}.`,
          detail: output.slice(0, 900),
        });
      if (status !== 0) {
        const noise = output.toLowerCase();
        const code = /log ?in|logged in|auth|credential|session expired|not signed|unauthori[sz]ed|invalid api key|oauth|\b401\b/.test(noise)
          ? "cli_not_authenticated"
          : /rate.?limit|quota|too many requests|usage limit/.test(noise)
            ? "rate_limited"
            : "cli_incompatible";
        return reject({
          code,
          message:
            code === "cli_not_authenticated"
              ? `\`${kind}\` is not signed in${said ? ` (${said})` : ""}. Sign in to ${CLI_APPS[kind] || kind}, then retry.`
              : code === "rate_limited"
                ? `\`${kind}\` hit a usage limit${said ? `: ${said}` : ""}.`
                : `\`${kind}\` failed with exit code ${status}${said ? `: ${said}` : ""}.`,
          detail: output.slice(0, 900),
        });
      }
      const text = extractText(stdout);
      if (!text)
        return reject({
          code: "cli_incompatible",
          message: `\`${kind}\` finished but returned no text${said ? `: ${said}` : ""}.`,
          detail: redactSecrets(stderr.trim()).slice(0, 900),
        });
      resolve(text);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

/** Plain text or a stream of JSON envelopes, depending on CLI version and flags. */
function extractText(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  const pieces = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const event = JSON.parse(candidate);
      const text =
        event.result ??
        event.text ??
        (typeof event.content === "string" ? event.content : null) ??
        (Array.isArray(event.content) ? event.content.map((block) => block?.text || "").join("") : null) ??
        event.message?.content?.map?.((block) => block?.text || "").join("") ??
        null;
      if (typeof text === "string" && text.trim()) pieces.push(text);
    } catch {
      /* not an envelope */
    }
  }
  return pieces.length ? pieces.join("\n").trim() : trimmed;
}
