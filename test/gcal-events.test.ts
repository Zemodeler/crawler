import assert from "node:assert/strict";
import { test } from "node:test";

import type { CalendarEventInput } from "../src/calendar-types.ts";
import { contentHash, deadlineToEvent, sanitizeText } from "../src/gcal/events.ts";
import type { Deadline, DeadlineStatus, Instant, Source } from "../src/types.ts";

const seenAt = "2026-10-15T17:00:00.000Z";

function at(iso: string, allDay = false): Instant {
  return { iso, allDay, tz: "Europe/London" };
}

function source(url: string, quote: string, iso: string): Source {
  return { type: "vle-field", strength: "structured", url, quote, date: at(iso), seenAt };
}

function deadline(status: DeadlineStatus, overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "d-1",
    module: "ECS401U",
    year: "2026-27",
    title: "Coursework 2",
    kind: "coursework",
    status,
    due: at("2026-12-14T10:00:00.000Z"),
    sources: [source("https://vle.example/mod/assign/view.php?id=1", "Due: Mon 14 Dec 2026, 10:00", "2026-12-14T10:00:00.000Z")],
    history: [],
    ...overrides,
  };
}

function event(d: Deadline, opts: { vleLabel?: string } = {}): CalendarEventInput {
  const result = deadlineToEvent(d, opts);
  if ("skip" in result) assert.fail(`unexpected skip: ${result.skip}`);
  return result;
}

test("a timed deadline is a 30-minute event ending at the due instant", () => {
  const e = event(deadline("confirmed", { weight: 30, submitUrl: "https://vle.example/submit/1" }), { vleLabel: "QMplus" });
  assert.equal(e.summary, "ECS401U · Coursework 2");
  assert.deepEqual(e.start, { dateTime: "2026-12-14T09:30:00Z", timeZone: "Europe/London" });
  assert.deepEqual(e.end, { dateTime: "2026-12-14T10:00:00Z", timeZone: "Europe/London" });
  assert.match(e.description, /^Status: confirmed$/m);
  assert.match(e.description, /^Weight: 30%$/m);
  assert.match(e.description, /“Due: Mon 14 Dec 2026, 10:00”/);
  assert.match(e.description, /^QMplus: https:\/\/vle\.example\/mod\/assign\/view\.php\?id=1$/m);
  assert.match(e.description, /^Submit: https:\/\/vle\.example\/submit\/1$/m);
  assert.equal(e.extendedProperties.private.crawlerId, "d-1");
  assert.equal(e.extendedProperties.private.crawlerHash, contentHash(e));
});

test("formative work says so", () => {
  const e = event(deadline("confirmed", { formative: true }));
  assert.match(e.description, /^Formative: does not count towards the module mark\.$/m);
});

test("conflicts get the warning prefix and list every source", () => {
  const e = event(
    deadline("conflict", {
      sources: [
        source("https://vle.example/a", "Due 14 Dec, 10:00", "2026-12-14T10:00:00.000Z"),
        source("https://vle.example/b", "Deadline: 16 December", "2026-12-16T10:00:00.000Z"),
      ],
    }),
  );
  assert.equal(e.summary, "⚠ ECS401U · Coursework 2");
  assert.match(e.description, /^Sources:$/m);
  assert.match(e.description, /“Due 14 Dec, 10:00”\nVLE: https:\/\/vle\.example\/a/);
  assert.match(e.description, /“Deadline: 16 December”\nVLE: https:\/\/vle\.example\/b/);
});

test("timed events across the DST changes keep the exact due instant", () => {
  // 28 Mar 2027 01:15 UTC is 02:15 BST, just after the clocks go forward.
  const spring = event(deadline("confirmed", { due: at("2027-03-28T01:15:00.000Z") }));
  assert.equal(spring.start.dateTime, "2027-03-28T00:45:00Z");
  assert.equal(spring.end.dateTime, "2027-03-28T01:15:00Z");
  // 25 Oct 2026 01:10 UTC is 01:10 GMT, the second 01:xx after the clocks go back.
  const autumn = event(deadline("confirmed", { due: at("2026-10-25T01:10:00.000Z") }));
  assert.equal(autumn.start.dateTime, "2026-10-25T00:40:00Z");
  assert.equal(autumn.end.dateTime, "2026-10-25T01:10:00Z");
});

test("all-day deadlines use the London date, including midnight BST", () => {
  const plain = event(deadline("confirmed", { due: at("2026-12-14", true) }));
  assert.deepEqual(plain.start, { date: "2026-12-14" });
  assert.deepEqual(plain.end, { date: "2026-12-15" });
  // Midnight BST on 1 Jun 2027 is 23:00 UTC the day before.
  const bst = event(deadline("confirmed", { due: at("2027-05-31T23:00:00.000Z", true) }));
  assert.deepEqual(bst.start, { date: "2027-06-01" });
  assert.deepEqual(bst.end, { date: "2027-06-02" });
  // Clocks go forward on 28 Mar 2027 (midnight GMT).
  const dst = event(deadline("confirmed", { due: at("2027-03-28T00:00:00.000Z", true) }));
  assert.deepEqual(dst.start, { date: "2027-03-28" });
  assert.deepEqual(dst.end, { date: "2027-03-29" });
  // Month and year roll over.
  const nye = event(deadline("confirmed", { due: at("2026-12-31", true) }));
  assert.deepEqual(nye.end, { date: "2027-01-01" });
});

test("an exam with a window and no due date is all-day over the window", () => {
  const e = event(
    deadline("tbc", {
      kind: "exam",
      title: "Exam",
      due: null,
      window: { from: at("2027-05-03T23:00:00.000Z", true), to: at("2027-05-28", true) },
    }),
  );
  assert.deepEqual(e.start, { date: "2027-05-04" });
  assert.deepEqual(e.end, { date: "2027-05-29" });
  assert.match(e.description, /^Window: 2027-05-04 to 2027-05-28$/m);
});

test("needs-check, tbc without a window, undated and cancelled deadlines are skipped with a reason", () => {
  assert.deepEqual(deadlineToEvent(deadline("needs-check", { checkReason: "date outside the academic year" }), {}), {
    skip: "needs-check: date outside the academic year",
  });
  assert.deepEqual(deadlineToEvent(deadline("tbc", { due: null }), {}), { skip: "tbc without a window" });
  assert.deepEqual(deadlineToEvent(deadline("tbc"), {}), { skip: "tbc without a window" });
  assert.deepEqual(deadlineToEvent(deadline("confirmed", { due: null }), {}), { skip: "no date" });
  assert.deepEqual(deadlineToEvent(deadline("cancelled"), {}), { skip: "cancelled" });
});

test("contentHash is stable, sensitive to content and blind to how a time is spelt", () => {
  const e = event(deadline("confirmed"));
  assert.equal(contentHash(e), contentHash(structuredClone(e)));
  assert.match(contentHash(e), /^[0-9a-f]{64}$/);
  assert.notEqual(contentHash({ ...e, summary: "Other" }), contentHash(e));
  assert.notEqual(contentHash({ ...e, description: e.description + "!" }), contentHash(e));
  assert.notEqual(contentHash({ ...e, end: { dateTime: "2026-12-14T11:00:00Z" } }), contentHash(e));
  // Google echoes times back with an offset; the same instant hashes the same.
  assert.equal(contentHash({ ...e, start: { dateTime: "2026-12-14T09:30:00+00:00", timeZone: "Europe/London" } }), contentHash(e));
  // Re-running the mapping gives the same hash.
  assert.equal(event(deadline("confirmed")).extendedProperties.private.crawlerHash, e.extendedProperties.private.crawlerHash);
});

// Credential-shaped fixtures are assembled at runtime so no literal in this file
// looks like a leaked secret to a scanner.
/** `name=value`. */
function kv(name: string, value: string): string {
  return [name, "=", value].join("");
}

/** A URL whose userinfo is `userinfo` joined with colons, in front of `rest`. */
function withUserinfo(scheme: string, userinfo: string[], rest: string): string {
  return [scheme, "://", userinfo.join(":"), "@", rest].join("");
}

test("source URLs, quotes and submitUrl lose their credentials before they reach Google", () => {
  const e = event(
    deadline("confirmed", {
      sources: [
        source(
          `https://vle.example/file?${kv("token", "LEAK1")}&id=7`,
          `Upload via https://vle.example/pluginfile.php/1/a.pdf?${kv("wstoken", "LEAK2")}&forcedownload=1.`,
          "2026-12-14T10:00:00.000Z",
        ),
      ],
      submitUrl: withUserinfo("https", ["LEAKUSER", "LEAKPASS"], `vle.example/submit?id=1&${kv("sesskey", "LEAK3")}`),
    }),
  );
  assert.doesNotMatch(e.description, /LEAK/);
  assert.match(e.description, /^VLE: https:\/\/vle\.example\/file\?id=7$/m);
  assert.match(e.description, /“Upload via https:\/\/vle\.example\/pluginfile\.php\/1\/a\.pdf\?forcedownload=1\.”/);
  assert.match(e.description, /^Submit: https:\/\/vle\.example\/submit\?id=1$/m);
  // The hash fingerprints exactly what is sent.
  assert.equal(e.extendedProperties.private.crawlerHash, contentHash(e));
});

test("sanitizeText strips userinfo and credential parameters and leaves other URLs as spelt", () => {
  const cases: [string, string][] = [
    [`https://vle.example/file?${kv("token", "LEAK")}`, "https://vle.example/file"],
    [`https://vle.example/a?${kv("ACCESS_TOKEN", "x")}&b=2`, "https://vle.example/a?b=2"],
    [
      `https://vle.example/a?${[kv("key", "x"), kv("sig", "y"), kv("signature", "z"), kv("password", "p")].join("&")}&b=2`,
      "https://vle.example/a?b=2",
    ],
    [`https://maps.example/?${kv("api_key", "x")}&q=Mile+End`, "https://maps.example/?q=Mile+End"],
    [`https://s3.example/o?${kv("X-Amz-Signature", "x")}&${kv("X-Amz-Credential", "y")}&v=1`, "https://s3.example/o?v=1"],
    [`https://vle.example/cb#${kv("access_token", "x")}&state=1`, "https://vle.example/cb#state=1"],
    [withUserinfo("https", ["bob", "pw"], "vle.example/x"), "https://vle.example/x"],
    [withUserinfo("ftp", ["bob"], "files.example/x"), "ftp://files.example/x"],
    // Nothing secret: kept exactly, including encoding and trailing slash.
    ["https://vle.example/view.php?id=1&name=a%20b", "https://vle.example/view.php?id=1&name=a%20b"],
    ["https://vle.example", "https://vle.example"],
    [`see (https://vle.example/f?${kv("token", "x")}), then`, "see (https://vle.example/f), then"],
    [
      `two: https://a.example/?${kv("token", "1")} and https://b.example/?${kv("wstoken", "2")}&id=3`,
      "two: https://a.example/ and https://b.example/?id=3",
    ],
    [`no urls, just ${kv("token", "abc")}`, `no urls, just ${kv("token", "abc")}`],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeText(input), expected, input);
});
