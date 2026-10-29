import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PANOPTO_PUBLIC_ONLY, PANOPTO_SITES, panoptoOption, panoptoSignIn } from "../src/adapters/panopto.ts";
import { runCli } from "../src/cli.ts";
import type { CliEnv } from "../src/cli.ts";
import type { SyncOptions, SyncResult } from "../src/sync.ts";
import { syncTranscripts } from "../src/transcripts.ts";
import type { Credentials, LoginBrowser, TokenStore, UniversityAdapter } from "../src/types.ts";

const PANOPTO = PANOPTO_SITES.surrey!;
const SURREYLEARN = "https://surreylearn.surrey.ac.uk";
const VLE_COOKIES = "d2lSessionVal=vle-secret; d2lSecureSessionVal=vle-secret-2";
const PANOPTO_COOKIES = ".ASPXAUTH=panopto-secret; UserSettings=x";
const LOGIN_URL = `${PANOPTO}/Panopto/Pages/Auth/Login.aspx?instance=SurreySSO&AllowBounce=true`;
const delivery = "dddddddd-0000-0000-0000-000000000001";

/** Sign-in windows: SurreyLearn's always works; Panopto's answers with `panopto`. */
function browser(panopto: () => Promise<string>) {
  const opened: { url: string; done: string; cookieUrl: string }[] = [];
  const value: LoginBrowser = {
    capture: async () => assert.fail("Brightspace signs in with cookies"),
    captureCookies: async (url, done, cookieUrl) => {
      opened.push({ url, done, cookieUrl });
      return url.startsWith(PANOPTO) ? panopto() : VLE_COOKIES;
    },
  };
  return { value, opened };
}

/** SurreyLearn's public versions and whoami; records every Cookie header it is sent. */
function surreyLearn(cookiesSeen: string[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, SURREYLEARN);
    cookiesSeen.push(new Headers(init?.headers).get("cookie") ?? "");
    if (url.pathname === "/d2l/api/versions/") return Response.json([{ ProductCode: "lp", LatestVersion: "1.47" }, { ProductCode: "le", LatestVersion: "1.79" }]);
    if (url.pathname.endsWith("/users/whoami")) return Response.json({ Identifier: "42" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function env(overrides: Partial<CliEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const saved = new Map<string, Credentials>();
  const tokenStore: TokenStore = {
    load: async (site) => saved.get(site) ?? null,
    save: async (c) => void saved.set(c.site, c),
    clear: async (site) => void saved.delete(site),
  };
  const value: CliEnv = {
    tokenStore,
    loginBrowser: { capture: async () => "unused" },
    defaultRoot: join(tmpdir(), "crawler-panopto-signin-unused"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return { env: value, out, err, saved };
}

const noSecrets = (lines: string[]) => {
  for (const secret of ["panopto-secret", "vle-secret"]) assert.ok(!lines.join("\n").includes(secret), `printed ${secret}`);
};

test("Panopto sign-in opens Surrey's single sign-on and reads cookies for the Panopto origin only", async () => {
  const b = browser(async () => PANOPTO_COOKIES);
  assert.equal(await panoptoSignIn("surrey", b.value), PANOPTO_COOKIES);
  assert.deepEqual(b.opened, [{ url: LOGIN_URL, done: `${PANOPTO}/Panopto/Pages/`, cookieUrl: PANOPTO }]);
  // Landing back on a /Panopto/Pages/ page without Panopto's auth cookie is not a sign-in.
  await assert.rejects(panoptoSignIn("surrey", browser(async () => "ASP.NET_SessionId=anon").value), { name: "PanoptoError" });
  await assert.rejects(panoptoSignIn("surrey", { capture: async () => "" }), { name: "PanoptoError" });
  assert.equal(await panoptoSignIn("qmul", b.value), null);
  assert.equal(panoptoOption("qmul", { site: "https://qmplus.qmul.ac.uk", token: "t", privateToken: null }), undefined);
});

test("crawler login --university surrey saves the Panopto session beside SurreyLearn's and never sends it to SurreyLearn", async () => {
  const cookiesSeen: string[] = [];
  const b = browser(async () => PANOPTO_COOKIES);
  const t = env({ loginBrowser: b.value, fetch: surreyLearn(cookiesSeen) });
  assert.equal(await runCli(["login", "--university", "surrey"], t.env), 0);
  assert.deepEqual(t.saved.get(SURREYLEARN), { site: SURREYLEARN, token: "", privateToken: null, cookies: VLE_COOKIES, panoptoCookies: PANOPTO_COOKIES });
  assert.equal(t.saved.size, 1);
  assert.deepEqual(b.opened.map((o) => o.url), [`${SURREYLEARN}/d2l/login`, LOGIN_URL]);
  assert.ok(cookiesSeen.every((cookie) => !cookie.includes("panopto-secret")));
  assert.match(t.out.join("\n"), /Signed in to Panopto/);
  noSecrets([...t.out, ...t.err]);
});

for (const failure of ["closed", "anonymous"] as const) test(`a Panopto sign-in that fails (${failure}) is not fatal`, async () => {
  const b = browser(async () => {
    if (failure === "closed") throw new Error("The sign-in window was closed before signing in finished.");
    return "ASP.NET_SessionId=anon";
  });
  const t = env({ loginBrowser: b.value, fetch: surreyLearn([]) });
  assert.equal(await runCli(["login", "--university", "surrey"], t.env), 0);
  const saved = t.saved.get(SURREYLEARN)!;
  assert.equal(saved.cookies, VLE_COOKIES);
  assert.equal(saved.panoptoCookies, undefined);
  assert.equal(t.out.filter((line) => /Panopto/.test(line)).length, 1);
  assert.match(t.out.join("\n"), /only public lecture recordings/);
  assert.deepEqual(t.err, []);
});

const emptyResult = { courses: [], deadlines: [], changes: [], notifications: [] } as unknown as SyncResult;

test("crawler sync passes the saved Panopto cookies through, and says when only public recordings are read", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-panopto-signin-"));
  try {
    const calls: SyncOptions[] = [];
    const t = env({ sync: async (options) => { calls.push(options); return emptyResult; } });
    t.saved.set(SURREYLEARN, { site: SURREYLEARN, token: "", privateToken: null, cookies: VLE_COOKIES, panoptoCookies: PANOPTO_COOKIES });
    assert.equal(await runCli(["sync", "--university", "surrey", "--root", root], t.env), 0);
    assert.deepEqual(calls[0]!.panopto, { site: PANOPTO, cookies: PANOPTO_COOKIES });
    assert.ok(!t.out.includes(PANOPTO_PUBLIC_ONLY));

    t.saved.set(SURREYLEARN, { site: SURREYLEARN, token: "", privateToken: null, cookies: VLE_COOKIES });
    assert.equal(await runCli(["sync", "--university", "surrey", "--root", root], t.env), 0);
    assert.deepEqual(calls[1]!.panopto, { site: PANOPTO });
    assert.equal(t.out.filter((line) => line === PANOPTO_PUBLIC_ONLY).length, 1);

    assert.equal(await runCli(["sync", "--university", "surrey", "--root", root, "--no-transcripts"], t.env), 0);
    assert.equal(calls[2]!.panopto, undefined);
    assert.equal(calls[2]!.transcripts, false);
    noSecrets([...t.out, ...t.err]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved Panopto cookies reach only the Panopto origin, even for look-alike links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crawler-panopto-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials: Credentials = { site: SURREYLEARN, token: "", privateToken: null, cookies: VLE_COOKIES, panoptoCookies: PANOPTO_COOKIES };
  const seen: { url: string; cookie: string }[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({ url: String(input), cookie: new Headers(init?.headers).get("cookie") ?? "" });
    const url = new URL(String(input));
    if (url.pathname.endsWith("/DeliveryInfo.aspx")) return Response.json({ Delivery: { SessionName: "Lecture", SessionStartTime: 13434627842.965, AvailableLanguages: [1] } });
    if (url.pathname.endsWith("/GenerateSRT.ashx")) return new Response("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  const placement = { section: "Week 1", sectionIndex: 0, activity: "Recordings", activityType: "Link", activityId: 9, activityUrl: `${SURREYLEARN}/topic/9` };
  const result = await syncTranscripts({
    root, now: new Date("2026-10-16T12:00:00Z"), manifest: new Map(), pauseMs: 0, fetch, credentials,
    items: [
      { kind: "link", target: `${PANOPTO}/Panopto/Pages/Viewer.aspx?id=${delivery}`, ...placement },
      { kind: "link", target: `https://surrey.cloud.panopto.eu.evil.example/Panopto/Pages/Viewer.aspx?id=dddddddd-0000-0000-0000-000000000002`, ...placement },
      { kind: "link", target: `https://evil.example/Panopto/Pages/Viewer.aspx?id=dddddddd-0000-0000-0000-000000000003`, ...placement },
    ],
    course: { id: 1, shortname: "COM1001", fullname: "Testing", startdate: null, enddate: null, url: `${SURREYLEARN}/d2l/home/1` },
    placement: { code: "COM1001", title: "Testing", folder: "COM1001 - Testing", year: "2026-27", isModule: true },
    adapter: { id: "surrey" } as unknown as UniversityAdapter,
    panopto: panoptoOption("surrey", credentials)!,
  });
  assert.equal(result.added.length, 1);
  assert.ok(seen.length > 0);
  for (const request of seen) {
    assert.equal(new URL(request.url).origin, PANOPTO);
    assert.equal(request.cookie, PANOPTO_COOKIES);
  }
});
