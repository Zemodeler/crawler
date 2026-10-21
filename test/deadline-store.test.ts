import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readDeadlineFile, withDeadlineLock, withSyncLock, writeDeadlineFile } from "../src/deadline-store.ts";
import type { DeadlineFileOps } from "../src/deadline-store.ts";
import type { Deadline } from "../src/types.ts";

test("only a missing deadline file is an empty library; corrupt records are preserved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-deadline-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readDeadlineFile(root), []);
  for (const content of ["{broken", "{}", "[null]", '[{"id":"partial"}]']) {
    await writeFile(join(root, "Deadlines.json"), content);
    await assert.rejects(readDeadlineFile(root), /Cannot read/);
    assert.equal(await readFile(join(root, "Deadlines.json"), "utf8"), content);
  }
});

const sample = (id: string): Deadline => ({ id, module: "TST101U", year: "2026-27", title: id,
  kind: "other", status: "tbc", due: null, sources: [], history: [] });
const denied = (code: string) => Object.assign(new Error(`${code}: denied`), { code });

test("nested malformed records are rejected without changing the student's file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-deadline-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const bad of [
    { ...sample("one"), due: { iso: "not-a-date", allDay: false, tz: "Europe/London" } },
    { ...sample("one"), sources: [null] },
    { ...sample("one"), history: [{ field: "due" }] },
    { ...sample("one"), done: "yes" },
    [sample("one"), sample("one")],
  ]) {
    const content = JSON.stringify(Array.isArray(bad) ? bad : [bad]);
    await writeFile(join(root, "Deadlines.json"), content);
    await assert.rejects(readDeadlineFile(root), /invalid deadline records/);
    assert.equal(await readFile(join(root, "Deadlines.json"), "utf8"), content);
  }
});

test("read permission errors propagate; failed writes and renames keep the old file and remove temps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-deadline-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "Deadlines.json");
  await writeFile(target, `${JSON.stringify([sample("old")])}\n`);
  const before = await readFile(target, "utf8");
  await assert.rejects(readDeadlineFile(root, { readFile: async () => { throw denied("EACCES"); } }), { code: "EACCES" });
  const failures: Partial<DeadlineFileOps>[] = [
    { writeFile: async () => { throw denied("ENOSPC"); } },
    { rename: async () => { throw denied("EPERM"); } },
  ];
  for (const io of failures) {
    await assert.rejects(writeDeadlineFile(root, [sample("new")], io), /denied/);
    assert.equal(await readFile(target, "utf8"), before);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
  }
});

test("an abandoned lock is never stolen by age and recovery advice requires closing writers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-deadline-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ".crawler", "sync.lock");
  await mkdir(lock, { recursive: true });
  await assert.rejects(withSyncLock(root, async () => assert.fail("entered stale lock")),
    (error: unknown) => error instanceof Error && error.message.includes("close all Crawler and Study Hub processes") && error.message.includes(lock));
  assert.ok(await stat(lock));
  await rm(lock, { recursive: true });
  await withSyncLock(root, async () => {});
});

test("concurrent transactions see preceding writes and release the lock after failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-deadline-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const append = (id: string) => withDeadlineLock(root, async () => {
    const deadlines = await readDeadlineFile(root);
    await new Promise((resolve) => setTimeout(resolve, 10));
    deadlines.push({ id, module: "TST101U", year: "2026-27", title: id, kind: "other", status: "tbc", due: null, sources: [], history: [] } satisfies Deadline);
    await writeDeadlineFile(root, deadlines);
  });
  await Promise.all([append("one"), append("two"), append("three")]);
  assert.deepEqual((await readDeadlineFile(root)).map((d) => d.id).sort(), ["one", "three", "two"]);
  await assert.rejects(withDeadlineLock(root, async () => { throw new Error("failed transaction"); }), /failed transaction/);
  await append("after-failure");
  assert.equal((await readDeadlineFile(root)).length, 4);
  await assert.rejects(stat(join(root, ".crawler", "deadlines.lock")), { code: "ENOENT" });
});

test("a different process excludes full syncs and serializes deadline transactions", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-process-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ["sync", "deadlines"]) {
    const child = fork(new URL("./fixtures/hold-storage-lock.mjs", import.meta.url), [root, kind], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await once(child, "message");
    if (kind === "sync") {
      await assert.rejects(withSyncLock(root, async () => assert.fail("overlapping sync entered")), /already running/);
    } else {
      let entered = false;
      const pending = withDeadlineLock(root, async () => { entered = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(entered, false);
      const exited = once(child, "exit");
      child.send("release");
      await pending;
      await exited;
      continue;
    }
    const exited = once(child, "exit");
    child.send("release");
    await exited;
    await withSyncLock(root, async () => {});
  }
});
