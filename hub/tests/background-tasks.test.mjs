import assert from "node:assert/strict";
import test from "node:test";

import { PRACTICE_CHANGED, TASKS_KEY, TUTORIALS_CHANGED, createTaskRunner } from "../lib/background-tasks.ts";
import { AiError, ERROR_COPY } from "../lib/ai/types.ts";

/* ------------------------------------------------------------- fixtures */

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
};

const file = (path, text) => ({
  path, name: path.split("/").pop(), ext: path.split(".").pop(), category: "Course materials", topic: "", text,
  file: { name: path, size: text.length, text: async () => text },
});

const SOL = "Course Materials/Labs/extra exercises.pdf";
const sheetText = (n) =>
  Array.from({ length: n }, (_, i) => [`Exercise ${i + 1}.`, `Question ${i + 1}?`, `Answer ${i + 1}: `.padEnd(1500, "x")].join("\n")).join("\n");
const FILES = [file(SOL, sheetText(11))];
const PAIR = { id: "s-extra", label: "Extra exercises", week: null, part: "", solutionPath: SOL };
const COURSE = "2025-26/ECS509U - Probability";

const part = { label: "a", question: "Q?", final: "1/6", working: "1. Count.", note: "" };
const exercise = (n) => ({ number: String(n), title: `Exercise ${n}`, topic: "Dice", stem: "", hint: "", basics: "", parts: [part], refs: [] });

/** Answers each batch with the exercises it asks for; `fail` lists 1-based calls that throw. */
function sheetClient({ fail = [], stream } = {}) {
  const seen = [];
  return {
    seen,
    target: { provider: "anthropic", transport: "subscription", model: "fake" },
    async generate(request) {
      seen.push(request);
      if (stream) request.onProgress?.({ phase: "streaming", chars: stream.length, text: stream });
      if (fail.includes(seen.length)) throw new AiError("timeout", "No output for 90 seconds.", { hint: "Retry this step." });
      const m = request.messages[0].content.match(/Convert ONLY exercises? (\d+)(?:–(\d+))?/);
      const exercises = [];
      for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) exercises.push(exercise(n));
      return { data: { title: "Extra probability", exercises }, raw: "", usage: {}, costUsd: null, model: "fake", transport: "subscription", repaired: false };
    },
  };
}

function setup(over = {}) {
  const storage = over.storage ?? memoryStorage();
  const tutorials = over.tutorials ?? new Map();
  const stores = over.stores ?? new Map();
  const events = [];
  let ids = 0;
  const deps = {
    storage,
    now: () => 1_000_000,
    hosted: () => true,
    createClient: async () => over.client,
    loadFiles: async () => FILES,
    loadTutorials: async (course) => structuredClone(tutorials.get(course) ?? { version: 1, sheets: [] }),
    saveTutorials: async (course, _hosted, value) => void tutorials.set(course, structuredClone(value)),
    loadStore: (course) => structuredClone(stores.get(course) ?? { papers: [], attempts: [] }),
    saveStore: (course, value) => (stores.set(course, structuredClone(value)), true),
    dispatch: (name, detail) => events.push([name, detail]),
    newId: () => `t${++ids}`,
    ...over.deps,
  };
  return { runner: createTaskRunner(deps), storage, tutorials, stores, events, deps };
}

const stored = (storage) => JSON.parse(storage.getItem(TASKS_KEY));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

/* ---------------------------------------------------------------- tests */

test("a tutorial task converts batch by batch, saving each batch and keying each call", async () => {
  const client = sheetClient({ stream: '{"exercises":[{"number":"1"},{"number":"2"' });
  const { runner, storage, tutorials, events } = setup({ client });
  const snapshots = [];
  runner.subscribe((tasks) => snapshots.push(tasks[0]));

  const task = runner.startTutorial(COURSE, PAIR, "Extra exercises");
  assert.equal(task.id, "t1");
  assert.equal(task.status, "queued");
  assert.equal(stored(storage)[0].id, "t1", "persisted as soon as it is started");
  await runner.whenIdle();

  assert.deepEqual(client.seen.map((r) => r.jobKey), ["t1:b1", "t1:b2", "t1:b3"]);
  assert.deepEqual(client.seen.map((r) => r.label), ["Extra exercises (part 1 of 3)", "Extra exercises (part 2 of 3)", "Extra exercises (part 3 of 3)"]);

  const [done] = runner.list();
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { count: 11, notes: [] });
  assert.equal(stored(storage)[0].status, "done");

  const sheet = tutorials.get(COURSE).sheets[0];
  assert.equal(sheet.exercises.length, 11);
  assert.equal("pending" in sheet, false);
  // Three batch saves and the final save, each announced.
  assert.equal(events.filter(([name]) => name === TUTORIALS_CHANGED).length, 4);
  assert.deepEqual(events[0][1], { course: COURSE });

  // While batch 2 streamed, 4 saved exercises plus the 2 counted in the text.
  const streaming = snapshots.find((t) => t.progress?.phase === "streaming" && t.progress.batch === 2);
  assert.equal(streaming.progress.items, 6);
  assert.equal(streaming.progress.batches, 3);
  assert.equal(streaming.progress.chars, 42);
  assert.equal(streaming.progress.startedAt, 1_000_000);
});

test("a failed batch keeps the earlier batches, and retrying continues from them with fresh job keys", async () => {
  let client = sheetClient({ fail: [2] });
  const { runner, tutorials } = setup({ deps: { createClient: async () => client } });
  runner.startTutorial(COURSE, PAIR, "Extra exercises");
  await runner.whenIdle();

  const [failed] = runner.list();
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "timeout", title: ERROR_COPY.timeout.title, message: "No output for 90 seconds.", hint: "Retry this step." });
  const partial = tutorials.get(COURSE).sheets[0];
  assert.deepEqual(partial.pending, { done: 1, total: 3 });
  assert.equal(partial.exercises.length, 4);

  const second = sheetClient();
  client = second;
  runner.retry("t1");
  await runner.whenIdle();
  assert.equal(runner.list()[0].status, "done");
  assert.deepEqual(second.seen.map((r) => r.jobKey), ["t1.1:b2", "t1.1:b3"], "only the missing batches, never a finished job of the failed run");
  assert.equal(tutorials.get(COURSE).sheets[0].exercises.length, 11);
});

test("resumeOnLoad runs a task an earlier page left running, resuming its partial sheet and reattaching by key", async () => {
  const first = setup({ client: sheetClient({ fail: [2] }) });
  first.runner.startTutorial(COURSE, PAIR, "Extra exercises");
  await first.runner.whenIdle();
  // Pretend the page was closed mid-run rather than failing.
  const left = stored(first.storage).map((t) => ({ ...t, status: "running", error: undefined, endedAt: undefined }));
  const storage = memoryStorage({ [TASKS_KEY]: JSON.stringify(left) });

  const client = sheetClient();
  const { runner, tutorials } = setup({ client, storage, tutorials: first.tutorials });
  assert.equal(runner.list()[0].status, "running", "nothing happens before resumeOnLoad");
  runner.resumeOnLoad();
  runner.resumeOnLoad();
  await runner.whenIdle();
  assert.deepEqual(client.seen.map((r) => r.jobKey), ["t1:b2", "t1:b3"], "same keys as the interrupted run, so the host job is reattached");
  assert.equal(runner.list()[0].status, "done");
  assert.equal(tutorials.get(COURSE).sheets[0].exercises.length, 11);
});

test("in browser-only mode a task left running by an earlier page is marked interrupted", () => {
  const storage = memoryStorage({
    [TASKS_KEY]: JSON.stringify([{ id: "t1", type: "tutorial", course: COURSE, label: "x", status: "running", createdAt: 999_000, spec: { pair: PAIR } }]),
  });
  const { runner } = setup({ storage, deps: { hosted: () => false } });
  const [task] = runner.list();
  assert.equal(task.status, "interrupted");
  assert.equal(stored(storage)[0].status, "interrupted");
});

test("tasks run one at a time, first in first out", async () => {
  const gates = [];
  const started = [];
  const convertSheet = async ({ pair }) => {
    started.push(pair.id);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return { sheet: { ...pair, title: pair.label, convertedAt: 1, exercises: [exercise(1)] }, dropped: 0, droppedRefs: 0, unread: [] };
  };
  const { runner } = setup({ client: sheetClient(), deps: { convertSheet } });
  runner.startTutorial(COURSE, { ...PAIR, id: "a" }, "A");
  runner.startTutorial(COURSE, { ...PAIR, id: "b" }, "B");
  runner.startTutorial(COURSE, { ...PAIR, id: "c" }, "C");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ["a"]);
  assert.deepEqual(runner.list().map((t) => t.status), ["running", "queued", "queued"]);
  gates[0].resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ["a", "b"]);
  gates[1].resolve();
  await new Promise((r) => setTimeout(r, 10));
  gates[2].resolve();
  await runner.whenIdle();
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.deepEqual(runner.list().map((t) => t.status), ["done", "done", "done"]);
});

test("cancel aborts the running task and drops a queued one", async () => {
  let signal;
  const convertSheet = async (options) => {
    signal = options.signal;
    await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new AiError("aborted", "Cancelled."))));
  };
  const { runner, storage } = setup({ client: sheetClient(), deps: { convertSheet } });
  runner.startTutorial(COURSE, { ...PAIR, id: "a" }, "A");
  runner.startTutorial(COURSE, { ...PAIR, id: "b" }, "B");
  await new Promise((r) => setTimeout(r, 10));
  runner.cancel("t2");
  runner.cancel("t1");
  assert.equal(signal.aborted, true);
  await runner.whenIdle();
  assert.deepEqual(runner.list().map((t) => t.status), ["cancelled", "cancelled"]);
  assert.deepEqual(stored(storage).map((t) => t.status), ["cancelled", "cancelled"]);

  runner.dismiss("t1");
  assert.deepEqual(runner.list().map((t) => t.id), ["t2"]);
});

test("a paper task saves its draft after each batch, remembers the paper and resumes it after a failure", async () => {
  const draft = (questions, complete) => ({
    id: "paper-1", title: "Mock", kind: "exam", brief: "", createdAt: 5, sources: ["a.pdf"],
    questions: Array.from({ length: questions }, (_, i) => ({ id: `q${i}`, prompt: `P${i}` })),
    ...(complete ? {} : { draft: { target: 12 } }),
  });
  const calls = [];
  let fail = true;
  const generatePaper = async (options) => {
    calls.push({ resume: options.resume?.id, sources: options.sources.map((f) => f.path), kind: options.kind, module: options.module });
    if (!options.resume) {
      options.onProgress({ phase: "streaming", chars: 10, text: '[{"prompt":"a"},{"prompt":"b"', batch: { index: 1, total: 3 } });
      await options.onBatch(draft(4, false), { batch: 1, batches: 3, questions: 4 });
    }
    if (fail) {
      fail = false;
      throw new Error("socket hang up");
    }
    await options.onBatch(draft(12, true), { batch: 3, batches: 3, questions: 12 });
    return { paper: draft(12, true), dropped: 1, unread: [] };
  };
  const files = [file("a.pdf", "A"), file("b.pdf", "B")];
  const { runner, stores, events } = setup({ client: sheetClient(), deps: { generatePaper, loadFiles: async () => files } });
  const snapshots = [];
  runner.subscribe((tasks) => snapshots.push(tasks[0]));
  stores.set(COURSE, { papers: [{ id: "other", questions: [] }], attempts: [{ id: "keep" }] });

  runner.startPaper(COURSE, { kind: "exam", count: 12, brief: "", module: "ECS509U", sourcePaths: ["a.pdf"] }, "Mock exam");
  await runner.whenIdle();
  let [task] = runner.list();
  assert.equal(task.status, "failed");
  assert.deepEqual(task.error, { code: "unknown", title: ERROR_COPY.unknown.title, message: "socket hang up" });
  assert.equal(task.spec.paperId, "paper-1");
  assert.deepEqual(stores.get(COURSE).papers.map((p) => p.id), ["paper-1", "other"]);
  assert.deepEqual(stores.get(COURSE).papers[0].draft, { target: 12 });
  assert.deepEqual(stores.get(COURSE).attempts, [{ id: "keep" }], "the page's own data is kept");
  const streaming = snapshots.find((t) => t.progress?.phase === "streaming");
  assert.deepEqual({ items: streaming.progress.items, itemsTotal: streaming.progress.itemsTotal }, { items: 2, itemsTotal: 12 });

  runner.continueTask(task.id);
  await runner.whenIdle();
  [task] = runner.list();
  assert.equal(task.status, "done");
  assert.deepEqual(calls.map((c) => c.resume), [undefined, "paper-1"]);
  assert.deepEqual(calls[0].sources, ["a.pdf"]);
  assert.equal(stores.get(COURSE).papers.length, 2);
  assert.equal("draft" in stores.get(COURSE).papers[0], false);
  assert.equal(task.result.count, 12);
  assert.match(task.result.notes[0], /1 generated question was left out/);
  assert.ok(events.every(([name]) => name === PRACTICE_CHANGED));
});

test("finished tasks are kept for a day, and at most twenty", () => {
  const task = (i, over) => ({ id: `t${i}`, type: "tutorial", course: COURSE, label: `T${i}`, status: "done", createdAt: 900_000 + i, endedAt: 900_000 + i, spec: { pair: PAIR }, ...over });
  const list = [
    task(0, { endedAt: 1_000_000 - 2 * 24 * 3600_000 }),
    ...Array.from({ length: 24 }, (_, i) => task(i + 1)),
    task(99, { status: "queued", endedAt: undefined, createdAt: 1 }),
  ];
  const storage = memoryStorage({ [TASKS_KEY]: JSON.stringify(list) });
  const { runner } = setup({ storage });
  const ids = runner.list().map((t) => t.id);
  assert.equal(ids.length, 20);
  assert.ok(!ids.includes("t0"), "older than a day");
  assert.ok(ids.includes("t99"), "unfinished tasks are never pruned");
  assert.ok(!ids.includes("t1") && !ids.includes("t5") && ids.includes("t6"), "the oldest finished go first");
});

test("unreadable or blocked storage never breaks the runner", async () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
  const { runner } = setup({ client: sheetClient(), storage: broken });
  assert.deepEqual(runner.list(), []);
  runner.startTutorial(COURSE, PAIR, "x");
  await runner.whenIdle();
  assert.equal(runner.list()[0].status, "done");
  const garbage = memoryStorage({ [TASKS_KEY]: "{not json" });
  assert.deepEqual(setup({ storage: garbage }).runner.list(), []);
});
