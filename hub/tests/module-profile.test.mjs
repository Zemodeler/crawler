import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModuleProfile, setModuleProfile, suggestModuleProfile } from "../lib/library.ts";
import { readModuleFile, writeModuleFile } from "../host/library.mjs";

function folder(text = null) {
  const writes = [];
  return { name: "ECS505U - Software Engineering", writes,
    async getDirectoryHandle() { return { async getFileHandle() {
      return { async getFile() {
        if (text === null) throw new DOMException("Missing", "NotFoundError");
        return { text: async () => text };
      }, async createWritable() { return { async write(content) { writes.push(content); }, async close() {} }; } };
    } }; },
  };
}

test("folder imports without a handle use module inference and preserve legacy law detection", () => {
  assert.equal(suggestModuleProfile("ECS505U - Software Engineering").profile, "stem");
  assert.equal(suggestModuleProfile("HST101 - Modern History").profile, "humanities");
  assert.equal(suggestModuleProfile("ECS505U", [{ path: "Flashcards/Week 1/Foundations and Cases.csv" }]).profile, "law");
  assert.equal(suggestModuleProfile("Unknown course").confirmed, false);
});

test("new modules suggest a subject without writing; legacy law files override inference", async () => {
  const handle = folder();
  assert.deepEqual(await getModuleProfile(handle), { profile: "stem", confirmed: false, reason: "Module code ECS505U identifies stem." });
  for (const path of ["Flashcards/Week 1/Foundations and Cases.csv", "Revision/Guides/5 - Case Coverage Index.md", "Revision/Guides/0 - Problem Question Technique + Issue-Spotting Map.md"])
    assert.equal((await getModuleProfile(handle, [{ path }])).profile, "law");
  assert.deepEqual(handle.writes, []);
});

test("saved choices win; invalid settings fall back; confirmation records provenance and time", async () => {
  const handle = folder(JSON.stringify({ profile: "humanities", chosenBy: "student", at: new Date().toISOString() }));
  assert.deepEqual(await getModuleProfile(handle, [{ path: "Flashcards/Foundations and Cases.csv" }]), { profile: "humanities", confirmed: true, reason: "Saved subject choice." });
  for (const text of ["bad json", "null", '{"profile":"nope"}', '{"profile":"stem","chosenBy":"bot"}'])
    assert.equal((await getModuleProfile(folder(text))).confirmed, false);
  await setModuleProfile(handle, "stem", "suggested");
  const saved = JSON.parse(handle.writes[0]);
  assert.equal(saved.profile, "stem");
  assert.equal(saved.chosenBy, "suggested");
  assert.equal(new Date(saved.at).toISOString(), saved.at);
  await assert.rejects(setModuleProfile(handle, "invalid"), /Invalid subject/);
  await assert.rejects(setModuleProfile(handle, "stem", "bot"), /Invalid subject/);
});

test("host helpers use the guarded module-file endpoint for exactly profile.json", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (path, init) => {
    requests.push({ path, init });
    return { ok: true, json: async () => init.method === "PUT" ? { ok: true } : { text: null } };
  });
  const key = "2026-27/ECS505U - Software Engineering";
  assert.equal((await getModuleProfile(key)).confirmed, false);
  await setModuleProfile(key, "stem");
  assert.match(requests[0].path, /path=\.study-hub%2Fprofile.json/);
  assert.equal(requests[0].init.headers["x-study-hub-host"], "1");
  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.module, key);
  assert.equal(body.path, ".study-hub/profile.json");
  assert.equal(JSON.parse(body.content).profile, "stem");
});

test("host validates subject writes and refuses escapes through module paths and junctions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "studyhub-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = "2026-27/ECS505U - Software Engineering";
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  const path = ".study-hub/profile.json";
  const valid = { profile: "stem", chosenBy: "student", at: "2026-10-16T12:00:00.000Z" };
  for (const bad of ["{", "null", JSON.stringify({ ...valid, profile: "__proto__" }), JSON.stringify({ ...valid, chosenBy: "bot" }), JSON.stringify({ ...valid, at: "today" }), JSON.stringify({ ...valid, extra: true })])
    assert.ok((await writeModuleFile(root, key, path, bad)).error);
  assert.ok((await writeModuleFile(root, key, ".study-hub/PROFILE.JSON", "{}")).error);
  assert.equal(existsSync(join(dir, path)), false);
  assert.deepEqual(await readModuleFile(root, key, path), { text: null });
  for (const profile of ["law", "stem", "humanities", "general"])
    assert.deepEqual(await writeModuleFile(root, key, path, JSON.stringify({ ...valid, profile })), { ok: true });
  assert.equal(JSON.parse(readFileSync(join(dir, path), "utf8")).profile, "general");
  assert.ok((await writeModuleFile(root, "../outside", path, JSON.stringify(valid))).error);
  rmSync(join(dir, ".study-hub"), { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(dir, ".study-hub"), process.platform === "win32" ? "junction" : "dir");
  assert.ok((await writeModuleFile(root, key, path, JSON.stringify(valid))).error);
  assert.equal(existsSync(join(outside, "profile.json")), false);
});
