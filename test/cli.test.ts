import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { doctor, parseArgs, runCli } from "../src/index.ts";
import type { CliEnv, Credentials, TokenStore } from "../src/index.ts";

const publicConfig = (data: Record<string, unknown>) =>
  (async () => new Response(JSON.stringify([{ error: false, data }]), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("desktop Google client config uses environment overrides and file defaults", async () => {
  const modulePath = "../bin/electron-env.mjs";
  const { readGoogleClient } = await import(modulePath);
  const root = await mkdtemp(join(tmpdir(), "crawler-oauth-config-"));
  const file = join(root, "google-oauth.json");
  const key = "client" + "Secret";
  try {
    assert.deepEqual(readGoogleClient({ env: {}, file }), { clientId: null, [key]: undefined });
    await writeFile(file, JSON.stringify({ clientId: "file-id", [key]: "file-value" }));
    assert.deepEqual(readGoogleClient({ env: {}, file }), { clientId: "file-id", [key]: "file-value" });
    const prefix = ["CRAWLER", "GOOGLE", "CLIENT"].join("_");
    const overrides = { [`${prefix}_ID`]: "env-id", [`${prefix}_SECRET`]: "env-value" };
    assert.deepEqual(readGoogleClient({ env: overrides, file }), { clientId: "env-id", [key]: "env-value" });
    await writeFile(file, JSON.stringify({ clientId: 123, [key]: false }));
    assert.deepEqual(readGoogleClient({ env: {}, file }), { clientId: null, [key]: undefined });
    await writeFile(file, "null");
    assert.deepEqual(readGoogleClient({ env: {}, file }), { clientId: null, [key]: undefined });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

import type { CalendarClient, CalendarEventInput, CalendarTokenStore, RemoteEvent } from "../src/calendar-types.ts";
import type { CalendarEnv } from "../src/calendar-run.ts";
import { GoogleAuthError } from "../src/gcal/oauth.ts";
import { deadlineToEvent } from "../src/gcal/events.ts";
import type { Deadline, DeadlineStatus } from "../src/types.ts";
class FakeCalendar implements CalendarClient {
  calendars = new Map<string, string>();
  events = new Map<string, RemoteEvent[]>();
  writes: string[] = [];
  private nextId = 1;
  private nextEtag = 1;

  async ensureCalendar(name: string): Promise<string> {
    let id = this.calendars.get(name);
    if (!id) {
      id = `cal-${this.calendars.size + 1}`;
      this.calendars.set(name, id);
      this.events.set(id, []);
    }
    return id;
  }
  async listEvents(calendarId: string): Promise<RemoteEvent[]> {
    return structuredClone(this.events.get(calendarId) ?? []);
  }
  async insert(calendarId: string, event: CalendarEventInput): Promise<RemoteEvent> {
    this.writes.push(`insert ${event.extendedProperties.private.crawlerId}`);
    const remote: RemoteEvent = { ...structuredClone(event), id: `ev-${this.nextId++}`, etag: this.etag(), status: "confirmed" };
    this.events.get(calendarId)!.push(remote);
    return structuredClone(remote);
  }
  async update(
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
    etag: string,
  ): Promise<RemoteEvent | "precondition-failed"> {
    this.writes.push(`update ${event.extendedProperties.private.crawlerId}`);
    const list = this.events.get(calendarId)!;
    const index = list.findIndex((e) => e.id === eventId);
    if (index < 0 || list[index]!.etag !== etag) return "precondition-failed";
    const remote: RemoteEvent = { ...structuredClone(event), id: eventId, etag: this.etag(), status: "confirmed" };
    list[index] = remote;
    return structuredClone(remote);
  }
  async delete(calendarId: string, eventId: string): Promise<void> {
    this.writes.push(`delete ${eventId}`);
    const list = this.events.get(calendarId)!;
    this.events.set(
      calendarId,
      list.filter((e) => e.id !== eventId),
    );
  }

  /** What the student does in the Google Calendar UI: changes content, which moves the etag. */
  studentEdit(crawlerId: string, change: Partial<RemoteEvent>): void {
    const e = this.byCrawlerId(crawlerId);
    if (e) Object.assign(e, change, { etag: this.etag() });
  }
  /** A second event with the same crawlerId (a retried insert, a copy the student made). */
  duplicate(crawlerId: string, change: Partial<RemoteEvent> = {}): string {
    const original = this.byCrawlerId(crawlerId)!;
    const copy: RemoteEvent = { ...structuredClone(original), ...change, id: `ev-${this.nextId++}`, etag: this.etag() };
    for (const list of this.events.values()) if (list.includes(original)) list.push(copy);
    return copy.id;
  }
  all(): RemoteEvent[] {
    return [...this.events.values()].flat();
  }
  byCrawlerId(id: string): RemoteEvent | undefined {
    return this.all().find((e) => e.extendedProperties?.private?.crawlerId === id);
  }
  private etag(): string {
    return `"${this.nextEtag++}"`;
  }
}

function deadline(id: string, status: DeadlineStatus = "confirmed", overrides: Partial<Deadline> = {}): Deadline {
  return {
    id,
    module: "ECS401U",
    year: "2026-27",
    title: `Coursework ${id}`,
    kind: "coursework",
    status,
    due: { iso: "2026-12-14T10:00:00.000Z", allDay: false, tz: "Europe/London" },
    sources: [
      {
        type: "vle-field",
        strength: "structured",
        url: `https://vle.example/mod/assign/view.php?id=${id}`,
        quote: "Due: Mon 14 Dec 2026, 10:00",
        date: { iso: "2026-12-14T10:00:00.000Z", allDay: false, tz: "Europe/London" },
        seenAt: "2026-10-15T17:00:00.000Z",
      },
    ],
    history: [],
    ...overrides,
  };
}


function calendarEnv(connected = true) {
  let token: { refreshToken: string } | null = connected ? { refreshToken: "secret-refresh" } : null;
  const tokens: CalendarTokenStore = {
    load: async () => token,
    save: async (value) => { token = value; },
    clear: async () => { token = null; },
  };
  const client = new FakeCalendar();
  const calendar: CalendarEnv = { tokens, client, clientId: "test-client", openBrowser: async () => {} };
  return { calendar, client };
}

test("calendar connect explains setup; status and disconnect preserve remote events", async () => {
  const { calendar, client } = calendarEnv();
  calendar.clientId = null;
  const t = env({ calendar });
  assert.equal(await runCli(["calendar", "connect"], t.env), 1);
  assert.match(t.err.join(" "), /CRAWLER_GOOGLE_CLIENT_ID.*clientId, clientSecret.*<userData>\/google-oauth.json/);
  await client.ensureCalendar("University deadlines");
  assert.equal(await runCli(["calendar", "status"], t.env), 0);
  assert.match(t.out.join(" "), /connected/);
  assert.equal(await runCli(["calendar", "disconnect"], t.env), 0);
  assert.equal(await calendar.tokens.load(), null);
  assert.equal(client.calendars.size, 1);
  assert.match(t.out.join(" "), /not been deleted/);
  assert.equal(await runCli(["calendar", "sync"], t.env), 1);
});

test("calendar sync prints counts, edited summaries and skips by reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-calendar-"));
  try {
    const { calendar, client } = calendarEnv();
    const id = await client.ensureCalendar("University deadlines");
    for (const key of ["updated", "edited", "deleted"]) {
      const event = deadlineToEvent(deadline(key));
      assert.ok(!("skip" in event));
      await client.insert(id, event);
    }
    client.studentEdit("edited", { summary: "My own reminder" });
    await writeFile(join(root, "Deadlines.json"), JSON.stringify([
      deadline("new"), deadline("updated", "confirmed", { title: "Changed title" }),
      deadline("edited"), deadline("skip", "needs-check"), deadline("skip2", "needs-check"),
    ]));
    const t = env({ calendar });
    assert.equal(await runCli(["calendar", "sync", "--root", root], t.env), 0);
    assert.match(t.out.join(" "), /1 created, 1 updated, 1 deleted/);
    assert.match(t.out.join(" "), /My own reminder/);
    assert.match(t.out.join(" "), /2 needs-check/);
    assert.ok(!t.out.join(" ").includes("secret-refresh"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sync reports documents it could not check without exposing authenticated URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-cli-coverage-"));
  const site = "https://qmplus.qmul.ac.uk";
  try {
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      const params = init?.body instanceof URLSearchParams ? init.body : null;
      if (!params) return new Response("not an Office archive");
      const method = params.get("wsfunction");
      let payload: unknown = [];
      if (method === "core_webservice_get_site_info") payload = { userid: 7 };
      if (method === "core_enrol_get_users_courses") payload = [{ id: 1, shortname: "TST101U 2026/27", fullname: "TST101U Testing Basics 2026/27", startdate: 1790000000, enddate: 1800000000 }];
      if (method === "core_course_get_contents") payload = [{ id: 1, name: "Materials", modules: [{ id: 10, modname: "resource", name: "Brief", url: `${site}/mod/resource/view.php?id=10`, contents: [{ type: "file", filename: "Brief.docx", fileurl: `${site}/pluginfile.php/10/Brief.docx`, filesize: 21, timemodified: 1790000000 }] }] }];
      return new Response(JSON.stringify(payload));
    }) as typeof fetch;
    const t = env({ fetch: fetchFake, now: () => new Date("2026-10-16T09:00:00Z") });
    t.saved.set(site, { site, token: "must-not-appear", privateToken: null });
    assert.equal(await runCli(["sync", "--root", root], t.env), 0);
    assert.match(t.out.join("\n"), /Not checked for deadlines: Brief.docx - No text could be extracted/);
    assert.ok(!t.out.join("\n").includes("must-not-appear"));
    assert.ok(!t.out.join("\n").includes("pluginfile.php"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful sync automatically syncs calendar; revoked access only warns", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-auto-calendar-"));
  try {
    const { calendar, client } = calendarEnv();
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      const params = init?.body as URLSearchParams;
      return new Response(JSON.stringify(params.get("wsfunction") === "core_webservice_get_site_info" ? { userid: 7 } : []));
    }) as typeof fetch;
    const t = env({ calendar, fetch: fetchFake });
    const site = "https://qmplus.qmul.ac.uk";
    t.saved.set(site, { site, token: "vle-token", privateToken: null });
    assert.equal(await runCli(["sync", "--root", root], t.env), 0);
    assert.match(t.out.join(" "), /Google Calendar: 0 created/);
    assert.equal(client.calendars.size, 1);
    client.ensureCalendar = async () => { throw new GoogleAuthError("revoked", "Revoked"); };
    assert.equal(await runCli(["sync", "--root", root], t.env), 0);
    assert.match(t.err.join(" "), /Warning: Google Calendar access was revoked; run crawler calendar connect/);
    assert.equal(await runCli(["calendar", "sync", "--root", root], t.env), 1);
    assert.ok(!t.err.join(" ").includes("secret-refresh"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schedule shows freshness and due status and persists --every", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-schedule-"));
  try {
    const t = env({ defaultRoot: root, now: () => new Date("2026-10-16T09:00:00Z") });
    assert.equal(await runCli(["schedule"], t.env), 0);
    assert.match(t.out.pop()!, /never synced; sync due; every 3/);
    await mkdir(join(root, ".crawler"), { recursive: true });
    await writeFile(join(root, ".crawler", "state.json"), JSON.stringify({ version: 1, courses: {}, lastSync: "2026-10-14T09:00:00Z" }));
    assert.equal(await runCli(["schedule", "--root", root], t.env), 0);
    assert.match(t.out.pop()!, /last synced 2 days ago; sync not due/);
    assert.equal(await runCli(["schedule", "--every", "1"], t.env), 0);
    assert.match(t.out.pop()!, /sync due; every 1/);
    assert.deepEqual(JSON.parse(await readFile(join(root, ".crawler", "schedule.json"), "utf8")), { everyDays: 1 });
    assert.equal(await runCli(["schedule"], t.env), 0);
    assert.match(t.out.pop()!, /every 1/);
    assert.equal(await runCli(["schedule", "--every", "2"], t.env), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schedule --every repairs an unreadable or invalid schedule.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "crawler-schedule-bad-"));
  try {
    const t = env({ defaultRoot: root, now: () => new Date("2026-10-16T09:00:00Z") });
    await mkdir(join(root, ".crawler"), { recursive: true });
    for (const bad of ["null", "{\"everyDays\": 5}", "not json"]) {
      await writeFile(join(root, ".crawler", "schedule.json"), bad);
      assert.equal(await runCli(["schedule"], t.env), 1);
      assert.match(t.err.pop()!, /crawler schedule --every 3/);
      assert.equal(await runCli(["schedule", "--every", "3"], t.env), 0);
      assert.deepEqual(JSON.parse(await readFile(join(root, ".crawler", "schedule.json"), "utf8")), { everyDays: 3 });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
