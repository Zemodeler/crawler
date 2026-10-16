import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CalendarEventInput, CalendarTokenStore } from "../src/calendar-types.ts";
import { CalendarApiError, createCalendarClient, fileCalendarTokenStore } from "../src/gcal/client.ts";
import { GoogleAuthError, TOKEN_URL } from "../src/gcal/oauth.ts";

const API = "https://www.googleapis.com/calendar/v3";

type Seen = { method: string; url: URL; headers: Headers; body: unknown };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fake Google: answers the token endpoint itself and every API call with `api(req)`. */
function fakeGoogle(api: (req: Seen) => Reply) {
  const seen: Seen[] = [];
  let tokenCalls = 0;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === TOKEN_URL) {
      tokenCalls++;
      return Response.json({ access_token: `at-${tokenCalls}`, expires_in: 3600 });
    }
    const req: Seen = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const { status = 200, body, headers } = api(req);
    const text = body === undefined ? null : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status, headers });
  }) as typeof fetch;
  return { seen, fetch: fakeFetch, tokenCalls: () => tokenCalls };
}

let storeCount = 0;
/** A fresh refresh token per test, so the module's access-token cache never carries over. */
function memoryStore(): CalendarTokenStore {
  const stored = { refreshToken: `rt-${++storeCount}` };
  return { load: async () => stored, save: async () => {}, clear: async () => {} };
}

function client(google: ReturnType<typeof fakeGoogle>, waits: number[] = []) {
  return createCalendarClient({
    tokens: memoryStore(),
    clientId: "cid",
    fetch: google.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
}

const input: CalendarEventInput = {
  summary: "ECS401U Coursework 2",
  description: "Due",
  start: { dateTime: "2026-12-14T10:00:00Z" },
  end: { dateTime: "2026-12-14T10:30:00Z" },
  extendedProperties: { private: { crawlerId: "moodle:ECS401U:assign:1", crawlerHash: "h1" } },
};

const remote = (id: string, etag = `"e-${id}"`) => ({ ...input, id, etag, status: "confirmed" });

test("listEvents paginates with singleEvents=false and showDeleted=false", async () => {
  const google = fakeGoogle((req) => {
    const page = req.url.searchParams.get("pageToken");
    if (page === null) return { body: { items: [remote("a"), remote("b")], nextPageToken: "p2" } };
    if (page === "p2") return { body: { items: [remote("c")], nextPageToken: "p3" } };
    return { body: { items: [] } };
  });
  const events = await client(google).listEvents("cal@group.calendar.google.com");
  assert.deepEqual(events.map((e) => e.id), ["a", "b", "c"]);
  assert.equal(events[0]!.etag, '"e-a"');
  assert.equal(events[0]!.extendedProperties.private.crawlerId, "moodle:ECS401U:assign:1");
  assert.equal(google.seen.length, 3);
  for (const req of google.seen) {
    assert.equal(req.url.pathname, "/calendar/v3/calendars/cal%40group.calendar.google.com/events");
    assert.equal(req.url.searchParams.get("singleEvents"), "false");
    assert.equal(req.url.searchParams.get("showDeleted"), "false");
    assert.equal(req.headers.get("authorization"), "Bearer at-1");
  }
  assert.equal(google.tokenCalls(), 1);
});

test("ensureCalendar finds an existing calendar by summary across pages", async () => {
  const google = fakeGoogle((req) =>
    req.url.searchParams.get("pageToken") === null
      ? { body: { items: [{ id: "other", summary: "Something else" }], nextPageToken: "n" } }
      : { body: { items: [{ id: "mine", summary: "University deadlines" }] } },
  );
  assert.equal(await client(google).ensureCalendar("University deadlines"), "mine");
  assert.equal(google.seen.every((r) => r.method === "GET" && r.url.pathname === "/calendar/v3/users/me/calendarList"), true);
});

test("ensureCalendar creates the calendar in Europe/London when missing", async () => {
  const google = fakeGoogle((req) =>
    req.method === "GET" ? { body: { items: [] } } : { body: { id: "new-cal", summary: "University deadlines" } },
  );
  assert.equal(await client(google).ensureCalendar("University deadlines"), "new-cal");
  const post = google.seen[1]!;
  assert.equal(post.method, "POST");
  assert.equal(post.url.href, `${API}/calendars`);
  assert.deepEqual(post.body, { summary: "University deadlines", timeZone: "Europe/London" });
});

test("insert posts the event and returns it with id and etag", async () => {
  const google = fakeGoogle(() => ({ body: remote("new") }));
  const created = await client(google).insert("cal", input);
  assert.equal(created.id, "new");
  assert.equal(created.etag, '"e-new"');
  assert.equal(google.seen[0]!.method, "POST");
  assert.equal(google.seen[0]!.headers.get("content-type"), "application/json");
  assert.deepEqual(google.seen[0]!.body, input);
});

test("update sends If-Match and returns the new event", async () => {
  const google = fakeGoogle(() => ({ body: remote("ev", '"e2"') }));
  const updated = await client(google).update("cal", "ev", input, '"e1"');
  assert.notEqual(updated, "precondition-failed");
  assert.equal((updated as { etag: string }).etag, '"e2"');
  const req = google.seen[0]!;
  assert.equal(req.method, "PUT");
  assert.equal(req.url.pathname, "/calendar/v3/calendars/cal/events/ev");
  assert.equal(req.headers.get("if-match"), '"e1"');
});

test("update maps 412 to precondition-failed", async () => {
  const google = fakeGoogle(() => ({ status: 412, body: { error: { code: 412, message: "Precondition Failed" } } }));
  assert.equal(await client(google).update("cal", "ev", input, '"stale"'), "precondition-failed");
  assert.equal(google.seen.length, 1);
});

test("429 is retried, honouring Retry-After", async () => {
  let n = 0;
  const google = fakeGoogle(() =>
    ++n <= 2 ? { status: 429, headers: { "retry-after": "3" }, body: { error: { message: "slow down" } } } : { body: remote("ok") },
  );
  const waits: number[] = [];
  const created = await client(google, waits).insert("cal", input);
  assert.equal(created.id, "ok");
  assert.equal(google.seen.length, 3);
  assert.deepEqual(waits, [3000, 3000]);
});

test("5xx and rate-limit 403 are retried with backoff; other 4xx are not", async () => {
  let n = 0;
  const google = fakeGoogle(() => {
    n++;
    if (n === 1) return { status: 503 };
    if (n === 2) return { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }], message: "rate" } } };
    return { body: { items: [] } };
  });
  const waits: number[] = [];
  assert.deepEqual(await client(google, waits).listEvents("cal"), []);
  assert.equal(waits.length, 2);
  assert.ok(waits[1]! > waits[0]!);

  const forbidden = fakeGoogle(() => ({ status: 403, body: { error: { errors: [{ reason: "forbidden" }], message: "Forbidden" } } }));
  await assert.rejects(
    client(forbidden).listEvents("cal"),
    (err: unknown) => err instanceof CalendarApiError && err.status === 403 && err.reason === "forbidden",
  );
  assert.equal(forbidden.seen.length, 1);
});

test("persistent 5xx gives up with a typed error carrying the status", async () => {
  const google = fakeGoogle(() => ({ status: 500, body: { error: { message: "backend" } } }));
  const waits: number[] = [];
  await assert.rejects(
    client(google, waits).insert("cal", input),
    (err: unknown) => err instanceof CalendarApiError && err.status === 500 && /backend/.test(err.message),
  );
  assert.equal(google.seen.length, 5);
  assert.equal(waits.length, 4);
});

test("a 401 refreshes the access token once", async () => {
  let n = 0;
  const google = fakeGoogle(() => (++n === 1 ? { status: 401 } : { body: { items: [] } }));
  await client(google).listEvents("cal");
  assert.equal(google.tokenCalls(), 2);
  assert.equal(google.seen[1]!.headers.get("authorization"), "Bearer at-2");
});

test("delete tolerates 404 and 410, and fails on other errors", async () => {
  for (const status of [204, 404, 410]) {
    const google = fakeGoogle(() => ({ status }));
    await client(google).delete("cal", "ev");
    assert.equal(google.seen[0]!.method, "DELETE");
    assert.equal(google.seen[0]!.url.pathname, "/calendar/v3/calendars/cal/events/ev");
  }
  const google = fakeGoogle(() => ({ status: 400, body: { error: { message: "bad" } } }));
  await assert.rejects(client(google).delete("cal", "ev"), (err: unknown) => err instanceof CalendarApiError && err.status === 400);
});

test("no stored token is a GoogleAuthError, before any request", async () => {
  const google = fakeGoogle(() => ({ body: {} }));
  const c = createCalendarClient({
    tokens: { load: async () => null, save: async () => {}, clear: async () => {} },
    clientId: "cid",
    fetch: google.fetch,
  });
  await assert.rejects(c.listEvents("cal"), (err: unknown) => err instanceof GoogleAuthError && err.code === "no-token");
  assert.equal(google.seen.length, 0);
});

test("fileCalendarTokenStore saves, loads and clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawler-gcal-"));
  try {
    const path = join(dir, "nested", "token.json");
    const store = fileCalendarTokenStore(path);
    assert.equal(await store.load(), null);
    await store.save({ refreshToken: "rt" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { refreshToken: "rt" });
    assert.deepEqual(await store.load(), { refreshToken: "rt" });
    await store.clear();
    assert.equal(await store.load(), null);
    await store.clear();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
