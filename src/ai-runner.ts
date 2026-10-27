/** CLI-backed AI with isolated working directories and no provider API keys. */
import type { AiRunner } from "./types.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const RUN_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const CLI_ARGS = {
  claude: ["--print", "--output-format", "text", "--disallowed-tools", "Bash,PowerShell,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task"],
  codex: ["exec", "--sandbox", "read-only", "--skip-git-repo-check"],
  gemini: ["--output-format", "text", "--approval-mode", "default"],
};
type CliName = "claude" | "codex" | "gemini";
export type FoundCli = {
  path: string | null; command: string | null; prefixArgs: string[];
  version: string | null; searched: string[];
};
/**
 * Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980), and a shell
 * is not acceptable here. An npm shim only runs `node "<script>" %*`, so run
 * that script with the Node we are already in.
 */
function resolveWindowsShim(cmdPath: string) {
  if (!/\.cmd$/i.test(cmdPath)) return null;
  try {
    const match = readFileSync(cmdPath, "utf8").match(/%dp0%\\+(.+?\.js)/i);
    if (!match?.[1]) return null;
    const script = join(dirname(cmdPath), match[1].replace(/\\+/g, "/"));
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/** Newest-first executables matching `<root>/<a>/<b>/<file>`, by modified time. */
function nestedExecutables(root: string, depth: number, file: string) {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
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
function loginShellLookup(name: CliName) {
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

function candidates(name: CliName) {
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

export function findCli(name: CliName): FoundCli {
  const searched: string[] = [];
  const tryRun = (cmd: string) => {
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
        env: childEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      });
      if (result.error || result.status !== 0) return null;
      return {
        path: cmd,
        command,
        prefixArgs,
        version: (result.stdout || result.stderr || "").trim().split("\n")[0]!.slice(0, 80),
      };
    } catch {
      return null;
    }
  };

  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const found = spawnSync(locator, [name], { shell: false, windowsHide: true, encoding: "utf8" });
    const first = (found.stdout || "").split(/\r?\n/)[0]!.trim();
    if (first) {
      const hit = tryRun(first);
      if (hit) return { ...hit, searched };
    }
  } catch {
    /* no locator; fall through */
  }
  for (const candidate of candidates(name)) {
    const hit = tryRun(candidate!);
    if (hit) return { ...hit, searched };
  }
  return { path: null, command: null, prefixArgs: [], version: null, searched };
}

/** Only what a CLI needs. Provider API keys are deliberately absent. */
function childEnv(extra: NodeJS.ProcessEnv = {}) {
  const allow = [
    "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "windir",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SHELL", "COMSPEC", "PATHEXT", "NODE_OPTIONS",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, extra);
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}


export class AiRunnerError extends Error {
  readonly code: "cli_not_found" | "cli_not_authenticated" | "rate_limited" | "timeout" | "bad_output" | "cli_incompatible";
  constructor(code: AiRunnerError["code"]) {
    super(`AI CLI request failed: ${code}.`);
    this.name = "AiRunnerError";
    this.code = code;
  }
}

/** Accept a complete JSON value, a JSON fence, or the first balanced container. */
function parseAnswer(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* try wrapped output */ }
  const fence = /```json\s*([\s\S]*?)```/i.exec(raw);
  if (fence) {
    try { return JSON.parse(fence[1]!); } catch { throw new AiRunnerError("bad_output"); }
  }
  const start = raw.search(/[\[{]/);
  if (start >= 0) {
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") stack.push(c);
      else if (c === "}" || c === "]") {
        if (stack.pop() !== (c === "}" ? "{" : "[")) break;
        if (!stack.length) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new AiRunnerError("bad_output");
}

export function createCliAiRunner(opts: {
  prefer?: CliName;
  spawn?: typeof spawn;
  find?: (name: CliName) => FoundCli;
  rm?: typeof rmSync;
} = {}): AiRunner {
  const discover = () => {
    const first = opts.prefer ?? "claude";
    for (const kind of [first, ...(["claude", "codex", "gemini"] as CliName[]).filter((k) => k !== first)]) {
      const cli = (opts.find ?? findCli)(kind);
      if (cli.path && cli.command) return { kind, cli };
    }
    return null;
  };
  return {
    async available() { return { cli: discover()?.kind ?? null }; },
    async structured<T>({ system, prompt, schema }: { system: string; prompt: string; schema: object }): Promise<T> {
      const selected = discover();
      if (!selected) throw new AiRunnerError("cli_not_found");
      const { cli, kind } = selected;
      const input = `${system}\n\n${prompt}\n\nAnswer with JSON only, matching this schema:\n${JSON.stringify(schema)}`;
      const output = await new Promise<string>((resolve, reject) => {
        let cwd: string;
        try { cwd = mkdtempSync(join(tmpdir(), "crawler-ai-")); }
        catch { reject(new AiRunnerError("cli_incompatible")); return; }
        let child: ReturnType<typeof spawn>;
        let alive = false;
        // Never throws: on Windows a live child holds its directory, so a failed
        // removal is retried once after the child has closed.
        const remove = () => { (opts.rm ?? rmSync)(cwd, { recursive: true, force: true }); };
        const cleanup = () => {
          try { remove(); }
          catch {
            if (!alive) return;
            child.once("close", () => { try { remove(); } catch { /* best effort */ } });
          }
        };
        try {
          child = (opts.spawn ?? spawn)(cli.command!, [...cli.prefixArgs, ...CLI_ARGS[kind]], {
            shell: false, windowsHide: true, cwd,
            env: childEnv(cli.prefixArgs.length ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch { cleanup(); reject(new AiRunnerError("cli_incompatible")); return; }
        alive = true;
        let settled = false;
        let forced: AiRunnerError["code"] | null = null;
        let bytes = 0;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const finish = (code?: AiRunnerError["code"]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          if (code) reject(new AiRunnerError(code));
          else resolve(Buffer.concat(stdout).toString("utf8"));
        };
        // Kill first: nothing below may keep the child alive. A kill that closes
        // synchronously must still settle with this code, not a close-status one.
        const stop = (code: AiRunnerError["code"]) => {
          if (settled || forced) return;
          forced = code;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          finish(code);
        };
        const timer = setTimeout(() => stop("timeout"), RUN_TIMEOUT_MS);
        const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
          if (settled || forced) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_OUTPUT_BYTES) { stop("bad_output"); return; }
          target.push(buffer);
        };
        child.stdout!.on("data", collect(stdout));
        child.stderr!.on("data", collect(stderr));
        child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "cli_not_found" : "cli_incompatible"));
        child.on("close", (status) => {
          alive = false;
          if (forced) { finish(forced); return; }
          if (status === 0) { finish(); return; }
          const noise = Buffer.concat([...stderr, ...stdout]).toString("utf8").toLowerCase();
          finish(/rate.?limit|quota|too many requests|usage limit/.test(noise) ? "rate_limited"
            : /log ?in|logged in|auth|credential|session expired|not signed/.test(noise) ? "cli_not_authenticated" : "cli_incompatible");
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(input, "utf8");
      });
      return parseAnswer(output) as T;
    },
  };
}
