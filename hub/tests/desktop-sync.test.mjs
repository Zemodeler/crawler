import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBackground, readSchedule, toastsFor, writeSchedule } from "../shell/background.mjs";
import { parseJsonAnswer } from "../shell/ai-runner.mjs";
import { createSetup } from "../shell/setup.mjs";
import { setImmediate } from "node:timers/promises";

const syncResult = { courses: [], deadlines: [], notifications: [] };

async function setupSync(t, dependencies, onRoot = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "studyhub-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  onRoot(root);
  return createSetup({ app: { getPath: () => join(root, "app") }, libraryRoot: () => join(root, "library") }, {
    adapter: { id: "qmul", site: "https://vle.example", whoAmI: async () => ({ userId: 1, permittedFunctions: [] }) },
    tokens: { load: async () => ({ site: "https://vle.example", token: "fixture" }) },
    calendarTokens: { load: async () => null },
    sync: async () => syncResult,
    ...dependencies,
  });
}

test("a credential-load failure releases the sync claim so the next sync can start", async (t) => {
  let loads = 0;
  let starts = 0;
  const setup = await setupSync(t, {
    tokens: { load: async () => {
      if (++loads === 1) throw new Error("Credential store unavailable");
      return { site: "https://vle.example", token: "fixture" };
    } },
    sync: async () => { starts++; return syncResult; },
  });
  assert.deepEqual(await setup.startSync(), { error: "Credential store unavailable" });
  assert.equal((await setup.status()).sync.state, "idle");
  assert.deepEqual(await setup.startSync(), { ok: true });
  await setImmediate();
  assert.equal(starts, 1);
  assert.equal((await setup.status()).sync.state, "done");
});

async function legacyLibrary(root) {
  await mkdir(join(root, "library", ".crawler"), { recursive: true });
  await writeFile(join(root, "library", "Deadlines.json"), "[]");
  await writeFile(join(root, "library", "notes.md"), "my notes");
}

test("a legacy library is reported, refused with its code, and can be claimed in place", async (t) => {
  let root;
  let starts = 0;
  const setup = await setupSync(t, { sync: async () => { starts++; return syncResult; } }, (r) => { root = r; });
  await legacyLibrary(root);
  assert.equal((await setup.status()).library.legacy, true);
  const refused = await setup.startSync();
  assert.equal(refused.code, "legacy_library");
  assert.match(refused.error, /legacy data/);
  assert.deepEqual(await setup.claimLibrary(), { ok: true });
  assert.equal((await setup.status()).library.legacy, false);
  assert.deepEqual(await setup.startSync(), { ok: true });
  await setImmediate();
  assert.equal(starts, 1);
  assert.equal(await readFile(join(root, "library", "notes.md"), "utf8"), "my notes");
});

test("a fresh library keeps the old one beside it untouched", async (t) => {
  let root;
  const setup = await setupSync(t, {}, (r) => { root = r; });
  await legacyLibrary(root);
  const result = await setup.freshLibrary();
  assert.equal(result.ok, true);
  assert.match(result.backup, /library \(backup \d{4}-\d{2}-\d{2}\)$/);
  assert.equal(await readFile(join(result.backup, "notes.md"), "utf8"), "my notes");
  assert.deepEqual(await readdir(join(root, "library")), []);
  assert.equal((await setup.status()).library.legacy, false);
  assert.deepEqual(await setup.startSync(), { ok: true });
});

test("a scheduled sync that is refused shows as a failed run", async (t) => {
  let root;
  const setup = await setupSync(t, {}, (r) => { root = r; });
  await legacyLibrary(root);
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  await setup.startBackgroundSync("schedule");
  const { sync } = await setup.status();
  assert.equal(sync.state, "failed");
  assert.equal(sync.code, "legacy_library");
  assert.match(errors[0], /^Sync \(schedule\): Library account ownership is unknown/);
});

test("finished sync summaries expose incomplete document coverage without failing the sync", async (t) => {
  const issue = { file: "Brief.docx", reason: "no-text", message: "No text could be extracted." };
  const setup = await setupSync(t, {
    sync: async () => ({ ...syncResult, courses: [{ shortname: "TST101U", status: "skipped", extractionIssues: [issue] }] }),
  });
  await setup.startSync();
  let status;
  for (let i = 0; i < 100; i++) {
    status = await setup.status();
    if (status.sync.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status.sync.state, "done");
  assert.deepEqual(status.sync.summary.extractionIssues, [{ module: "TST101U", ...issue }]);
});

test("calendar credential errors do not turn a completed course sync into a failure", async (t) => {
  let loads = 0;
  const setup = await setupSync(t, {
    calendarTokens: { load: async () => {
      if (++loads === 1) throw new Error("Calendar store unavailable");
      return { refreshToken: "fixture" };
    } },
  });
  assert.deepEqual(await setup.startSync(), { ok: true });
  await setImmediate();
  const status = await setup.status();
  assert.equal(status.sync.state, "done");
  assert.equal(status.sync.error, null);
  assert.equal(status.calendar.busy, false);
  assert.equal(status.calendar.error, "Calendar store unavailable");
});

test("the schedule defaults to every 3 days and round-trips 1, 3 and 7", async () => {
  const root = await mkdtemp(join(tmpdir(), "studyhub-schedule-"));
  try {
    assert.deepEqual(await readSchedule(root), { everyDays: 3 });
    await writeSchedule(root, 7);
    assert.deepEqual(await readSchedule(root), { everyDays: 7 });
    await assert.rejects(writeSchedule(root, 2));
    await writeFile(join(root, ".crawler", "schedule.json"), "null");
    assert.deepEqual(await readSchedule(root), { everyDays: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("many notifications collapse into a few toasts and a summary", () => {
  const events = Array.from({ length: 9 }, (_, i) => ({ kind: "new-deadline", title: `D${i}`, body: "" }));
  const toasts = toastsFor(events);
  assert.equal(toasts.length, 4);
  assert.match(toasts[3].body, /6 more updates/);
  assert.equal(toastsFor(events.slice(0, 3)).length, 3);
});

test("the assistant's answer is read as JSON in any of its usual shapes", () => {
  assert.deepEqual(parseJsonAnswer('{"items":[]}'), { items: [] });
  assert.deepEqual(parseJsonAnswer('Here you go:\n```json\n{"items":[1]}\n```'), { items: [1] });
  assert.deepEqual(parseJsonAnswer('Sure. {"items":[2]} Hope that helps.'), { items: [2] });
  assert.throws(() => parseJsonAnswer("no json here"), /not JSON/);
});

function fakeElectron() {
  const shown = [];
  class Notification {
    static isSupported() {
      return true;
    }
    constructor(options) {
      this.options = options;
    }
    on() {}
    show() {
      shown.push(this.options);
    }
  }
  return { shown, Notification };
}

test("a due sync starts on catch-up, and a fresh one does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "studyhub-due-"));
  try {
    const started = [];
    const setup = {
      status: async () => ({ signedIn: true, sync: { state: "idle" } }),
      startBackgroundSync: async (origin) => started.push(origin),
    };
    const { Notification } = fakeElectron();
    const background = createBackground({ app: {}, Notification, setup, libraryRoot: () => root, openPage: () => {} });
    await background.maybeSync(new Date("2026-10-16T09:00:00Z"));
    assert.deepEqual(started, ["first"]);
    await mkdir(join(root, ".crawler"), { recursive: true });
    await writeFile(join(root, ".crawler", "state.json"), JSON.stringify({ version: 1, lastSync: "2026-10-15T09:00:00Z", courses: {} }));
    await background.maybeSync(new Date("2026-10-16T09:00:00Z"));
    assert.deepEqual(started, ["first"]);
    await background.maybeSync(new Date("2026-10-19T12:00:00Z"));
    assert.deepEqual(started, ["first", "schedule"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deadlines due within 48 hours are reminded once", async () => {
  const root = await mkdtemp(join(tmpdir(), "studyhub-remind-"));
  try {
    const deadline = {
      id: "qmul:ECS505U:assign:1",
      module: "ECS505U",
      year: "2026-27",
      title: "Coursework 1",
      kind: "coursework",
      status: "confirmed",
      due: { iso: "2026-10-17T15:00:00.000Z", allDay: false, tz: "Europe/London" },
      sources: [{ type: "vle-field", strength: "structured", url: "https://vle.example/a", quote: "Due", date: null, seenAt: "2026-10-01T00:00:00Z" }],
      history: [],
    };
    await writeFile(join(root, "Deadlines.json"), JSON.stringify([deadline]));
    const { shown, Notification } = fakeElectron();
    const background = createBackground({ app: {}, Notification, setup: {}, libraryRoot: () => root, openPage: () => {} });
    await background.remind(new Date("2026-10-16T09:00:00Z"));
    assert.equal(shown.length, 1);
    await background.remind(new Date("2026-10-16T10:00:00Z"));
    assert.equal(shown.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
