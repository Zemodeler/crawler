import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { createSetup } from "../shell/setup.mjs";
import { handleSetup } from "../host/index.mjs";
import { VleError } from "../../src/types.ts";

const result = { courses: [], deadlines: [], notifications: [] };
async function fixture(t, dependencies = {}) {
  const dir = await mkdtemp(join(tmpdir(), "university-setup-"));
  const root = join(dir, "library");
  await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = new Map();
  const calls = [];
  const adapters = Object.fromEntries(["qmul", "surrey"].map((id) => [id, {
    id,
    site: `https://${id}.example`,
    login: async () => ({ site: `https://${id}.example`, token: id }),
    whoAmI: async (credentials) => { assert.equal(credentials.token, id); return { userId: 1, permittedFunctions: [] }; },
  }]));
  const deps = {
    getUniversity: (id) => adapters[id],
    tokens: { load: async (site) => saved.get(site), save: async (credentials) => saved.set(credentials.site, credentials), clear: async (site) => saved.delete(site) },
    calendarTokens: { load: async () => null },
    sync: async (options) => { calls.push(options); return result; },
    ...dependencies,
  };
  const create = () => createSetup({ app: { getPath: () => join(dir, "app") }, libraryRoot: () => root }, deps);
  return { root, create, setup: create(), saved, calls, adapters };
}
async function finished(setup) {
  for (let i = 0; i < 100; i++) {
    if ((await setup.status()).sync.state !== "running") return;
    await setTimeout(10);
  }
  assert.fail("sync did not finish");
}

for (const id of ["qmul", "surrey"]) test(`${id}: persistence, site credentials and manual/scheduled adapters`, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.setup.status()).university.id, "qmul");
  assert.deepEqual(await f.setup.selectUniversity({ university: id }), { ok: true });
  const setup = f.create();
  assert.equal((await setup.status()).university.id, id);
  assert.equal((await setup.status()).signedIn, false);
  assert.deepEqual(await setup.signIn(), { ok: true });
  assert.equal((await setup.status()).signedIn, true);
  await setup.startSync();
  await finished(setup);
  await setup.startBackgroundSync("schedule");
  await finished(setup);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.adapter, f.adapters[id]);
    assert.equal(call.credentials.token, id);
  }
  assert.equal(JSON.parse(await readFile(join(f.root, ".crawler", "university.json"))).university, id);
  const other = id === "qmul" ? "surrey" : "qmul";
  assert.match((await setup.selectUniversity({ university: other })).error, /library belongs/);
  assert.equal((await f.create().status()).university.id, id);
});

test("sign-in claims an empty library and rejects another university", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.setup.selectUniversity({ university: "surrey" }), { ok: true });
  assert.deepEqual(await f.setup.signIn(), { ok: true });
  assert.match((await f.setup.selectUniversity({ university: "qmul" })).error, /library belongs/);
  assert.equal(f.saved.has(f.adapters.surrey.site), true);
});

test("busy sign-in and sync reject switches before changing preferences", async (t) => {
  let release;
  const f = await fixture(t, { sync: () => new Promise((resolve) => { release = () => resolve(result); }) });
  let loginRelease;
  f.adapters.qmul.login = () => new Promise((resolve) => { loginRelease = () => resolve({ site: f.adapters.qmul.site, token: "qmul" }); });
  const signing = f.setup.signIn();
  assert.match((await f.setup.selectUniversity({ university: "surrey" })).error, /Wait/);
  assert.match((await f.setup.startSync()).error, /sign-in/);
  while (!loginRelease) await setTimeout(1);
  loginRelease();
  await signing;
  await f.setup.startSync();
  assert.match((await f.setup.selectUniversity({ university: "surrey" })).error, /Wait/);
  assert.match((await f.setup.signIn()).error, /sync/);
  release();
  await finished(f.setup);
});

for (const file of [".crawler/state.json", "2026-27/module/file.txt", "Deadlines.json"]) test(`legacy ${file} protects QMUL data`, async (t) => {
  const f = await fixture(t);
  const path = join(f.root, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "legacy content");
  assert.match((await f.setup.selectUniversity({ university: "surrey" })).error, /legacy data/);
  assert.equal(await readFile(path, "utf8"), "legacy content");
  const setup = f.create();
  assert.equal(setup.prefs().university ?? "qmul", "qmul");
  if (file === ".crawler/state.json") {
    await assert.rejects(setup.status(), /invalid JSON/);
  } else {
    assert.equal((await setup.status()).university.id, "qmul");
  }
});

test("invalid ownership metadata refuses selection and sync", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".crawler"));
  await writeFile(join(f.root, ".crawler", "university.json"), '{}');
  assert.match((await f.setup.selectUniversity({ university: "surrey" })).error, /invalid/);
  assert.match((await f.setup.startSync()).error, /invalid/);
  assert.equal(f.calls.length, 0);
});

test("setup API routes university selection and returns a clear rejection", async () => {
  for (const rejected of [false, true]) {
    const request = Readable.from([Buffer.from(JSON.stringify({ university: "surrey" }))]);
    request.method = "POST";
    let status, body;
    const response = { writeHead: (code) => { status = code; }, end: (value) => { body = JSON.parse(value); } };
    await handleSetup({ selectUniversity: async (input) => {
      assert.equal(input.university, "surrey");
      return rejected ? { error: "Wait for sync to finish." } : { ok: true };
    } }, request, response, new URL("http://localhost/api/setup/university"));
    assert.equal(status, rejected ? 400 : 200);
    assert.deepEqual(body, rejected ? { code: "setup_failed", message: "Wait for sync to finish." } : { ok: true });
  }
});
test("expired Surrey credentials clear only Surrey's site", async (t) => {
  const f = await fixture(t, { sync: async () => { throw new VleError("invalid_token", "expired"); } });
  f.saved.set(f.adapters.qmul.site, { site: f.adapters.qmul.site, token: "qmul" });
  await f.setup.selectUniversity({ university: "surrey" });
  await f.setup.signIn();
  await f.setup.startSync();
  await finished(f.setup);
  assert.equal((await f.setup.status()).sync.state, "failed");
  assert.equal(f.saved.has(f.adapters.qmul.site), true);
  assert.equal(f.saved.has(f.adapters.surrey.site), false);
});

test("a selected Surrey install refuses legacy data manually and on schedule", async (t) => {
  const f = await fixture(t);
  await f.setup.selectUniversity({ university: "surrey" });
  f.saved.set(f.adapters.surrey.site, { site: f.adapters.surrey.site, token: "surrey" });
  await writeFile(join(f.root, "Deadlines.json"), "[]");
  const setup = f.create();
  assert.match((await setup.startSync()).error, /legacy data/);
  assert.match((await setup.startBackgroundSync("schedule")).error, /legacy data/);
  assert.equal(f.calls.length, 0);
  assert.equal((await setup.status()).sync.state, "idle");
});

test("a schedule alone does not claim an empty library", async (t) => {
  const f = await fixture(t);
  await f.setup.setSchedule({ everyDays: 7 });
  assert.deepEqual(await f.setup.selectUniversity({ university: "surrey" }), { ok: true });
  const status = await f.setup.status();
  assert.equal(status.schedule.everyDays, 7);
  assert.equal(status.universities.find((u) => u.id === "surrey").experimental, true);
  assert.equal(status.universities.find((u) => u.id === "qmul").experimental, false);
});

for (const file of [".crawler/manifest.json", "Deadlines.json"]) test(`unmarked Surrey evidence in ${file} cannot be adopted as QMUL`, async (t) => {
  const f = await fixture(t);
  const path = join(f.root, file);
  await mkdir(join(path, ".."), { recursive: true });
  const original = JSON.stringify([{ sourceUrl: "https://surreylearn.surrey.ac.uk/content/1" }]);
  await writeFile(path, original);
  for (const university of ["qmul", "surrey"]) {
    assert.match((await f.setup.selectUniversity({ university })).error, /legacy data/);
  }
  assert.match((await f.setup.startBackgroundSync("schedule")).error, /legacy data/);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(path, "utf8"), original);
});

for (const scenario of ["account", "site", "invalid identity", "malformed", "legacy marker"]) test(`rejected desktop ${scenario} preserves credentials and library bytes`, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.setup.signIn(), { ok: true });
  const marker = join(f.root, ".crawler", "university.json");
  if (scenario === "malformed") await writeFile(marker, "{broken");
  if (scenario === "legacy marker") await writeFile(marker, JSON.stringify({ version: 1, university: "qmul" }));
  await writeFile(join(f.root, "Deadlines.json"), "[]");
  const before = await readFile(marker, "utf8");
  const saved = f.saved.get(f.adapters.qmul.site);
  f.adapters.qmul.login = async () => ({ site: scenario === "site" ? "https://other.example" : f.adapters.qmul.site, token: "replacement" });
  f.adapters.qmul.whoAmI = async () => ({ userId: scenario === "invalid identity" ? NaN : 2, permittedFunctions: [] });
  const rejection = await f.setup.signIn();
  assert.ok(rejection.error);
  assert.ok(!rejection.error.includes("replacement"));
  assert.equal(f.saved.get(f.adapters.qmul.site), saved);
  assert.equal(await readFile(marker, "utf8"), before);
  assert.equal(await readFile(join(f.root, "Deadlines.json"), "utf8"), "[]");
});

test("same-account desktop token renewal preserves marker and replaces credentials", async (t) => {
  const f = await fixture(t);
  await f.setup.signIn();
  const marker = join(f.root, ".crawler", "university.json");
  const before = await readFile(marker, "utf8");
  f.adapters.qmul.login = async () => ({ site: f.adapters.qmul.site, token: "renewed" });
  f.adapters.qmul.whoAmI = async () => ({ userId: 1, permittedFunctions: [] });
  assert.deepEqual(await f.setup.signIn(), { ok: true });
  assert.equal(f.saved.get(f.adapters.qmul.site).token, "renewed");
  assert.equal(await readFile(marker, "utf8"), before);
});

test("desktop cannot replace credentials while another process holds the full-sync lock", async (t) => {
  const f = await fixture(t);
  await f.setup.signIn();
  const saved = f.saved.get(f.adapters.qmul.site);
  const lock = join(f.root, ".crawler", "sync.lock");
  await mkdir(lock);
  assert.match((await f.setup.signIn()).error, /already running/);
  assert.equal(f.saved.get(f.adapters.qmul.site), saved);
  await rm(lock, { recursive: true });
});
