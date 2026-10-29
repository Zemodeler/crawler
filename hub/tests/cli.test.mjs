/**
 * CLI detection and diagnostics: how findCli copes with Windows npm shims, a
 * stale PATH, slow or broken installs, how the auth probe reads "signed in",
 * and that a failed run reports the CLI's own words. The machine is mocked
 * (spawnSync, existsSync, readFileSync, platform, env); runCli runs a real
 * throwaway script instead of a real model.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { cliSearchDirs, findCli, probeAuth, redactSecrets, runCli, summariseFailure } from "../host/cli.mjs";

const { describeCli } = await import("../lib/ai/cli-diagnostics.ts");

const HOME = join(tmpdir(), "fake-home");
const APPDATA = join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = join(HOME, "AppData", "Local");

/**
 * A pretend machine: `files` exist, `shims` give a .cmd's text, `run` answers
 * spawnSync, and the clock only moves when a CLI run takes `elapsed` ms.
 */
function machine({ files = [], shims = {}, run, platform = "win32", env = {}, registry = {}, elapsed } = {}) {
  let clock = 0;
  const present = new Set(files.map((file) => file.toLowerCase()));
  for (const file of Object.keys(shims)) present.add(file.toLowerCase());
  const calls = [];
  return {
    calls,
    deps: {
      platform,
      home: HOME,
      execPath: join(tmpdir(), "node.exe"),
      now: () => clock,
      env: { PATH: "", APPDATA, LOCALAPPDATA, ...env },
      existsSync: (path) => present.has(String(path).toLowerCase()),
      readFileSync: (path) => {
        const text = shims[path];
        if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return text;
      },
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "reg") {
          const key = args[1];
          return { status: registry[key] ? 0 : 1, stdout: registry[key] || "", stderr: "" };
        }
        if (elapsed) clock += elapsed(options);
        return run ? run(command, args, options) : { status: 0, stdout: "1.2.3\n", stderr: "" };
      },
    },
  };
}

const npmShim = (script) => `@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%dp0%\\${script}" %*\r\n`;

test("a .cmd npm shim is run through node, and the extensionless sh script `where` lists first is skipped", () => {
  const bin = join(APPDATA, "npm");
  const script = join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  const { deps, calls } = machine({
    env: { PATH: bin },
    files: [join(bin, "codex"), script],
    shims: { [join(bin, "codex.cmd")]: npmShim("node_modules\\@openai\\codex\\bin\\codex.js") },
  });

  const found = findCli("codex", deps);

  assert.equal(found.path, join(bin, "codex.cmd"));
  assert.equal(found.command, deps.execPath);
  assert.deepEqual(found.prefixArgs, [script]);
  assert.equal(found.version, "1.2.3");
  assert.equal(found.error, null);
  const versionCall = calls.find((call) => call.command === deps.execPath);
  assert.deepEqual(versionCall.args, [script, "--version"]);
  assert.equal(versionCall.options.shell, false);
  assert.equal(versionCall.options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(!calls.some((call) => call.command === join(bin, "codex")), "never spawned the sh script");
});

test("an npm shim that points at a native .exe runs that exe, not node", () => {
  const bin = join(APPDATA, "npm");
  const exe = join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const { deps, calls } = machine({
    env: { PATH: bin },
    files: [exe],
    shims: { [join(bin, "claude.cmd")]: npmShim("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe") },
  });

  const found = findCli("claude", deps);

  assert.equal(found.command, exe);
  assert.deepEqual(found.prefixArgs, []);
  assert.equal(calls.find((call) => call.command === exe).options.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("a PATH the app started with is topped up from the registry", () => {
  const tools = join(tmpdir(), "late-tools");
  const exe = join(tools, "codex.exe");
  const { deps } = machine({
    env: { PATH: join(tmpdir(), "nothing-here"), TOOLS: tools },
    files: [exe],
    registry: { "HKCU\\Environment": "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %TOOLS%;C:\\Other\r\n" },
  });

  const found = findCli("codex", deps);

  assert.equal(found.path, exe);
});

test("WinGet and desktop-app install locations are searched when PATH has nothing", () => {
  const link = join(LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codex.exe");
  const { deps } = machine({ files: [link] });
  assert.equal(findCli("codex", deps).path, link);

  const local = join(HOME, ".local", "bin", "claude.exe");
  assert.equal(findCli("claude", machine({ files: [local] }).deps).path, local);
});

test("the Microsoft Store Claude app's bundled CLI is found under Claude-Data", () => {
  const local = mkdtempSync(join(tmpdir(), "claude-store-"));
  const exe = join(local, "Claude-Data", "claude_pzs8", "claude-code", "2.1.308", "c17a", "claude.exe");
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  try {
    const { deps } = machine({ files: [exe], env: { LOCALAPPDATA: local } });
    assert.equal(findCli("claude", deps).path, exe);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});

test("a CLI that is nowhere says so", () => {
  const { deps } = machine();
  const found = findCli("claude", deps);
  assert.equal(found.path, null);
  assert.equal(found.failedPath, null);
  assert.match(found.error, /Not found/);
  assert.ok(found.searched.length > 3);
});

test("a CLI that times out is reported as timed out, with where it was", () => {
  const exe = join(HOME, ".local", "bin", "claude.exe");
  const { deps } = machine({
    files: [exe],
    run: () => ({ error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null }),
  });
  const found = findCli("claude", deps);
  assert.equal(found.path, null);
  assert.equal(found.failedPath, exe);
  assert.match(found.error, /did not answer `--version` within 20 seconds/);
});

test("a CLI that exits non-zero reports its stderr", () => {
  const exe = join(HOME, ".local", "bin", "claude.exe");
  const { deps } = machine({
    files: [exe],
    run: () => ({ status: 3, stdout: "", stderr: "Loading config\nError: unsupported platform\n" }),
  });
  const found = findCli("claude", deps);
  assert.equal(found.path, null);
  assert.match(found.error, /exit code 3: Error: unsupported platform/);
});

test("a copy that cannot start does not stop a later one from being found", () => {
  const broken = join(HOME, ".local", "bin", "codex.exe");
  const good = join(LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codex.exe");
  const { deps } = machine({
    files: [broken, good],
    run: (command) =>
      command === broken
        ? { error: Object.assign(new Error("spawnSync UNKNOWN"), { code: "UNKNOWN" }), status: null }
        : { status: 0, stdout: "codex-cli 0.9.0\n", stderr: "" },
  });
  const found = findCli("codex", deps);
  assert.equal(found.path, good);
  assert.equal(found.version, "codex-cli 0.9.0");
});

test("a shim whose target cannot be found, and a .ps1, are explained rather than spawned", () => {
  const bin = join(APPDATA, "npm");
  const { deps, calls } = machine({
    files: [join(bin, "codex.ps1")],
    shims: { [join(bin, "codex.cmd")]: "@echo nothing useful" },
    env: { PATH: bin },
  });
  const found = findCli("codex", deps);
  assert.equal(found.path, null);
  assert.match(found.error, /npm shim whose target/);
  assert.ok(!calls.some((call) => call.command !== "reg" && call.command.endsWith(".cmd")));
});

test("one detection run reads the registry once for every kind", () => {
  const { deps, calls } = machine({ registry: { "HKCU\\Environment": "    Path    REG_SZ    C:\\Tools\r\n" } });
  const searchDirs = cliSearchDirs(deps);
  assert.ok(searchDirs.includes("C:\\Tools"));
  for (const kind of ["claude", "codex", "gemini"]) findCli(kind, { ...deps, searchDirs });
  assert.equal(calls.filter((call) => call.command === "reg").length, 2, "one query per registry key, not per kind");
});

test("slow copies of one kind stop being tried after 25 seconds", () => {
  const copies = [
    join(HOME, ".local", "bin", "codex.exe"),
    join(HOME, ".bun", "bin", "codex.exe"),
    join(HOME, ".volta", "bin", "codex.exe"),
  ];
  const { deps, calls } = machine({
    files: copies,
    elapsed: (options) => options.timeout,
    run: () => ({ error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null }),
  });
  const found = findCli("codex", deps);
  assert.deepEqual(
    calls.filter((call) => call.command !== "reg").map((call) => call.options.timeout),
    [20_000, 5_000],
    "the second copy only gets what is left, the third is not run",
  );
  assert.equal(found.path, null);
  assert.match(found.error, /within 20 seconds/);
  assert.match(found.error, /\(1 other copy failed too\.\) Stopped after 25 seconds; 1 more copy was not tried\./);
});

test("the same copy listed in different case is run once on Windows", () => {
  const link = join(LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codex.exe");
  const { deps, calls } = machine({
    env: { PATH: dirname(link).toUpperCase() },
    files: [link],
    run: () => ({ status: 1, stdout: "", stderr: "Error: broken\n" }),
  });
  const found = findCli("codex", deps);
  assert.equal(calls.filter((call) => call.command !== "reg").length, 1);
  assert.equal(found.searched.filter((path) => path.toLowerCase() === link.toLowerCase()).length, 1);
  assert.doesNotMatch(found.error, /other cop/);
});

test("on macOS and Linux PATH and the login shell are used, with no registry lookup", () => {
  // No drive letter: the PATH of a unix platform is split on colons.
  const bin = "/opt/unix-bin";
  const { deps, calls } = machine({ platform: "linux", env: { PATH: bin }, files: [join(bin, "codex")] });
  assert.equal(findCli("codex", deps).path, join(bin, "codex"));
  assert.ok(!calls.some((call) => call.command === "reg"));
});

test("codex: `login status` decides, a missing subcommand falls back to the auth file", () => {
  const cli = { path: "codex.exe", command: "codex.exe", prefixArgs: [] };
  const status = (result, files = []) => probeAuth("codex", cli, machine({ run: () => result, files }).deps);

  assert.deepEqual(status({ status: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }), {
    authenticated: true,
    detail: "Signed in (codex login status)",
  });
  assert.deepEqual(status({ status: 1, stdout: "", stderr: "Not logged in\n" }), {
    authenticated: false,
    detail: "Not signed in",
  });
  const unsupported = { status: 2, stdout: "", stderr: "error: unrecognized subcommand 'status'\n" };
  assert.equal(status(unsupported, [join(HOME, ".codex", "auth.json")]).authenticated, true);
  assert.equal(status(unsupported).authenticated, false);
  const timedOut = status({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null });
  assert.equal(timedOut.authenticated, "unknown");
  assert.match(timedOut.detail, /did not answer/);
});

test("codex: an API key quoted by `login status` never reaches the probe result", () => {
  const cli = { path: "codex.exe", command: "codex.exe", prefixArgs: [] };
  const key = "sk-proj-***abcd1";
  const outputs = [
    { status: 0, stdout: `Logged in using an API key - ${key}\n`, stderr: "" },
    { status: 1, stdout: "", stderr: `Not logged in (stale key ${key})\n` },
    { status: 1, stdout: `Error: auth failed for ${key}\n`, stderr: "" },
    { status: 5, stdout: `warning: ${key}\n`, stderr: "" },
    { error: new Error(`spawnSync codex.exe EACCES ${key}`), status: null },
  ];
  for (const result of outputs) {
    const probed = JSON.stringify(probeAuth("codex", cli, machine({ run: () => result }).deps));
    assert.doesNotMatch(probed, /sk-proj|abcd1/, probed);
  }
});

test("CLI text that reaches an error field has key-like strings redacted", () => {
  assert.equal(redactSecrets("using sk-proj-***abcd1 now"), "using [redacted] now");
  assert.equal(redactSecrets("KEY_live_1234 and key-abcd"), "[redacted] and [redacted]");
  assert.equal(redactSecrets("Invalid API key · Please run /login"), "Invalid API key · Please run /login");
  assert.equal(summariseFailure("Error: bad key sk-ant-api03-xyzw"), "Error: bad key [redacted]");

  const exe = join(HOME, ".local", "bin", "claude.exe");
  const { deps } = machine({ files: [exe], run: () => ({ status: 1, stdout: "", stderr: "Error: sk-ant-secret-0000\n" }) });
  assert.doesNotMatch(findCli("claude", deps).error, /sk-ant|0000/);
});

test("claude: credentials file or recorded account means signed in; none is signed out except on macOS", () => {
  const cli = { path: "claude.exe", command: "claude.exe", prefixArgs: [] };
  const probe = (options) => probeAuth("claude", cli, machine(options).deps);

  assert.equal(probe({ files: [join(HOME, ".claude", ".credentials.json")] }).authenticated, true);
  const account = { [join(HOME, ".claude.json")]: '{"oauthAccount": {"emailAddress": "a@b.c"}}' };
  assert.equal(probe({ shims: account }).authenticated, true);
  assert.equal(probe({ shims: { [join(HOME, ".claude.json")]: '{"theme":"dark"}' } }).authenticated, false);
  assert.equal(probe({}).authenticated, false);
  assert.equal(probe({ platform: "darwin" }).authenticated, "unknown");
});

test("gemini: an oauth file means signed in, otherwise unknown; a missing CLI is unknown", () => {
  const cli = { path: "gemini.exe", command: "gemini.exe", prefixArgs: [] };
  assert.equal(probeAuth("gemini", cli, machine({ files: [join(HOME, ".gemini", "oauth_creds.json")] }).deps).authenticated, true);
  assert.equal(probeAuth("gemini", cli, machine().deps).authenticated, "unknown");
  assert.equal(probeAuth("claude", { path: null }, machine().deps).authenticated, "unknown");
});

test("summariseFailure picks the line that explains it and strips colour codes", () => {
  assert.equal(summariseFailure("Loading…\n\u001b[31mError: boom\u001b[0m\nat x"), "Error: boom");
  assert.equal(summariseFailure("one\ntwo"), "two");
  assert.equal(summariseFailure(""), "");
});

/** A CLI that is a node script printing what the test says, then exiting with `status`. */
function fakeCli(body) {
  const dir = mkdtempSync(join(tmpdir(), "fake-cli-"));
  const script = join(dir, "cli.mjs");
  writeFileSync(script, body);
  return {
    cli: { path: script, command: process.execPath, prefixArgs: [script], searched: [] },
    cleanup: () => rmSync(dirname(script), { recursive: true, force: true }),
  };
}

test("a failed run surfaces the CLI's own message, whichever stream it used", async () => {
  const signedOut = fakeCli(`process.stdout.write("Invalid API key · Please run /login\\n"); process.exit(1);`);
  const broken = fakeCli(`process.stderr.write("warming up\\nError: model overloaded_error\\n"); process.exit(2);`);
  const silent = fakeCli(`process.exit(0);`);
  const revoked = fakeCli(
    `process.stderr.write("2026-10-28T23:06:54Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Encountered invalidated oauth token for user\\n"); process.exit(1);`,
  );
  try {
    await assert.rejects(runCli(revoked.cli, "codex", "hi"), (error) => {
      assert.equal(error.code, "cli_not_authenticated");
      assert.equal(error.message, "Your Codex sign-in has expired or was signed out, so `codex` was refused.");
      assert.match(error.hint, /codex logout.*codex login/);
      assert.match(error.detail, /invalidated oauth token/);
      return true;
    });
    await assert.rejects(runCli(signedOut.cli, "claude", "hi"), (error) => {
      assert.equal(error.code, "cli_not_authenticated");
      assert.match(error.message, /Invalid API key · Please run \/login/);
      return true;
    });
    await assert.rejects(runCli(broken.cli, "codex", "hi"), (error) => {
      assert.equal(error.code, "cli_incompatible");
      assert.match(error.message, /exit code 2: Error: model overloaded_error/);
      assert.match(error.detail, /warming up/);
      return true;
    });
    await assert.rejects(runCli(silent.cli, "codex", "hi"), (error) => {
      assert.equal(error.code, "cli_incompatible");
      assert.match(error.message, /returned no text/);
      return true;
    });
  } finally {
    for (const fake of [signedOut, broken, silent, revoked]) fake.cleanup();
  }
});

test("a successful run returns the text; a missing CLI rejects with the detection error", async () => {
  const ok = fakeCli(`process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("answer\\n"));`);
  try {
    assert.equal(await runCli(ok.cli, "claude", "prompt"), "answer");
  } finally {
    ok.cleanup();
  }
  await assert.rejects(
    runCli({ path: null, searched: ["a"], error: "Not found: `claude` is not on PATH." }, "claude", "x"),
    (error) => error.code === "cli_not_found" && /Not found: `claude`/.test(error.message),
  );
});

test("the diagnostics rows give a verdict, the real error and a fix", () => {
  const ready = describeCli("claude", { present: true, path: "C:\\c.exe", version: "2.1.0", authenticated: true });
  assert.equal(ready.verdict, "ready");
  assert.equal(ready.fix, null);

  const signedOut = describeCli("codex", { present: true, path: "c", version: "1", authenticated: false, authDetail: "Not logged in" });
  assert.equal(signedOut.verdict, "signed-out");
  assert.equal(signedOut.fix.command, "codex login");

  const unknown = describeCli("gemini", { present: true, path: "g", version: "1", authenticated: "unknown" });
  assert.equal(unknown.verdict, "unchecked-auth");

  const missing = describeCli("codex", { present: false, version: null, error: "Not found: `codex` is not on PATH." });
  assert.equal(missing.verdict, "missing");
  assert.equal(missing.fix.command, "npm install -g @openai/codex");
  assert.match(missing.error, /Not found/);

  const broken = describeCli("claude", { present: false, path: "C:\\c.cmd", version: null, error: "Found C:\\c.cmd but it did not answer" });
  assert.equal(broken.verdict, "broken");
  assert.equal(broken.path, "C:\\c.cmd");
  assert.equal(broken.fix.command, "npm install -g @anthropic-ai/claude-code");
});

test("a broken desktop-app or WinGet copy is not sent to npm to be fixed", () => {
  const brokenAt = (kind, path) => describeCli(kind, { present: false, path, version: null, error: "Found it but it failed" });

  const claudeApp = brokenAt("claude", join(APPDATA, "Claude", "claude-code", "2.1.0", "claude.exe"));
  assert.equal(claudeApp.verdict, "broken");
  assert.match(claudeApp.fix.text, /Claude desktop app/);
  assert.equal(claudeApp.fix.command, null);

  const storeApp = brokenAt("claude", join(LOCALAPPDATA, "Claude-Data", "claude_pzs8", "claude-code", "2.1.3", "c17a", "claude.exe"));
  assert.match(storeApp.fix.text, /Claude desktop app/);
  assert.equal(storeApp.fix.command, null);

  const codexApp = brokenAt("codex", join(LOCALAPPDATA, "OpenAI", "Codex", "bin", "ab12", "codex.exe"));
  assert.match(codexApp.fix.text, /Codex desktop app/);
  assert.equal(codexApp.fix.command, null);

  const macApp = brokenAt("claude", "/Applications/Claude.app/Contents/Resources/claude");
  assert.equal(macApp.fix.command, null);

  const winget = brokenAt("codex", join(LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codex.exe"));
  assert.match(winget.fix.text, /WinGet/);
  assert.doesNotMatch(winget.fix.command, /npm/);
});
