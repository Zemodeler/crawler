import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { spawn as Spawn, SpawnOptions } from "node:child_process";
import { AiRunnerError, createCliAiRunner, type FoundCli } from "../src/ai-runner.ts";

const request = { system: "system secret", prompt: "document secret", schema: { type: "object" } };
const found: FoundCli = { path: "fake.exe", command: "fake.exe", prefixArgs: [], version: "1", searched: [] };
function fake(action: (child: FakeChild) => void, cli = found, rm?: typeof rmSync) {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions; input: string }[] = [];
  const children: FakeChild[] = [];
  const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    const call = { command, args, options, input: "" };
    calls.push(call);
    assert.deepEqual(readdirSync(options.cwd as string), []);
    child.stdin.on("data", (chunk) => { call.input += chunk.toString(); });
    child.stdin.on("finish", () => queueMicrotask(() => action(child)));
    return child;
  }) as unknown as typeof Spawn;
  return { calls, children, runner: createCliAiRunner({ spawn, find: () => cli, rm }) };
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  closeOnKill = true;
  kill() { this.killed = true; if (this.closeOnKill) this.emit("close", null); return true; }
}
function answer(text: string) { return (child: FakeChild) => { child.stdout.write(text); child.emit("close", 0); }; }
function code(expected: AiRunnerError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof AiRunnerError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(request.prompt));
    assert.ok(!error.message.includes(request.system));
    return true;
  };
}

test("claude argv, stdin, scrubbed environment and empty temporary cwd", async () => {
  const old = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, other: process.env.CRAWLER_TEST_SECRET };
  process.env.ANTHROPIC_API_KEY = "secret";
  process.env.OPENAI_API_KEY = "secret";
  process.env.CRAWLER_TEST_SECRET = "secret";
  try {
    const f = fake(answer('{}'));
    assert.deepEqual(await f.runner.available(), { cli: "claude" });
    await f.runner.structured(request);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0]!;
    assert.deepEqual(call.args, ["--print", "--output-format", "text", "--disallowed-tools", "Bash,PowerShell,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task"]);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(call.input, `${request.system}\n\n${request.prompt}\n\nAnswer with JSON only, matching this schema:\n${JSON.stringify(request.schema)}`);
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CRAWLER_TEST_SECRET"]) assert.equal(call.options.env![key], undefined);
    assert.ok(!existsSync(call.options.cwd as string));
  } finally {
    for (const [key, value] of [["ANTHROPIC_API_KEY", old.anthropic], ["OPENAI_API_KEY", old.openai], ["CRAWLER_TEST_SECRET", old.other]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});

test("codex preference and resolved npm shim prefix", async () => {
  const runner = createCliAiRunner({ prefer: "codex", find: () => found });
  assert.deepEqual(await runner.available(), { cli: "codex" });
  const calls: unknown[][] = [];
  const child = new FakeChild();
  const shimRunner = createCliAiRunner({ prefer: "codex", find: () => ({ ...found, command: process.execPath, prefixArgs: ["shim.js"] }), spawn: ((...args: unknown[]) => {
    calls.push(args);
    child.stdin.on("finish", () => queueMicrotask(() => { child.stdout.write('{}'); child.emit("close", 0); }));
    return child;
  }) as unknown as typeof Spawn });
  await shimRunner.structured(request);
  assert.deepEqual(calls[0]![1], ["shim.js", "exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.equal((calls[0]![2] as SpawnOptions).env!.ELECTRON_RUN_AS_NODE, "1");
});

for (const output of ['{"ok":true}', '```json\n{"ok":true}\n```', 'Answer: {"ok":true} done', 'Answer: [{"text":"braces } [ and escaped \\\""}] done', 'null', '42']) {
  test(`JSON extraction: ${output}`, async () => {
    const f = fake(answer(output));
    const result = await f.runner.structured(request);
    if (output.includes('"ok"')) assert.deepEqual(result, { ok: true });
    else if (output.startsWith("Answer")) assert.ok(Array.isArray(result));
    else assert.equal(result, JSON.parse(output));
  });
}
for (const output of ["no JSON", "{broken}", '[{"x":1}', '```json\nno\n```']) {
  test(`bad output: ${output}`, async () => { await assert.rejects(fake(answer(output)).runner.structured(request), code("bad_output")); });
}
for (const [noise, expected] of [["please log in", "cli_not_authenticated"], ["quota exceeded", "rate_limited"], ["unknown flag document secret", "cli_incompatible"]] as const) {
  test(`error mapping: ${expected}`, async () => {
    const f = fake((child) => { child.stderr.write(noise); child.emit("close", 1); });
    await assert.rejects(f.runner.structured(request), code(expected));
    assert.ok(!existsSync(f.calls[0]!.options.cwd as string));
  });
}
test("missing CLI and preference fallback", async () => {
  const missing = { ...found, path: null, command: null };
  const runner = createCliAiRunner({ find: () => missing });
  assert.deepEqual(await runner.available(), { cli: null });
  await assert.rejects(runner.structured(request), code("cli_not_found"));
  assert.deepEqual(await createCliAiRunner({ find: (name) => name === "claude" ? missing : found }).available(), { cli: "codex" });
});
test("spawn errors are sanitized and cleaned up", async () => {
  for (const errorCode of ["ENOENT", "EACCES"]) {
    const f = fake((child) => child.emit("error", Object.assign(new Error(request.prompt), { code: errorCode })));
    await assert.rejects(f.runner.structured(request), code(errorCode === "ENOENT" ? "cli_not_found" : "cli_incompatible"));
    assert.ok(!existsSync(f.calls[0]!.options.cwd as string));
  }
  await assert.rejects(createCliAiRunner({ find: () => found, spawn: (() => { throw new Error(request.prompt); }) as typeof Spawn }).structured(request), code("cli_incompatible"));
});
test("combined byte cap kills on a single oversized chunk", async () => {
  const f = fake((child) => { child.stderr.write(Buffer.alloc(2 * 1024 * 1024)); child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1)); });
  await assert.rejects(f.runner.structured(request), code("bad_output"));
  assert.equal(f.children[0]!.killed, true);
  assert.ok(!existsSync(f.calls[0]!.options.cwd as string));
});
test("three-minute timeout kills and cleans up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake(() => {});
  const pending = f.runner.structured(request);
  const rejected = assert.rejects(pending, code("timeout"));
  t.mock.timers.tick(179_999);
  assert.equal(f.children[0]!.killed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.children[0]!.killed, true);
  assert.ok(!existsSync(f.calls[0]!.options.cwd as string));
});

const failingRm = (calls: string[]) => ((path: string) => { calls.push(path); throw new Error("EBUSY"); }) as unknown as typeof rmSync;
test("timeout still kills the child and rejects when directory removal throws", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const removed: string[] = [];
  const f = fake(() => {}, found, failingRm(removed));
  const rejected = assert.rejects(f.runner.structured(request), code("timeout"));
  t.mock.timers.tick(180_000);
  await rejected;
  assert.equal(f.children[0]!.killed, true);
  assert.ok(removed.length >= 1);
});
test("output cap still kills the child and rejects when directory removal throws", async () => {
  const removed: string[] = [];
  const f = fake((child) => { child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1)); }, found, failingRm(removed));
  await assert.rejects(f.runner.structured(request), code("bad_output"));
  assert.equal(f.children[0]!.killed, true);
  assert.ok(removed.length >= 1);
});
test("kill that throws still settles once with the cap error", async () => {
  const f = fake((child) => { child.kill = () => { throw new Error("ESRCH"); }; child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1)); });
  await assert.rejects(f.runner.structured(request), code("bad_output"));
});
test("failed removal while the child is alive is retried once on close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const removed: string[] = [];
  let real = false;
  const rm = ((path: string, options: object) => {
    removed.push(path);
    if (!real) throw new Error("EBUSY");
    rmSync(path, options);
  }) as unknown as typeof rmSync;
  const f = fake((child) => { child.closeOnKill = false; }, found, rm);
  const rejected = assert.rejects(f.runner.structured(request), code("timeout"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(180_000);
  await rejected;
  assert.equal(f.children[0]!.killed, true);
  assert.equal(removed.length, 1);
  real = true;
  f.children[0]!.emit("close", null);
  assert.equal(removed.length, 2);
  assert.ok(!existsSync(f.calls[0]!.options.cwd as string));
});
