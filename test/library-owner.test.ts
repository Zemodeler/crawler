import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalLibrarySite, withLibraryOwner } from "../src/library-owner.ts";
import type { UniversityAdapter } from "../src/types.ts";

const site = "https://vle.example/moodle";
const credentials = { site, token: "private-token", privateToken: null, cookies: "private-cookie" };
const adapter = (id = "qmul", userId = 123456789, url = site) => ({ id, site: url, whoAmI: async () => ({ userId, permittedFunctions: [] }) }) as unknown as UniversityAdapter;
async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "library-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("canonical sites normalize host/default port/trailing slash and preserve base paths", () => {
  assert.equal(canonicalLibrarySite("https://VLE.example:443/moodle/"), site);
  assert.notEqual(canonicalLibrarySite("https://vle.example/other"), site);
  for (const url of ["bad", "https://user:pass@vle.example", `${site}?token=secret`, `${site}#fragment`]) assert.throws(() => canonicalLibrarySite(url));
});

test("fresh claim stores a stable fingerprint without credentials or raw account ID", async (t) => {
  const root = await fixture(t);
  let saves = 0;
  await withLibraryOwner(root, adapter(), credentials, async () => { saves++; });
  const text = await readFile(join(root, ".crawler", "university.json"), "utf8");
  const owner = JSON.parse(text);
  assert.equal(owner.version, 2);
  assert.equal(owner.site, site);
  assert.match(owner.account, /^[a-f0-9]{64}$/);
  for (const secret of [credentials.token, credentials.cookies, "123456789"]) assert.ok(!text.includes(secret));
  await withLibraryOwner(root, adapter(), { ...credentials, site: `${site}/`, token: "renewed" }, async () => { saves++; });
  assert.equal(saves, 2);
  assert.equal(await readFile(join(root, ".crawler", "university.json"), "utf8"), text);
});

for (const variant of ["university", "site", "account", "credentials site", "invalid identity"]) test(`reject ${variant} without changing bytes`, async (t) => {
  const root = await fixture(t);
  await withLibraryOwner(root, adapter(), credentials, async () => {});
  const marker = join(root, ".crawler", "university.json");
  const before = await readFile(marker, "utf8");
  const data = join(root, "course.txt");
  await writeFile(data, "student notes");
  const url = variant === "site" ? "https://other.example" : site;
  const candidate = adapter(variant === "university" ? "surrey" : "qmul", variant === "account" ? 2 : variant === "invalid identity" ? NaN : 123456789, url);
  const creds = { ...credentials, site: variant === "credentials site" ? "https://wrong.example" : url };
  await assert.rejects(withLibraryOwner(root, candidate, creds, async () => { assert.fail("must not run"); }), (error: Error) => {
    assert.ok(!error.message.includes("123456789"));
    assert.ok(!error.message.includes(credentials.token));
    return true;
  });
  assert.equal(await readFile(marker, "utf8"), before);
  assert.equal(await readFile(data, "utf8"), "student notes");
});

for (const content of ["{bad", "{}", "null", JSON.stringify({ version: 1, university: "qmul" }), JSON.stringify({ version: 2, university: "qmul", site, account: "bad" })]) test(`refuse malformed or legacy marker ${content}`, async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".crawler"));
  const marker = join(root, ".crawler", "university.json");
  await writeFile(marker, content);
  await assert.rejects(withLibraryOwner(root, adapter(), credentials, async () => assert.fail()), /invalid|legacy data/);
  assert.equal(await readFile(marker, "utf8"), content);
});

for (const name of ["course.txt", ".crawler/state.json", ".crawler/manifest.json", "Deadlines.json"]) test(`unknown legacy ${name} is never claimed`, async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".crawler"));
  await writeFile(join(root, name), "legacy bytes");
  await assert.rejects(withLibraryOwner(root, adapter(), credentials, async () => assert.fail()), /legacy data.*separate empty library/);
  assert.equal(await readFile(join(root, name), "utf8"), "legacy bytes");
  assert.ok(!(await readdir(join(root, ".crawler"))).includes("university.json"));
});

test("claims and credential saves serialize with sync without stealing an old lock", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".crawler", "sync.lock"), { recursive: true });
  await utimes(join(root, ".crawler", "sync.lock"), new Date(0), new Date(0));
  await assert.rejects(withLibraryOwner(root, adapter(), credentials, async () => assert.fail()), /already running/);
  await rm(join(root, ".crawler", "sync.lock"), { recursive: true });
  await withLibraryOwner(root, adapter(), credentials, async () => {
    await assert.rejects(withLibraryOwner(root, adapter("qmul", 2), credentials, async () => assert.fail()), /already running/);
  });
});
