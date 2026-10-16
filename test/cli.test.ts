import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { doctor, parseArgs, runCli } from "../src/index.ts";
import type { CliEnv, Credentials, TokenStore } from "../src/index.ts";

const publicConfig = (data: Record<string, unknown>) =>
  (async () => new Response(JSON.stringify([{ error: false, data }]), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("parseArgs separates commands, positionals and flags", () => {
  const parsed = parseArgs(["courses", "disable", "TST101U", "--root", "C:/data", "--include-past", "--university=qmul"]);
  assert.equal(parsed.command, "courses");
  assert.deepEqual(parsed.positionals, ["disable", "TST101U"]);
  assert.equal(parsed.flags.get("root"), "C:/data");
  assert.equal(parsed.flags.get("include-past"), true);
  assert.equal(parsed.flags.get("university"), "qmul");
  assert.equal(parseArgs([]).command, "help");
});

test("doctor says QMplus-style sites work", async () => {
  const report = await doctor("qmplus.example.ac.uk", publicConfig({ sitename: "Example", enablewebservices: 1, enablemobilewebservice: 1, typeoflogin: 3, identityproviders: [{ name: "Login via SAML2" }] }));
  assert.equal(report.verdict, "works");
  assert.equal(report.site, "https://qmplus.example.ac.uk");
  assert.equal(report.loginType, "embedded");
  assert.deepEqual(report.identityProviders, ["Login via SAML2"]);
});

test("doctor explains each way a site can fail", async () => {
  const off = await doctor("https://a.example", publicConfig({ enablewebservices: 1, enablemobilewebservice: 0, typeoflogin: 1 }));
  assert.equal(off.verdict, "not-enabled");
  const app = await doctor("https://b.example", publicConfig({ enablewebservices: 1, enablemobilewebservice: 1, typeoflogin: 1 }));
  assert.equal(app.verdict, "login-not-supported");
  assert.match(app.lines.join(" "), /never handles passwords/);
  const notMoodle = await doctor("https://c.example", (async () => new Response("<html>nope</html>")) as unknown as typeof fetch);
  assert.equal(notMoodle.verdict, "not-moodle");
  const down = await doctor("https://d.example", (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch);
  assert.equal(down.verdict, "unreachable");
  assert.equal((await doctor("http://", publicConfig({}))).verdict, "unreachable");
});

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
    defaultRoot: join(tmpdir(), "crawler-cli-unused"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return { env: value, out, err, saved };
}

test("help and unknown commands", async () => {
  const a = env();
  assert.equal(await runCli(["help"], a.env), 0);
  assert.match(a.out.join("\n"), /crawler sync/);
  const b = env();
  assert.equal(await runCli(["frobnicate"], b.env), 1);
  assert.match(b.err.join("\n"), /Unknown command/);
});

test("sync and courses ask you to sign in first, and unknown universities are explained", async () => {
  const a = env();
  assert.equal(await runCli(["sync"], a.env), 1);
  assert.match(a.err.join("\n"), /Run: crawler login/);
  const b = env();
  assert.equal(await runCli(["sync", "--university", "nowhere"], b.env), 1);
  assert.match(b.err.join("\n"), /Unknown university "nowhere".*--site/);
});

test("an expired token tells the student to sign in again", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-cli-"));
  try {
    const expired = (async () => new Response(JSON.stringify({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token - token not found" }))) as unknown as typeof fetch;
    const t = env({ fetch: expired });
    t.saved.set("https://qmplus.qmul.ac.uk", { site: "https://qmplus.qmul.ac.uk", token: "stale", privateToken: null });
    assert.equal(await runCli(["sync", "--root", root], t.env), 1);
    assert.match(t.err.join("\n"), /sign-in has expired\. Run: crawler login/);
    assert.ok(!t.err.join("\n").includes("stale"), "the token is never printed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("login captures the redirect, verifies it and stores the credentials", async () => {
  const { createHash } = await import("node:crypto");
  const site = "https://qmplus.qmul.ac.uk";
  let passport = "";
  const calls: string[] = [];
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push(body.get("wsfunction") ?? "");
    return new Response(JSON.stringify({ userid: 7, functions: [{ name: "core_webservice_get_site_info" }, { name: "core_course_get_contents" }] }));
  }) as unknown as typeof fetch;
  const t = env({
    fetch: fetchFake,
    loginBrowser: {
      capture: async (url, scheme) => {
        assert.equal(scheme, "moodlemobile://");
        passport = new URL(url).searchParams.get("passport")!;
        const signature = createHash("md5").update(site + passport).digest("hex");
        return `moodlemobile://token=${Buffer.from(`${signature}:::good-token:::private`).toString("base64")}`;
      },
    },
  });
  assert.equal(await runCli(["login"], t.env), 0);
  assert.deepEqual(t.saved.get(site), { site, token: "good-token", privateToken: "private" });
  assert.match(t.out.join("\n"), /Signed in\. \(2 web-service functions allowed\.\)/);
  assert.ok(!t.out.join("\n").includes("good-token"));
});

test("courses lists what would sync, and enable/disable is remembered", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-cli-"));
  try {
    const site = "https://qmplus.qmul.ac.uk";
    const course = (id: number, short: string, full: string) => ({ id, shortname: short, fullname: full, startdate: 1790000000, enddate: 1800000000 });
    const fetchFake = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      if (body.get("wsfunction") === "core_webservice_get_site_info") return new Response(JSON.stringify({ userid: 7, functions: [] }));
      return new Response(JSON.stringify([course(1, "TST101U 2026/27", "TST101U Testing Basics 2026/27"), course(2, "TST100U 2025/26", "TST100U Old Module 2025/26")]));
    }) as unknown as typeof fetch;
    const t = env({ fetch: fetchFake, now: () => new Date("2026-10-16T09:00:00Z") });
    t.saved.set(site, { site, token: "t", privateToken: null });

    assert.equal(await runCli(["courses", "--root", root], t.env), 0);
    assert.deepEqual(t.out.map((l) => l.slice(0, 3)), ["[x]", "[ ]"]);

    assert.equal(await runCli(["courses", "enable", "Old Module", "--root", root], t.env), 0);
    assert.equal(await runCli(["courses", "disable", "TST101U", "--root", root], t.env), 0);
    assert.equal(await runCli(["courses", "enable", "nonsense", "--root", root], t.env), 1);
    const state = JSON.parse(await readFile(join(root, ".crawler", "state.json"), "utf8"));
    assert.deepEqual(state.courses, { "TST100U 2025/26": { enabled: true }, "TST101U 2026/27": { enabled: false } });

    t.out.length = 0;
    assert.equal(await runCli(["courses", "--root", root], t.env), 0);
    assert.deepEqual(t.out.map((l) => l.slice(0, 3)), ["[ ]", "[x]"]);
    assert.match(t.out.join("\n"), /\(set by you\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
