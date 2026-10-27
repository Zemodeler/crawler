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
import { dirname, join } from "node:path";

const RUN_TIMEOUT_MS = 180_000;
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

/**
 * Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980), and a shell
 * is not acceptable here. An npm shim only runs `node "<script>" %*`, so run
 * that script with the Node we are already in.
 */
function resolveWindowsShim(cmdPath) {
  if (!/\.cmd$/i.test(cmdPath)) return null;
  try {
    const match = readFileSync(cmdPath, "utf8").match(/%dp0%\\+(.+?\.js)/i);
    if (!match) return null;
    const script = join(dirname(cmdPath), match[1].replace(/\\+/g, "/"));
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
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
function loginShellLookup(name) {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const result = spawnSync(shell, ["-lc", `command -v ${name}`], {
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

function candidates(name) {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(localAppData, "Programs", name, `${name}.exe`),
      join(appData, "npm", `${name}.cmd`),
      join(home, ".local", "bin", `${name}.exe`),
      join(home, ".bun", "bin", `${name}.exe`),
      join(home, `.${name}`, "local", `${name}.exe`),
      // Bundled with the desktop apps: claude-code/<version>/<hash>/claude.exe
      // and OpenAI/Codex/bin/<hash>/codex.exe.
      ...(name === "claude" ? nestedExecutables(join(appData, "Claude", "claude-code"), 2, "claude.exe") : []),
      ...(name === "codex" ? nestedExecutables(join(localAppData, "OpenAI", "Codex", "bin"), 1, "codex.exe") : []),
    ];
  }
  return [
    loginShellLookup(name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    join(home, ".local", "bin", name),
    join(home, ".npm-global", "bin", name),
    join(home, ".bun", "bin", name),
    join(home, `.${name}`, "local", name),
  ].filter(Boolean);
}

export function findCli(name) {
  const searched = [];
  const tryRun = (cmd) => {
    searched.push(cmd);
    if (!existsSync(cmd) && /[\\/]/.test(cmd)) return null;
    const script = resolveWindowsShim(cmd);
    const command = script ? process.execPath : cmd;
    const prefixArgs = script ? [script] : [];
    try {
      const result = spawnSync(command, [...prefixArgs, "--version"], {
        shell: false,
        windowsHide: true,
        timeout: 12_000,
        encoding: "utf8",
        // Electron's own binary is process.execPath inside the shell; make it
        // behave as plain Node when running an npm shim's script.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      if (result.error || result.status !== 0) return null;
      return {
        path: cmd,
        command,
        prefixArgs,
        version: (result.stdout || result.stderr || "").trim().split("\n")[0].slice(0, 80),
      };
    } catch {
      return null;
    }
  };

  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const found = spawnSync(locator, [name], { shell: false, windowsHide: true, encoding: "utf8" });
    const first = (found.stdout || "").split(/\r?\n/)[0].trim();
    if (first) {
      const hit = tryRun(first);
      if (hit) return { ...hit, searched };
    }
  } catch {
    /* no locator; fall through */
  }
  for (const candidate of candidates(name)) {
    const hit = tryRun(candidate);
    if (hit) return { ...hit, searched };
  }
  return { path: null, command: null, prefixArgs: [], version: null, searched };
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
        message: `Could not find the \`${kind}\` command.`,
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
      return reject({ code: "cli_incompatible", message: error.message });
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
      reject({ code: "cli_incompatible", message: error.message });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      if (killed) return reject({ code: "timeout", message: `\`${kind}\` did not finish within 3 minutes.` });
      if (status !== 0) {
        const noise = stderr.toLowerCase();
        const code = /log ?in|logged in|auth|credential|session expired|not signed/.test(noise)
          ? "cli_not_authenticated"
          : /rate.?limit|quota|too many requests|usage limit/.test(noise)
            ? "rate_limited"
            : "cli_incompatible";
        return reject({
          code,
          message:
            code === "cli_not_authenticated"
              ? `\`${kind}\` is not signed in. Open ${CLI_APPS[kind] || kind} and sign in, then retry.`
              : `\`${kind}\` exited with code ${status}.`,
          detail: stderr.trim().slice(0, 900),
        });
      }
      resolve(extractText(stdout));
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
