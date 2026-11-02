/**
 * AI jobs: one run per lane with the rest queued in order, cancelling queued
 * and running jobs, the text so far, saving to disk without the prompt, jobs
 * left unfinished by a restart, and pruning. The CLI is a fake runner whose
 * runs the test finishes by hand.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_JOBS, createJobManager } from "../host/jobs.mjs";

/** A runner whose runs stay open until the test resolves or rejects them. */
function fakeRunner() {
  const runs = [];
  const start = (spec, hooks) => {
    const run = { spec, hooks, cancelled: false };
    run.promise = new Promise((resolve, reject) => Object.assign(run, { resolve, reject }));
    run.cancel = () => {
      run.cancelled = true;
      run.reject({ code: "aborted", message: "cancelled" });
    };
    runs.push(run);
    return { promise: run.promise, cancel: run.cancel };
  };
  return { runs, start };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const spec = (prompt, extra = {}) => ({ kind: "claude", prompt, ...extra });

test("one job runs per lane; more queue in order and start when the lane frees", async () => {
  const { runs, start } = fakeRunner();
  const jobs = createJobManager({ start });
  const first = jobs.start(spec("one"));
  const second = jobs.start(spec("two"));
  const third = jobs.start(spec("three"));
  const packs = jobs.start(spec("pack", { lane: "background", label: "Study pack" }));

  assert.deepEqual(runs.map((run) => run.spec.prompt), ["one", "pack"]);
  assert.equal(jobs.get(first.id).status, "running");
  assert.equal(jobs.get(second.id).status, "queued");
  assert.equal(jobs.get(packs.id).lane, "background");
  assert.equal(jobs.get(packs.id).label, "Study pack");

  runs[0].resolve("answer one");
  await settle();
  const done = jobs.get(first.id);
  assert.equal(done.status, "done");
  assert.equal(done.text, "answer one");
  assert.equal(done.chars, 10);
  assert.deepEqual(runs.map((run) => run.spec.prompt), ["one", "pack", "two"]);

  runs[2].reject({ code: "rate_limited", message: "`claude` hit a usage limit.", hint: "Wait.", detail: "429", extra: "x" });
  await settle();
  const failed = jobs.get(second.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "rate_limited", message: "`claude` hit a usage limit.", hint: "Wait.", detail: "429" });
  assert.equal(failed.text, undefined);
  assert.equal(runs[3].spec.prompt, "three");
  assert.equal(jobs.get(third.id).status, "running");
});

test("cancelling: a queued job never starts, a running one is killed and the next one starts", async () => {
  const { runs, start } = fakeRunner();
  const jobs = createJobManager({ start });
  const running = jobs.start(spec("a"));
  const queued = jobs.start(spec("b"));
  const after = jobs.start(spec("c"));

  assert.equal(jobs.cancel(queued.id).status, "cancelled");
  const cancelled = jobs.cancel(running.id);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(runs[0].cancelled);
  await settle();
  assert.deepEqual(runs.map((run) => run.spec.prompt), ["a", "c"]);
  assert.equal(jobs.get(after.id).status, "running");
  assert.equal(jobs.get(running.id).status, "cancelled");
  // Cancelling a finished job changes nothing; an unknown one is null.
  assert.equal(jobs.cancel(running.id).status, "cancelled");
  assert.equal(jobs.cancel("00000000-unknown"), null);
});

test("wait resolves when the job ends, whatever the outcome", async () => {
  const { runs, start } = fakeRunner();
  const jobs = createJobManager({ start });
  const job = jobs.start(spec("a"));
  const waiting = jobs.wait(job.id);
  runs[0].resolve("text");
  assert.equal((await waiting).text, "text");
  assert.equal((await jobs.wait(job.id)).status, "done");
  const other = jobs.start(spec("b"));
  const cancelled = jobs.wait(other.id);
  jobs.cancel(other.id);
  assert.equal((await cancelled).status, "cancelled");
});

test("the text so far is available on request while a job runs; list never carries text", async () => {
  let clock = 1_000;
  const { runs, start } = fakeRunner();
  const jobs = createJobManager({ start, now: () => clock });
  const job = jobs.start(spec("a", { meta: { module: "ECS529U", sheet: 3 } }));
  assert.deepEqual(job.meta, { module: "ECS529U", sheet: 3 });
  clock = 5_000;
  runs[0].hooks.onText("Hel");
  clock = 7_000;
  runs[0].hooks.onActivity();
  const partial = jobs.get(job.id, { partial: true });
  assert.equal(partial.partialText, "Hel");
  assert.equal(partial.chars, 3);
  assert.equal(partial.lastActivityAt, 7_000);
  assert.equal(partial.startedAt, 1_000);
  assert.equal(jobs.get(job.id).partialText, undefined);

  runs[0].resolve("Hello");
  await settle();
  const [listed] = jobs.list();
  assert.equal(listed.id, job.id);
  assert.equal(listed.status, "done");
  assert.equal(listed.text, undefined);
  assert.equal(listed.partialText, undefined);
  assert.equal(jobs.get(job.id).text, "Hello");
});

test("bad specs are refused: no prompt, unknown provider, oversized meta", () => {
  const jobs = createJobManager({ start: fakeRunner().start });
  assert.throws(() => jobs.start(spec("  ")), (error) => error.code === "bad_request");
  assert.throws(() => jobs.start({ kind: "gpt", prompt: "x" }), (error) => error.code === "bad_request");
  assert.throws(() => jobs.start(spec("x", { meta: { blob: "x".repeat(5000) } })), (error) => error.code === "bad_request");
  assert.equal(jobs.list().length, 0);
});

test("jobs are saved without the prompt, and unfinished ones come back interrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studyhub-jobs-"));
  try {
    const { runs, start } = fakeRunner();
    const jobs = createJobManager({ dir, start });
    const done = jobs.start(spec("SECRET PROMPT one"));
    const running = jobs.start(spec("SECRET PROMPT two", { lane: "background" }));
    runs[0].resolve("the answer");
    await settle();
    const queued = jobs.start(spec("SECRET PROMPT three"));
    const stillRunning = jobs.start(spec("SECRET PROMPT four"));
    assert.equal(jobs.get(stillRunning.id).status, "queued");
    runs[1].hooks.onText("half an ans");

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, [done.id, running.id, queued.id, stillRunning.id].map((id) => `${id}.json`).sort());
    for (const file of files) assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /SECRET PROMPT/);
    assert.equal(JSON.parse(readFileSync(join(dir, `${done.id}.json`), "utf8")).text, "the answer");

    const reloaded = createJobManager({ dir, start: fakeRunner().start });
    assert.equal(reloaded.get(done.id).status, "done");
    assert.equal(reloaded.get(done.id).text, "the answer");
    for (const id of [running.id, queued.id, stillRunning.id]) {
      const job = reloaded.get(id);
      assert.equal(job.status, "interrupted");
      assert.equal(job.error.code, "interrupted");
      assert.ok(job.endedAt);
    }
    assert.equal(JSON.parse(readFileSync(join(dir, `${queued.id}.json`), "utf8")).status, "interrupted");
    assert.equal(reloaded.list().length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finished jobs are dropped after a day, and only the newest 50 are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studyhub-jobs-"));
  try {
    let clock = 0;
    const { runs, start } = fakeRunner();
    const jobs = createJobManager({ dir, start, now: () => clock });
    const old = jobs.start(spec("old"));
    runs[0].resolve("old answer");
    await settle();

    clock = 25 * 60 * 60 * 1000;
    const kept = [];
    for (let i = 0; i < MAX_JOBS + 5; i++) {
      clock += 1_000;
      kept.push(jobs.start(spec(`job ${i}`)));
      runs.at(-1).resolve(`answer ${i}`);
      await settle();
    }
    assert.equal(jobs.get(old.id), null);
    const listed = jobs.list();
    assert.equal(listed.length, MAX_JOBS);
    assert.equal(listed[0].id, kept.at(-1).id);
    assert.equal(jobs.get(kept[0].id), null);
    assert.equal(readdirSync(dir).length, MAX_JOBS);

    // A reload prunes too.
    clock += 25 * 60 * 60 * 1000;
    const later = createJobManager({ dir, start, now: () => clock });
    assert.equal(later.list().length, 0);
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a folder jobs live in memory only", async () => {
  const { runs, start } = fakeRunner();
  const jobs = createJobManager({ start });
  const job = jobs.start(spec("a"));
  runs[0].resolve("b");
  await settle();
  assert.equal(jobs.get(job.id).text, "b");
});
