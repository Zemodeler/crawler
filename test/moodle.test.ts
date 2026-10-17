import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createMoodleAdapter, decodeLaunch, flattenParams, stripToken } from "../src/adapters/moodle.ts";
import { getUniversity, QMUL } from "../src/adapters/universities.ts";
import { VleError } from "../src/index.ts";
import type { Course, Credentials, VleItem } from "../src/index.ts";

const SITE = "https://moodle.example.ac.uk";
// Synthetic, not a credential. The fixtures use the same value in their token parameters.
const TOKEN = ["fake", "test", "token"].join("-");
const CREDENTIALS: Credentials = { site: SITE, token: TOKEN, privateToken: null };
const FIXTURES = new URL("./fixtures/moodle/", import.meta.url);

const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { method: string; url: string; params: URLSearchParams };
type Handler = (call: Call) => Response | Promise<Response>;

/** A fake fetch that answers web-service calls from the synthetic fixtures, by wsfunction. */
function fakeMoodle(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const params = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const call = { method, url, params };
    calls.push(call);
    const wsfunction = params.get("wsfunction");
    if (wsfunction) {
      const handler = overrides[wsfunction];
      if (handler) return handler(call);
      return new Response(fixture(`${wsfunction}.json`), { headers: { "content-type": "application/json" } });
    }
    const handler = overrides.GET;
    if (handler) return handler(call);
    if (url.includes("/mod_page/content/index.html")) return new Response(fixture("page_index.html"));
    return new Response(`bytes of ${new URL(url).pathname}`);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const adapterWith = (overrides: Record<string, Handler> = {}) => {
  const fake = fakeMoodle(overrides);
  return { adapter: createMoodleAdapter({ id: "tst", displayName: "Test University", site: SITE }, fake), calls: fake.calls };
};

const COURSE: Course = {
  id: 101,
  shortname: "TST101U 2026/27",
  fullname: "TST101U Testing Basics 2026/27",
  startdate: 1790035200,
  enddate: 1800403200,
  url: `${SITE}/course/view.php?id=101`,
};

const ofKind = <K extends VleItem["kind"]>(items: VleItem[], kind: K) =>
  items.filter((item): item is Extract<VleItem, { kind: K }> => item.kind === kind);

test("LTI items expose module instance and launch uses toolid with signed fields", async () => {
  const { adapter, calls } = adapterWith({
    core_course_get_contents: () => json([{ name: "Recordings", modules: [{ id: 7, instance: 42, name: "Echo360", modname: "lti" }] }]),
    mod_lti_get_tool_launch_data: () => json({ endpoint: "https://echo.example/lti", parameters: [{ name: "oauth_signature", value: "synthetic-signature" }, { name: "lis_person_name_full", value: null }, { name: "resource_link_id", value: 7 }] }),
  });
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  assert.equal(ofKind(items, "external-tool")[0]?.instance, 42);
  const launch = await adapter.ltiLaunch!(CREDENTIALS, 42);
  assert.equal(launch.endpoint, "https://echo.example/lti");
  assert.equal(launch.fields.get("oauth_signature"), "synthetic-signature");
  // QMplus sends some parameters as null; they post as empty fields, numbers as text.
  assert.equal(launch.fields.get("lis_person_name_full"), "");
  assert.equal(launch.fields.get("resource_link_id"), "7");
  assert.equal(calls.find((c) => c.params.get("wsfunction") === "mod_lti_get_tool_launch_data")?.params.get("toolid"), "42");
});

const exception = (exception: string, errorcode: string, message: string) => () =>
  json({ exception, errorcode, message });

async function rejectsWith(promise: Promise<unknown>, code: VleError["code"]): Promise<VleError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof VleError, `expected VleError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected a VleError(${code})`);
}

/* ------------------------------------------------------------- web-service client */

test("flattens array and nested params the way Moodle expects", () => {
  assert.deepEqual(flattenParams({ courseids: [5, 6] }), [
    ["courseids[0]", "5"],
    ["courseids[1]", "6"],
  ]);
  assert.deepEqual(flattenParams({ events: { courseids: [5] }, options: { timestart: 10, userevents: false } }), [
    ["events[courseids][0]", "5"],
    ["options[timestart]", "10"],
    ["options[userevents]", "0"],
  ]);
  assert.deepEqual(flattenParams({ userid: 7, skip: undefined }), [["userid", "7"]]);
});

test("posts form-encoded calls to the REST endpoint", async () => {
  const { adapter, calls } = adapterWith();
  await adapter.listItems(CREDENTIALS, COURSE);
  const call = calls.find((c) => c.params.get("wsfunction") === "core_course_get_contents");
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(call.url, `${SITE}/webservice/rest/server.php`);
  assert.equal(call.params.get("wstoken"), TOKEN);
  assert.equal(call.params.get("moodlewsrestformat"), "json");
  assert.equal(call.params.get("courseid"), "101");
  const assign = calls.find((c) => c.params.get("wsfunction") === "mod_assign_get_assignments");
  assert.equal(assign?.params.get("courseids[0]"), "101");
  const forums = calls.find((c) => c.params.get("wsfunction") === "mod_forum_get_forums_by_courses");
  assert.equal(forums?.params.get("courseids[0]"), "101");
  const discussions = calls.find((c) => c.params.get("wsfunction") === "mod_forum_get_forum_discussions");
  assert.equal(discussions?.params.get("forumid"), "301");
  assert.equal(discussions?.params.get("perpage"), "50");
});

test("asks the calendar for the course's dates with a margin", async () => {
  const { adapter, calls } = adapterWith();
  await adapter.listItems(CREDENTIALS, COURSE);
  const call = calls.find((c) => c.params.get("wsfunction") === "core_calendar_get_calendar_events");
  assert.ok(call);
  assert.equal(call.params.get("events[courseids][0]"), "101");
  assert.equal(call.params.get("options[timestart]"), String(COURSE.startdate! - 60 * 86400));
  assert.equal(call.params.get("options[timeend]"), String(COURSE.enddate! + 120 * 86400));

  const undated = adapterWith();
  const before = Math.floor(Date.now() / 1000);
  await undated.adapter.listItems(CREDENTIALS, { ...COURSE, startdate: null, enddate: null });
  const params = undated.calls.find((c) => c.params.get("wsfunction") === "core_calendar_get_calendar_events")!.params;
  const start = Number(params.get("options[timestart]"));
  assert.ok(Math.abs(start - (before - 365 * 86400)) < 5);
  assert.equal(Number(params.get("options[timeend]")), start + 400 * 86400);
});

test("maps Moodle exceptions to VleError codes", async () => {
  await rejectsWith(
    adapterWith({ core_webservice_get_site_info: exception("moodle_exception", "invalidtoken", "Invalid token") }).adapter.whoAmI(CREDENTIALS),
    "invalid_token",
  );
  await rejectsWith(
    adapterWith({
      core_webservice_get_site_info: exception("webservice_access_exception", "accessexception", "Access control exception"),
    }).adapter.whoAmI(CREDENTIALS),
    "access_denied",
  );
  await rejectsWith(
    adapterWith({ core_webservice_get_site_info: exception("required_capability_exception", "nopermissions", "Sorry") }).adapter.whoAmI(
      CREDENTIALS,
    ),
    "access_denied",
  );
  await rejectsWith(
    adapterWith({ core_webservice_get_site_info: () => new Response("<html>maintenance</html>") }).adapter.whoAmI(CREDENTIALS),
    "bad_response",
  );
  await rejectsWith(
    adapterWith({ core_webservice_get_site_info: exception("invalid_parameter_exception", "invalidparameter", "Bad") }).adapter.whoAmI(
      CREDENTIALS,
    ),
    "bad_response",
  );
});

test("retries 5xx and 429 twice, then gives up as unavailable", async () => {
  let attempts = 0;
  const flaky = adapterWith({
    core_webservice_get_site_info: () => (++attempts < 3 ? new Response("busy", { status: attempts === 1 ? 503 : 429 }) : json({ userid: 1, functions: [] })),
  });
  assert.deepEqual(await flaky.adapter.whoAmI(CREDENTIALS), { userId: 1, permittedFunctions: [] });
  assert.equal(attempts, 3);

  const down = adapterWith({ core_webservice_get_site_info: () => new Response("down", { status: 502 }) });
  await rejectsWith(down.adapter.whoAmI(CREDENTIALS), "unavailable");
  assert.equal(down.calls.length, 3);
});

test("retries network failures, then gives up as unavailable", async () => {
  const offline = adapterWith({
    core_webservice_get_site_info: () => {
      throw new TypeError("fetch failed");
    },
  });
  await rejectsWith(offline.adapter.whoAmI(CREDENTIALS), "unavailable");
  assert.equal(offline.calls.length, 3);
});

test("keeps at most 4 requests in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow: Handler = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return json({ userid: 1, functions: [] });
  };
  const { adapter } = adapterWith({ core_webservice_get_site_info: slow });
  await Promise.all(Array.from({ length: 12 }, () => adapter.whoAmI(CREDENTIALS)));
  assert.equal(peak, 4);
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A response whose body arrives in two slow chunks; `open` counts bodies not yet finished. */
function slowBodies(text: string) {
  const counter = { open: 0, peak: 0, started: 0, cancelled: 0 };
  const respond = () => {
    counter.open++;
    counter.started++;
    counter.peak = Math.max(counter.peak, counter.open);
    const half = Math.ceil(text.length / 2);
    const chunks = [text.slice(0, half), text.slice(half)];
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await delay(5);
          const next = chunks.shift();
          if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
          else {
            counter.open--;
            controller.close();
          }
        },
        cancel() {
          counter.open--;
          counter.cancelled++;
        },
      }),
    );
  };
  return { counter, respond };
}

test("holds the slot until a JSON body is read", async () => {
  const { counter, respond } = slowBodies(JSON.stringify({ userid: 1, functions: [] }));
  const { adapter } = adapterWith({ core_webservice_get_site_info: respond });
  const answers = await Promise.all(Array.from({ length: 10 }, () => adapter.whoAmI(CREDENTIALS)));
  assert.equal(answers.length, 10);
  assert.equal(counter.started, 10);
  assert.equal(counter.peak, 4);
});

test("retries a body cut off mid-read, then gives up as unavailable", async () => {
  const cutOff = (url: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"userid":'));
          controller.error(new TypeError(`terminated: ${url}`));
        },
      }),
    );
  let attempts = 0;
  const flaky = adapterWith({
    core_webservice_get_site_info: (call) => (++attempts === 1 ? cutOff(call.url) : json({ userid: 1, functions: [] })),
  });
  assert.deepEqual(await flaky.adapter.whoAmI(CREDENTIALS), { userId: 1, permittedFunctions: [] });
  assert.equal(attempts, 2);

  const broken = adapterWith({ GET: (call) => cutOff(call.url) });
  const pages = await rejectsWith(broken.adapter.listItems(CREDENTIALS, COURSE), "unavailable");
  assert.ok(!pages.message.includes(TOKEN));
  assert.equal(broken.calls.filter((c) => c.method === "GET").length, 3);
});

const FILE = { filename: "a.pdf", filepath: "/", url: `${SITE}/webservice/pluginfile.php/1/a.pdf`, size: 1, mimetype: null, modified: null };

test("a download keeps its slot until its stream is read to the end", async () => {
  const { counter, respond } = slowBodies("file bytes");
  const { adapter } = adapterWith({ GET: respond });
  const bodies = await Promise.all(
    Array.from({ length: 6 }, async () => new Response(await adapter.download(CREDENTIALS, FILE)).text()),
  );
  assert.deepEqual(bodies, Array(6).fill("file bytes"));
  assert.equal(counter.started, 6);
  assert.equal(counter.peak, 4);
});

test("a cancelled download frees its slot", async () => {
  const counter = { started: 0, cancelled: 0 };
  // Bodies that never end on their own.
  const { adapter } = adapterWith({
    GET: () => {
      counter.started++;
      return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => void counter.cancelled++ }));
    },
  });
  const streams = await Promise.all(Array.from({ length: 4 }, () => adapter.download(CREDENTIALS, FILE)));
  let fifthReady = false;
  const fifth = adapter.download(CREDENTIALS, FILE).then((stream) => {
    fifthReady = true;
    return stream;
  });
  await delay(20);
  assert.equal(fifthReady, false);
  assert.equal(counter.started, 4);

  await streams[0]!.cancel();
  const stream = await fifth;
  assert.equal(counter.started, 5);
  assert.equal(counter.cancelled, 1);
  await Promise.all([...streams.slice(1), stream].map((s) => s.cancel()));
  assert.equal(counter.cancelled, 5);
});

test("a download nobody reads is abandoned and frees its slot", async () => {
  const counter = { started: 0, cancelled: 0 };
  const fake = fakeMoodle({
    GET: () => {
      counter.started++;
      return new Response(
        new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(4)), cancel: () => void counter.cancelled++ }),
      );
    },
  });
  const adapter = createMoodleAdapter({ id: "tst", displayName: "Test University", site: SITE }, { ...fake, streamIdleMs: 30 });
  // Four streams that are never read hold every slot...
  const abandoned = await Promise.all(Array.from({ length: 4 }, () => adapter.download(CREDENTIALS, FILE)));
  // ...until the idle timeout frees them, so a fifth download can start.
  const fifth = await adapter.download(CREDENTIALS, FILE);
  assert.equal(counter.started, 5);
  // A stream that is read steadily is not abandoned, however long it takes.
  const reader = fifth.getReader();
  for (let i = 0; i < 10; i++) {
    assert.equal((await reader.read()).done, false);
    await delay(10);
  }
  assert.equal(counter.cancelled, 4); // the four unread ones, not the fifth
  // Reading an abandoned stream fails clearly, without the token.
  await assert.rejects(abandoned[0]!.getReader().read(), (error: unknown) => {
    assert.ok(error instanceof VleError);
    assert.equal(error.code, "unavailable");
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  await reader.cancel();
  assert.equal(counter.cancelled, 5);
});

test("a download cut off mid-stream errors as unavailable and frees its slot", async () => {
  let started = 0;
  // The first body breaks once read; the others never end on their own.
  const { adapter } = adapterWith({
    GET: (call) => {
      const first = ++started === 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: first ? (controller) => controller.error(new TypeError(`terminated: ${call.url}`)) : () => new Promise(() => {}),
        }),
      );
    },
  });
  const streams = await Promise.all(Array.from({ length: 4 }, () => adapter.download(CREDENTIALS, FILE)));
  const error = await rejectsWith(new Response(streams[0]).text(), "unavailable");
  assert.ok(!error.message.includes(TOKEN));
  const fifth = await adapter.download(CREDENTIALS, FILE);
  assert.equal(started, 5);
  await Promise.all([...streams.slice(1), fifth].map((s) => s.cancel()));
});

/* ------------------------------------------------------------- token redaction */

test("never puts the token in errors or returned URLs", async () => {
  const leaks = (value: unknown) => {
    const error = value as Error;
    const text = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${String(error.cause ?? "")}`;
    assert.ok(!text.includes(TOKEN), `token leaked: ${text}`);
  };

  // A Moodle message that echoes the token back.
  const echo = adapterWith({ core_webservice_get_site_info: exception("moodle_exception", "invalidtoken", `Invalid token ${TOKEN}`) });
  leaks(await rejectsWith(echo.adapter.whoAmI(CREDENTIALS), "invalid_token"));

  // A network error whose text quotes the tokenised download URL.
  const offline = adapterWith({
    GET: (call) => {
      throw new TypeError(`fetch failed: ${call.url}`);
    },
  });
  const file = { filename: "a.pdf", filepath: "/", url: `${SITE}/webservice/pluginfile.php/1/a.pdf`, size: 1, mimetype: null, modified: null };
  leaks(await rejectsWith(offline.adapter.download(CREDENTIALS, file), "unavailable"));

  const missing = adapterWith({ GET: () => new Response("gone", { status: 404 }) });
  leaks(await rejectsWith(missing.adapter.download(CREDENTIALS, file), "bad_response"));

  const { adapter } = adapterWith();
  const everything = JSON.stringify([await adapter.listCourses(CREDENTIALS), await adapter.listItems(CREDENTIALS, COURSE)]);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!/[?&](ws)?token=/.test(everything), "a returned URL still carries a token parameter");
});

test("strips token parameters from URLs", () => {
  assert.equal(stripToken(`${SITE}/webservice/pluginfile.php/1/a.pdf?forcedownload=1&token=abc`), `${SITE}/webservice/pluginfile.php/1/a.pdf?forcedownload=1`);
  assert.equal(stripToken(`${SITE}/webservice/pluginfile.php/1/a.pdf?token=abc`), `${SITE}/webservice/pluginfile.php/1/a.pdf`);
  assert.equal(stripToken(`${SITE}/mod/url/view.php?wstoken=abc&id=5`), `${SITE}/mod/url/view.php?id=5`);
  assert.equal(stripToken(`${SITE}/x.pdf`), `${SITE}/x.pdf`);
});

test("strips token and wstoken from activity URLs, link targets and file URLs", async () => {
  const sections = [
    {
      id: 1,
      name: "Week 1",
      section: 1,
      modules: [
        {
          id: 11,
          name: "Slides",
          modname: "resource",
          url: `${SITE}/mod/resource/view.php?id=11&token=${TOKEN}`,
          contents: [{ type: "file", filename: "s.pdf", fileurl: `${pluginfile("1/s.pdf")}?wstoken=${TOKEN}&forcedownload=1` }],
        },
        {
          id: 12,
          name: "Video",
          modname: "url",
          url: `${SITE}/mod/url/view.php?wstoken=${TOKEN}&id=12`,
          contents: [{ type: "url", fileurl: `https://video.example.org/watch?v=1&token=${TOKEN}&wstoken=${TOKEN}` }],
        },
      ],
    },
  ];
  const { adapter } = adapterWith({ core_course_get_contents: () => json(sections) });
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  const [file] = ofKind(items, "file");
  assert.equal(file?.activityUrl, `${SITE}/mod/resource/view.php?id=11`);
  assert.equal(file?.file.url, `${pluginfile("1/s.pdf")}?forcedownload=1`);
  const [link] = ofKind(items, "link");
  assert.equal(link?.activityUrl, `${SITE}/mod/url/view.php?id=12`);
  assert.equal(link?.target, "https://video.example.org/watch?v=1");
  assert.ok(!JSON.stringify(items).includes(TOKEN));
});

/* ------------------------------------------------------------- login */

const signed = (site: string, passport: string, payload: string) =>
  `moodlemobile://token=${Buffer.from(`${createHash("md5").update(site + passport).digest("hex")}:::${payload}`).toString("base64")}`;

test("login opens launch.php and decodes the signed token", async () => {
  const { adapter } = adapterWith();
  let opened = "";
  let scheme = "";
  const credentials = await adapter.login({
    async capture(url, captureScheme) {
      opened = url;
      scheme = captureScheme;
      const passport = new URL(url).searchParams.get("passport")!;
      return signed(SITE, passport, `${TOKEN}:::private-abc`);
    },
  });
  const launch = new URL(opened);
  assert.equal(`${launch.origin}${launch.pathname}`, `${SITE}/admin/tool/mobile/launch.php`);
  assert.equal(launch.searchParams.get("service"), "moodle_mobile_app");
  assert.equal(launch.searchParams.get("urlscheme"), "moodlemobile");
  assert.match(launch.searchParams.get("passport")!, /^[0-9a-f]{32}$/);
  assert.equal(scheme, "moodlemobile://");
  assert.deepEqual(credentials, { site: SITE, token: TOKEN, privateToken: "private-abc" });
});

test("login accepts the trailing-slash signature and a missing private token", () => {
  assert.deepEqual(decodeLaunch(signed(`${SITE}/`, "p1", TOKEN), SITE, "p1"), { site: SITE, token: TOKEN, privateToken: null });
});

test("login refuses a token signed for another site or passport", async () => {
  const forged = signed("https://evil.example.com", "p1", TOKEN);
  const error = await rejectsWith(Promise.resolve().then(() => decodeLaunch(forged, SITE, "p1")), "bad_response");
  assert.ok(!error.message.includes(TOKEN));
  await rejectsWith(Promise.resolve().then(() => decodeLaunch(signed(SITE, "other", TOKEN), SITE, "p1")), "bad_response");
  await rejectsWith(Promise.resolve().then(() => decodeLaunch("moodlemobile://nothing", SITE, "p1")), "bad_response");

  const { adapter } = adapterWith();
  await rejectsWith(adapter.login({ capture: async () => forged }), "bad_response");
});

/* ------------------------------------------------------------- identity and courses */

test("whoAmI reads the user id and permitted functions", async () => {
  const { adapter } = adapterWith();
  const me = await adapter.whoAmI(CREDENTIALS);
  assert.equal(me.userId, 4242);
  assert.deepEqual(me.permittedFunctions, [
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_contents",
    "mod_assign_get_assignments",
  ]);
});

test("listCourses uses the cached user id and maps courses", async () => {
  const { adapter, calls } = adapterWith();
  await adapter.whoAmI(CREDENTIALS);
  const courses = await adapter.listCourses(CREDENTIALS);
  assert.equal(calls.filter((c) => c.params.get("wsfunction") === "core_webservice_get_site_info").length, 1);
  assert.equal(calls.at(-1)!.params.get("userid"), "4242");
  assert.deepEqual(courses, [
    COURSE,
    {
      id: 102,
      shortname: "TST-INTEGRITY",
      fullname: "Academic Integrity Practice Site",
      startdate: null,
      enddate: null,
      url: `${SITE}/course/view.php?id=102`,
    },
  ]);

  const fresh = adapterWith();
  await fresh.adapter.listCourses(CREDENTIALS);
  assert.deepEqual(
    fresh.calls.map((c) => c.params.get("wsfunction")),
    ["core_webservice_get_site_info", "core_enrol_get_users_courses"],
  );
});

/* ------------------------------------------------------------- items */

const pluginfile = (path: string) => `${SITE}/webservice/pluginfile.php/${path}`;

test("maps resources and folder files to file items with their placement", async () => {
  const { adapter } = adapterWith();
  const files = ofKind(await adapter.listItems(CREDENTIALS, COURSE), "file");
  assert.deepEqual(files, [
    {
      kind: "file",
      file: {
        filename: "TST101U Lecture 1.pdf",
        filepath: "/",
        url: pluginfile("7101/mod_resource/content/2/TST101U%20Lecture%201.pdf?forcedownload=1"),
        size: 1048576,
        mimetype: "application/pdf",
        modified: 1790300000,
      },
      section: "Week 1: What is a test?",
      sectionIndex: 1,
      activity: "Lecture 1 slides",
      activityType: "resource",
      activityId: 5101,
      activityUrl: `${SITE}/mod/resource/view.php?id=5101`,
    },
    {
      kind: "file",
      file: {
        filename: "lab1.pdf",
        filepath: "/Week 1/",
        url: pluginfile("7102/mod_folder/content/0/Week%201/lab1.pdf?forcedownload=1"),
        size: 2048,
        mimetype: "application/pdf",
        modified: 1790200500,
      },
      section: "Week 1: What is a test?",
      sectionIndex: 1,
      activity: "Lab sheets",
      activityType: "folder",
      activityId: 5102,
      activityUrl: `${SITE}/mod/folder/view.php?id=5102`,
    },
    {
      kind: "file",
      file: {
        filename: "lab1-starter.zip",
        filepath: "/Week 1/code/",
        url: pluginfile("7102/mod_folder/content/0/Week%201/code/lab1-starter.zip?forcedownload=1"),
        size: 4096,
        mimetype: "application/zip",
        modified: null,
      },
      section: "Week 1: What is a test?",
      sectionIndex: 1,
      activity: "Lab sheets",
      activityType: "folder",
      activityId: 5102,
      activityUrl: `${SITE}/mod/folder/view.php?id=5102`,
    },
  ]);
});

test("keeps a section summary and labels in order as one page", async () => {
  const summary = "<p>Lab marking schedule</p>";
  const first = "<table><tr><th>Seq</th><th>Type</th><th>Description</th><th>Weight</th></tr><tr><td>1</td><td>Lab</td><td>Assessment Overview</td><td>20%</td></tr></table>";
  const last = "<p>Submit by Friday.</p>";
  const { adapter } = adapterWith({
    core_course_get_contents: () => json([{
      id: 42, name: "General", section: 3, summary,
      modules: [
        { id: 7, name: "Overview", modname: "label", description: first },
        { id: 8, name: "Ignored", modname: "questionnaire", description: "Not section text" },
        { id: 9, name: "Deadline", modname: "label", description: last },
      ],
    }]),
  });
  assert.deepEqual(ofKind(await adapter.listItems(CREDENTIALS, COURSE), "page"), [{
    kind: "page", html: [summary, first, last].join("\n"), files: [],
    section: "General", sectionIndex: 3, activity: "General (section text)",
    activityType: "section", activityId: -42, activityUrl: `${SITE}/course/section.php?id=42`,
  }]);
});

test("keeps summary-only and label-only sections with fallback section names and indices", async () => {
  const { adapter } = adapterWith({
    core_course_get_contents: () => json([
      { id: 43, name: "", section: 5, summary: "<p>Summary only</p>" },
      { id: 44, name: "", modules: [{ id: 10, name: "Label", modname: "label", description: "<p>Label only</p>" }] },
    ]),
  });
  const pages = ofKind(await adapter.listItems(CREDENTIALS, COURSE), "page");
  assert.deepEqual(pages.map((p) => [p.activity, p.sectionIndex, p.html]), [
    ["Section 5 (section text)", 5, "<p>Summary only</p>"],
    ["Section 1 (section text)", 1, "<p>Label only</p>"],
  ]);
});

test("skips sections whose summaries and labels have no text after stripping tags", async () => {
  const { adapter } = adapterWith({
    core_course_get_contents: () => json([
      { id: 45, name: "Empty" },
      { id: 46, name: "Blank", summary: "<p> \n </p><br>", modules: [
        { id: 11, name: "Label title is not content", modname: "label", description: "<div>\t </div>" },
        { id: 12, name: "Missing description", modname: "label" },
      ] },
    ]),
  });
  assert.deepEqual(ofKind(await adapter.listItems(CREDENTIALS, COURSE), "page"), []);
});

test("skips section summaries and labels containing only encoded whitespace", async () => {
  const { adapter } = adapterWith({
    core_course_get_contents: () => json([
      { id: 47, name: "Blank summary", summary: "<p>&nbsp;</p>" },
      { id: 48, name: "Blank label", modules: [
        { id: 13, name: "Label", modname: "label", description: "&nbsp;<br>" },
      ] },
      { id: 49, name: "Numeric whitespace", summary: "<p>&#160;&#xA0;&#32;&#9;&#10;</p>" },
      { id: 50, name: "Line break", summary: "<br>" },
      { id: 51, name: "Encoded text", summary: "<p>&#65;&nbsp;&lt;br&gt;</p>" },
    ]),
  });
  const pages = ofKind(await adapter.listItems(CREDENTIALS, COURSE), "page");
  assert.deepEqual(pages.map((p) => [p.activityId, p.html]), [
    [-51, "<p>&#65;&nbsp;&lt;br&gt;</p>"],
  ]);
});

test("skips sections whose text is only zero-width characters", async () => {
  const { adapter } = adapterWith({
    core_course_get_contents: () => json([
      { id: 52, name: "Zero width", summary: "<p>​‌</p>", modules: [
        { id: 14, name: "Label", modname: "label", description: "‍&#xFEFF;﻿" },
      ] },
    ]),
  });
  assert.deepEqual(ofKind(await adapter.listItems(CREDENTIALS, COURSE), "page"), []);
});

test("maps a page to one item with its downloaded html and other files", async () => {
  const { adapter, calls } = adapterWith();
  const pages = ofKind(await adapter.listItems(CREDENTIALS, COURSE), "page").filter((item) => item.activityType === "page");
  assert.deepEqual(pages, [
    {
      kind: "page",
      html: fixture("page_index.html"),
      files: [
        {
          filename: "timeline.png",
          filepath: "/",
          url: pluginfile("7003/mod_page/content/3/timeline.png?forcedownload=1"),
          size: 20480,
          mimetype: "image/png",
          modified: 1790000000,
        },
      ],
      section: "General",
      sectionIndex: 0,
      activity: "Module handbook",
      activityType: "page",
      activityId: 5003,
      activityUrl: `${SITE}/mod/page/view.php?id=5003`,
    },
  ]);
  const get = calls.find((c) => c.method === "GET");
  assert.ok(get);
  const url = new URL(get.url);
  assert.equal(url.pathname, "/webservice/pluginfile.php/7003/mod_page/content/index.html");
  assert.equal(url.searchParams.get("token"), TOKEN);
});

test("maps url and lti activities and skips the rest of the contents", async () => {
  const { adapter } = adapterWith();
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  assert.deepEqual(ofKind(items, "link"), [
    {
      kind: "link",
      target: "https://video.example.org/watch?v=tst101",
      section: "Week 1: What is a test?",
      sectionIndex: 1,
      activity: "Worked example video",
      activityType: "url",
      activityId: 5103,
      activityUrl: `${SITE}/mod/url/view.php?id=5103`,
    },
  ]);
  assert.deepEqual(ofKind(items, "external-tool"), [
    {
      kind: "external-tool",
      toolName: "Lecture Recordings (Example Video Platform)",
      instance: 1201,
      section: "Recordings",
      sectionIndex: 2,
      activity: "Lecture Recordings (Example Video Platform)",
      activityType: "lti",
      activityId: 5201,
      activityUrl: `${SITE}/mod/lti/view.php?id=5201`,
    },
  ]);
  const placed = items.filter((item) => "activityType" in item && item.kind !== "event") as { activityType: string }[];
  for (const skipped of ["label", "subsection", "forum", "questionnaire", "assign", "quiz"])
    assert.ok(!placed.some((item) => item.activityType === skipped), `${skipped} should not be a content item`);
});

test("maps assignments, quizzes, events and announcements", async () => {
  const { adapter } = adapterWith();
  const items = await adapter.listItems(CREDENTIALS, COURSE);
  assert.deepEqual(ofKind(items, "assignment"), [
    {
      kind: "assignment",
      id: 901,
      activityId: 5104,
      title: "Coursework 1: Unit tests",
      due: 1793030400,
      cutoff: 1793635200,
      introHtml: "<p>Write unit tests for the provided calculator.</p>",
      briefFiles: [
        {
          filename: "CW1 brief.pdf",
          filepath: "/",
          url: pluginfile("7104/mod_assign/introattachment/0/CW1%20brief.pdf"),
          size: 65536,
          mimetype: "application/pdf",
          modified: 1790400000,
        },
      ],
      url: `${SITE}/mod/assign/view.php?id=5104`,
      modified: 1790400000,
    },
    {
      kind: "assignment",
      id: 902,
      activityId: 5199,
      title: "Coursework 2: To be confirmed",
      due: null,
      cutoff: null,
      introHtml: "",
      briefFiles: [],
      url: `${SITE}/mod/assign/view.php?id=5199`,
      modified: 1790400100,
    },
  ]);
  assert.deepEqual(ofKind(items, "quiz"), [
    {
      kind: "quiz",
      id: 1001,
      activityId: 5105,
      title: "Week 1 check-in quiz",
      opens: 1790650000,
      closes: 1791255600,
      url: `${SITE}/mod/quiz/view.php?id=5105`,
    },
    { kind: "quiz", id: 1002, activityId: 5107, title: "Practice quiz", opens: null, closes: null, url: `${SITE}/mod/quiz/view.php?id=5107` },
  ]);
  assert.deepEqual(ofKind(items, "event"), [
    {
      kind: "event",
      id: 3001,
      title: "Coursework 1: Unit tests is due",
      start: 1793030400,
      activityType: "assign",
      url: `${SITE}/calendar/view.php?view=day&time=1793030400`,
    },
    {
      kind: "event",
      id: 3002,
      title: "TST101U in-class test",
      start: 1795435200,
      activityType: null,
      url: `${SITE}/calendar/view.php?view=day&time=1795435200`,
    },
  ]);
  assert.deepEqual(ofKind(items, "announcement"), [
    {
      kind: "announcement",
      id: 66001,
      subject: "CW1 deadline moved",
      bodyHtml: "<p>Coursework 1 is now due a week later.</p>",
      posted: 1791000000,
      url: `${SITE}/mod/forum/discuss.php?d=66001`,
    },
  ]);
});

test("skips an item kind the token may not read, and keeps the rest", async () => {
  const denied = exception("webservice_access_exception", "accessexception", "Access control exception");
  const { adapter } = adapterWith({
    mod_quiz_get_quizzes_by_courses: denied,
    core_calendar_get_calendar_events: denied,
    mod_forum_get_forum_discussions: exception("required_capability_exception", "nopermissions", "Sorry"),
  });
  const kinds = new Set((await adapter.listItems(CREDENTIALS, COURSE)).map((item) => item.kind));
  assert.deepEqual([...kinds].sort(), ["assignment", "external-tool", "file", "link", "page"]);
});

test("an invalid token always propagates from optional calls", async () => {
  const { adapter } = adapterWith({ mod_assign_get_assignments: exception("moodle_exception", "invalidtoken", "Invalid token") });
  await rejectsWith(adapter.listItems(CREDENTIALS, COURSE), "invalid_token");
});

/* ------------------------------------------------------------- download */

test("download adds the token and streams the body", async () => {
  const { adapter, calls } = adapterWith();
  const [first] = ofKind(await adapter.listItems(CREDENTIALS, COURSE), "file");
  const stream = await adapter.download(CREDENTIALS, first!.file);
  assert.equal(await new Response(stream).text(), "bytes of /webservice/pluginfile.php/7101/mod_resource/content/2/TST101U%20Lecture%201.pdf");
  const url = new URL(calls.at(-1)!.url);
  assert.equal(url.searchParams.get("token"), TOKEN);
  assert.equal(url.searchParams.get("forcedownload"), "1");
});

test("download refuses non-2xx answers and other hosts", async () => {
  const file = { filename: "a.pdf", filepath: "/", url: `${SITE}/webservice/pluginfile.php/1/a.pdf`, size: 1, mimetype: null, modified: null };
  await rejectsWith(adapterWith({ GET: () => new Response("no", { status: 404 }) }).adapter.download(CREDENTIALS, file), "bad_response");
  await rejectsWith(adapterWith({ GET: () => new Response("no", { status: 403 }) }).adapter.download(CREDENTIALS, file), "access_denied");
  const elsewhere = adapterWith();
  await rejectsWith(elsewhere.adapter.download(CREDENTIALS, { ...file, url: "https://cdn.example.net/a.pdf" }), "bad_response");
  assert.equal(elsewhere.calls.length, 0);
});

/* ------------------------------------------------------------- universities */

test("knows QMUL", () => {
  assert.deepEqual(QMUL, { id: "qmul", displayName: "Queen Mary University of London", site: "https://qmplus.qmul.ac.uk" });
  const adapter = getUniversity("qmul");
  assert.ok(adapter);
  assert.equal(adapter.platform, "moodle");
  assert.equal(adapter.site, "https://qmplus.qmul.ac.uk");
  assert.equal(adapter.displayName, "Queen Mary University of London");
  assert.equal(getUniversity("nowhere"), null);
});
