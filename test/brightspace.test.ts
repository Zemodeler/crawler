import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createBrightspaceAdapter, isoToUnix } from "../src/adapters/brightspace.ts";
import { getUniversity, SURREY } from "../src/adapters/universities.ts";
import { VleError } from "../src/index.ts";
import type { Course, Credentials, LoginBrowser, VleItem } from "../src/index.ts";

const SITE = "https://learn.example.ac.uk";
// Synthetic, not a credential.
const SECRET = ["fake", "session", "value"].join("-");
const COOKIES = `d2lSessionVal=${SECRET}; d2lSecureSessionVal=${SECRET}-secure`;
const CREDENTIALS: Credentials = { site: SITE, token: "", privateToken: null, cookies: COOKIES };
const FIXTURES = new URL("./fixtures/brightspace/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");

type Call = { url: string; cookie: string | null };
type Handler = (call: Call) => Response | Promise<Response>;
const status = (code: number) => () => new Response("no", { status: code });

const ROUTES: [RegExp, string | ((url: URL) => string)][] = [
  [/^\/d2l\/api\/versions\/$/, "versions.json"],
  [/^\/d2l\/api\/lp\/1\.47\/users\/whoami$/, "whoami.json"],
  [/^\/d2l\/api\/lp\/1\.47\/enrollments\/myenrollments\/$/, (u) => (u.searchParams.get("bookmark") === "page2-bookmark" ? "myenrollments_2.json" : "myenrollments_1.json")],
  [/^\/d2l\/api\/le\/1\.79\/\d+\/content\/toc$/, "toc.json"],
  [/^\/d2l\/api\/le\/1\.79\/\d+\/dropbox\/folders\/$/, "dropbox_folders.json"],
  [/^\/d2l\/api\/le\/1\.79\/\d+\/quizzes\/$/, "quizzes.json"],
  [/^\/d2l\/api\/le\/1\.79\/\d+\/calendar\/events\/$/, "calendar_events.json"],
  [/^\/d2l\/api\/le\/1\.79\/\d+\/news\/$/, "news.json"],
];

/** A fake fetch answering Valence routes from the synthetic fixtures; overrides key on a path substring. */
function fakeD2L(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call = { url: url.toString(), cookie: headers.get("cookie") };
    calls.push(call);
    for (const [key, handler] of Object.entries(overrides)) if (url.pathname.includes(key)) return handler(call);
    if (/\/content\/topics\/9002\/file$/.test(url.pathname)) return new Response("<h1>Welcome</h1>");
    if (/\/file$|\/attachments\/\d+$/.test(url.pathname)) return new Response(`bytes of ${url.pathname}`);
    for (const [pattern, name] of ROUTES)
      if (pattern.test(url.pathname)) return new Response(fixture(typeof name === "string" ? name : name(url)));
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const adapterWith = (overrides: Record<string, Handler> = {}) => {
  const fake = fakeD2L(overrides);
  return { adapter: createBrightspaceAdapter({ id: "tst", displayName: "Test University", site: SITE }, fake), calls: fake.calls };
};

const COURSE: Course = { id: 6101, shortname: "TST1001-2026-27", fullname: "TST1001 Testing Basics", startdate: null, enddate: null, url: `${SITE}/d2l/home/6101` };
const ofKind = <K extends VleItem["kind"]>(items: VleItem[], kind: K) =>
  items.filter((item): item is Extract<VleItem, { kind: K }> => item.kind === kind);

test("ISO UTC dates become unix seconds", () => {
  assert.equal(isoToUnix("2026-11-13T12:00:00.000Z"), 1794571200);
  assert.equal(isoToUnix(null), null);
  assert.equal(isoToUnix("not a date"), null);
});

test("whoAmI uses the latest lp version and reports the APIs in use; versions are fetched once", async () => {
  const { adapter, calls } = adapterWith();
  assert.deepEqual(await adapter.whoAmI(CREDENTIALS), { userId: 4242, permittedFunctions: ["lp/1.47", "le/1.79"] });
  await adapter.whoAmI(CREDENTIALS);
  assert.equal(calls.filter((c) => c.url.endsWith("/d2l/api/versions/")).length, 1);
  // The public versions route gets no cookie; the API call does.
  assert.equal(calls.find((c) => c.url.endsWith("/versions/"))?.cookie, null);
  assert.equal(calls.find((c) => c.url.endsWith("/whoami"))?.cookie, COOKIES);
});

test("listCourses follows the bookmark and maps org units", async () => {
  const { adapter, calls } = adapterWith();
  const courses = await adapter.listCourses(CREDENTIALS);
  assert.deepEqual(courses, [
    { id: 6101, shortname: "TST1001-2026-27", fullname: "TST1001 Testing Basics", startdate: 1790553600, enddate: isoToUnix("2027-06-11T23:00:00.000Z"), url: `${SITE}/d2l/home/6101` },
    { id: 6102, shortname: "Study Skills Hub", fullname: "Study Skills Hub", startdate: null, enddate: null, url: `${SITE}/d2l/home/6102` },
  ]);
  const pages = calls.filter((c) => c.url.includes("myenrollments"));
  assert.equal(pages.length, 2);
  assert.equal(new URL(pages[0]!.url).searchParams.get("orgUnitTypeId"), "3");
  assert.equal(new URL(pages[1]!.url).searchParams.get("bookmark"), "page2-bookmark");
});

test("listItems maps the toc, dropbox, quizzes, calendar and news", async () => {
  const { adapter } = adapterWith();
  const items = await adapter.listItems(CREDENTIALS, COURSE);

  const files = ofKind(items, "file");
  assert.deepEqual(files.map((f) => [f.section, f.sectionIndex, f.file.filename, f.file.mimetype]), [
    ["Week 1", 0, "Lecture 1.pdf", "application/pdf"],
    ["Week 1 / Lab", 0, "lab-1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ]);
  assert.deepEqual(files[0]!.file, {
    filename: "Lecture 1.pdf",
    filepath: "/",
    url: `${SITE}/d2l/api/le/1.79/6101/content/topics/9001/file`,
    size: 0,
    mimetype: "application/pdf",
    modified: 1790674200,
  });
  assert.equal(files[0]!.activityUrl, `${SITE}/d2l/le/content/6101/viewContent/9001/View`);

  const pages = ofKind(items, "page");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.html, "<h1>Welcome</h1>");
  assert.deepEqual(ofKind(items, "link").map((l) => l.target), ["https://reading.example.org/list/42"]);
  assert.deepEqual(ofKind(items, "external-tool").map((t) => t.toolName), ["Lecture recordings"]);

  const [cw, reflection] = ofKind(items, "assignment");
  assert.equal(cw!.due, 1794571200);
  assert.equal(cw!.cutoff, isoToUnix("2026-11-20T12:00:00.000Z"));
  assert.equal(cw!.introHtml, "<p>Submit a report.</p>");
  assert.equal(cw!.briefFiles[0]!.url, `${SITE}/d2l/api/le/1.79/6101/dropbox/folders/501/attachments/71`);
  assert.equal(reflection!.due, null);

  const quizzes = ofKind(items, "quiz");
  assert.deepEqual(quizzes.map((q) => [q.id, q.opens, q.closes]), [
    [301, isoToUnix("2026-10-12T09:00:00.000Z"), isoToUnix("2026-10-16T17:00:00.000Z")],
    [302, null, isoToUnix("2026-12-01T00:00:00.000Z")],
  ]);
  assert.deepEqual(ofKind(items, "event").map((e) => [e.id, e.activityType]), [[801, "D2L.LE.Dropbox.Dropbox"], [802, null]]);
  assert.deepEqual(ofKind(items, "announcement").map((a) => [a.id, a.posted]), [[401, isoToUnix("2026-09-28T08:00:00.000Z")]]);
});

test("a feature answering 403 or 404 is skipped, not fatal", async () => {
  const { adapter } = adapterWith({ "/dropbox/": status(403), "/quizzes/": status(404), "/news/": status(403) });
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  assert.equal(ofKind(items, "assignment").length, 0);
  assert.equal(ofKind(items, "quiz").length, 0);
  assert.equal(ofKind(items, "announcement").length, 0);
  assert.equal(ofKind(items, "file").length, 2);
});

test("401 anywhere, or 403 on a core call, means sign in again", async () => {
  const invalid = (error: unknown) => error instanceof VleError && error.code === "invalid_token";
  await assert.rejects(adapterWith({ "/whoami": status(401) }).adapter.whoAmI(CREDENTIALS), invalid);
  await assert.rejects(adapterWith({ "/whoami": status(403) }).adapter.whoAmI(CREDENTIALS), invalid);
  await assert.rejects(adapterWith({ "/content/toc": status(403) }).adapter.listItems(CREDENTIALS, COURSE), invalid);
  await assert.rejects(adapterWith({ "/dropbox/": status(401) }).adapter.listItems(CREDENTIALS, COURSE), invalid);
  await assert.rejects(adapterWith({ "/myenrollments/": () => new Response("", { status: 302, headers: { location: "/d2l/login" } }) }).adapter.listCourses(CREDENTIALS), invalid);
  await assert.rejects(adapterWith().adapter.whoAmI({ site: SITE, token: "", privateToken: null }), invalid);
});

test("the cookie never appears in returned URLs or error messages", async () => {
  const { adapter } = adapterWith();
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  const courses = await adapter.listCourses(CREDENTIALS);
  assert.ok(!JSON.stringify([items, courses]).includes(SECRET));

  const errors: string[] = [];
  const failing = [
    () => adapterWith({ "/whoami": () => { throw new Error(`boom ${COOKIES}`); } }).adapter.whoAmI(CREDENTIALS),
    () => adapterWith({ "/content/toc": status(500) }).adapter.listItems(CREDENTIALS, COURSE),
    () => adapterWith({ "/content/toc": status(418) }).adapter.listItems(CREDENTIALS, COURSE),
    () => adapterWith().adapter.download(CREDENTIALS, { filename: "x", filepath: "/", url: "https://elsewhere.example/x", size: 0, mimetype: null, modified: null }),
  ];
  for (const call of failing) await call().catch((error: Error) => errors.push(error.message));
  assert.equal(errors.length, failing.length);
  for (const message of errors) assert.ok(!message.includes(SECRET), message);
});

test("download sends the cookie only to the site and streams the body", async () => {
  const { adapter, calls } = adapterWith();
  const [file] = ofKind(await adapter.listItems(CREDENTIALS, COURSE), "file");
  const body = await new Response(await adapter.download(CREDENTIALS, file!.file)).text();
  assert.equal(body, "bytes of /d2l/api/le/1.79/6101/content/topics/9001/file");
  assert.equal(calls.at(-1)!.cookie, COOKIES);
});

test("login captures cookies from /d2l/login until /d2l/home, and refuses a browser without captureCookies", async () => {
  const { adapter } = adapterWith();
  const seen: string[] = [];
  const browser: LoginBrowser = {
    capture: async () => "",
    captureCookies: async (url, done, cookieUrl) => {
      seen.push(url, done, cookieUrl);
      return COOKIES;
    },
  };
  assert.deepEqual(await adapter.login(browser), { site: SITE, token: "", privateToken: null, cookies: COOKIES });
  assert.deepEqual(seen, [`${SITE}/d2l/login`, `${SITE}/d2l/home`, SITE]);
  await assert.rejects(adapter.login({ capture: async () => "" }), /cookies/);
});

test("knows Surrey as a Brightspace site, and QMUL stays Moodle", () => {
  assert.deepEqual(SURREY, { id: "surrey", displayName: "University of Surrey", site: "https://surreylearn.surrey.ac.uk" });
  assert.equal(getUniversity("surrey")?.platform, "brightspace");
  assert.equal(getUniversity("qmul")?.platform, "moodle");
  assert.equal(getUniversity("nowhere"), null);
});
