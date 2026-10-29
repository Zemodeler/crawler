import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createSetup } from "../shell/setup.mjs";
import { PANOPTO_PUBLIC_ONLY, PANOPTO_SITES } from "../../src/adapters/panopto.ts";

const PANOPTO = PANOPTO_SITES.surrey;
const PANOPTO_COOKIES = ".ASPXAUTH=panopto-secret";
const result = { courses: [], deadlines: [], notifications: [] };

/** Desktop setup with fake universities, token store, sync and a Panopto sign-in window answering with `panopto`. */
async function fixture(t, university, panopto) {
  const dir = await mkdtemp(join(tmpdir(), "panopto-signin-"));
  const root = join(dir, "library");
  await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = new Map();
  const calls = [];
  const opened = [];
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const adapters = Object.fromEntries(["qmul", "surrey"].map((id) => [id, {
    id,
    site: `https://${id}.example`,
    login: async () => ({ site: `https://${id}.example`, token: id }),
    whoAmI: async () => ({ userId: 1, permittedFunctions: [] }),
  }]));
  const loginBrowser = {
    capture: async () => assert.fail("not a token sign-in"),
    captureCookies: async (url, done, cookieUrl) => {
      opened.push({ url, done, cookieUrl });
      return panopto();
    },
  };
  const setup = createSetup({ app: { getPath: () => join(dir, "app") }, libraryRoot: () => root }, {
    getUniversity: (id) => adapters[id],
    tokens: { load: async (site) => saved.get(site), save: async (credentials) => saved.set(credentials.site, credentials), clear: async (site) => saved.delete(site) },
    calendarTokens: { load: async () => null },
    sync: async (options) => { calls.push(options); return result; },
    loginBrowser,
  });
  assert.deepEqual(await setup.selectUniversity({ university }), { ok: true });
  return { setup, saved, calls, opened, logged, site: adapters[university].site };
}
async function finished(setup) {
  for (let i = 0; i < 100; i++) {
    if ((await setup.status()).sync.state !== "running") return;
    await setTimeout(10);
  }
  assert.fail("sync did not finish");
}

test("Surrey sign-in also signs in to Panopto, and the desktop sync passes its cookies through", async (t) => {
  const f = await fixture(t, "surrey", async () => PANOPTO_COOKIES);
  assert.deepEqual(await f.setup.signIn(), { ok: true });
  assert.deepEqual(f.opened, [{
    url: `${PANOPTO}/Panopto/Pages/Auth/Login.aspx?instance=SurreySSO&AllowBounce=true`,
    done: `${PANOPTO}/Panopto/Pages/`,
    cookieUrl: PANOPTO,
  }]);
  assert.deepEqual(f.saved.get(f.site), { site: f.site, token: "surrey", panoptoCookies: PANOPTO_COOKIES });
  await f.setup.startSync();
  await finished(f.setup);
  assert.deepEqual(f.calls[0].panopto, { site: PANOPTO, cookies: PANOPTO_COOKIES });
  assert.equal((await f.setup.status()).sync.notice, null);
  assert.ok(!f.logged.join("\n").includes("panopto-secret"));
});

for (const failure of ["closed", "anonymous"]) test(`a failed Panopto sign-in (${failure}) keeps the Surrey sign-in and syncs public recordings`, async (t) => {
  const f = await fixture(t, "surrey", async () => {
    if (failure === "closed") throw new Error("The sign-in window was closed before signing in finished.");
    return "ASP.NET_SessionId=anon";
  });
  assert.deepEqual(await f.setup.signIn(), { ok: true });
  assert.equal((await f.setup.status()).signedIn, true);
  assert.deepEqual(f.saved.get(f.site), { site: f.site, token: "surrey" });
  assert.equal(f.logged.length, 1);
  assert.match(f.logged[0], /only public lecture recordings/);
  await f.setup.startSync();
  await finished(f.setup);
  assert.deepEqual(f.calls[0].panopto, { site: PANOPTO });
  const run = (await f.setup.status()).sync;
  assert.equal(run.state, "done");
  assert.equal(run.notice, PANOPTO_PUBLIC_ONLY);
});

test("QMUL has no Panopto sign-in and no Panopto option", async (t) => {
  const f = await fixture(t, "qmul", async () => assert.fail("no Panopto window for QMUL"));
  assert.deepEqual(await f.setup.signIn(), { ok: true });
  assert.deepEqual(f.opened, []);
  await f.setup.startSync();
  await finished(f.setup);
  assert.equal("panopto" in f.calls[0], false);
  assert.equal((await f.setup.status()).sync.notice, null);
});
