import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mergeDeadlines } from "../src/deadlines.ts";
import {
  dueSoon,
  dueSoonKey,
  eventsFromDiff,
  filesSummary,
  loadNotified,
  saveNotified,
} from "../src/notifications.ts";
import type { Deadline, Source } from "../src/types.ts";

const now = new Date("2026-10-16T12:00:00Z");

function source(iso: string | null, url = "https://vle.example/mod/assign/view.php?id=1"): Source {
  return {
    type: "vle-field",
    strength: "structured",
    url,
    quote: "Due",
    date: iso ? { iso, allDay: false, tz: "Europe/London" } : null,
    seenAt: now.toISOString(),
  };
}

function deadline(id: string, due: string | null, extra: Partial<Deadline> = {}): Deadline {
  return {
    id,
    module: "ECS505U",
    year: "2026-27",
    title: `Coursework ${id}`,
    kind: "coursework",
    status: due ? "confirmed" : "tbc",
    due: due ? { iso: due, allDay: false, tz: "Europe/London" } : null,
    sources: [source(due)],
    history: [],
    ...extra,
  };
}

/* ------------------------------------------------------------- eventsFromDiff */

test("first sync gives a single summary event, not one per deadline", () => {
  const merged = [
    deadline("a", "2026-11-01T12:00:00.000Z"),
    deadline("b", "2026-11-02T12:00:00.000Z", { module: "ECS401U" }),
    deadline("c", "2026-11-03T12:00:00.000Z", { formative: true }),
    deadline("d", null),
  ];
  const events = eventsFromDiff([], merged);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "new-deadline");
  assert.equal(events[0]?.title, "Found 2 deadlines in 2 modules");
  assert.equal(events[0]?.deadlineId, undefined);
});

test("first sync with nothing notifiable gives no events", () => {
  assert.deepEqual(eventsFromDiff([], [deadline("a", null)]), []);
  assert.deepEqual(eventsFromDiff([], []), []);
});

test("new deadline notifies, with a link to its submission page", () => {
  const old = deadline("a", "2026-11-01T12:00:00.000Z");
  const fresh = deadline("b", "2026-12-14T10:00:00.000Z", { submitUrl: "https://vle.example/submit" });
  const events = eventsFromDiff([old], [old, fresh]);
  assert.deepEqual(events, [
    {
      kind: "new-deadline",
      deadlineId: "b",
      title: "ECS505U · Coursework b",
      body: "New deadline, due Mon 14 Dec 2026, 10:00",
      sourceUrl: "https://vle.example/submit",
    },
  ]);
});

test("date change notifies; unchanged deadlines do not", () => {
  const before = deadline("a", "2026-11-01T12:00:00.000Z");
  const after = deadline("a", "2026-11-08T12:00:00.000Z");
  const same = deadline("b", "2026-11-05T12:00:00.000Z");
  const events = eventsFromDiff([before, same], [after, same]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "date-changed");
  assert.equal(events[0]?.body, "Due date moved from Sun 1 Nov 2026, 12:00 to Sun 8 Nov 2026, 12:00");
  assert.equal(events[0]?.sourceUrl, "https://vle.example/mod/assign/view.php?id=1");
});

test("a TBC deadline that gets a date notifies as a date change", () => {
  const events = eventsFromDiff([deadline("a", null)], [deadline("a", "2026-11-08T12:00:00.000Z")]);
  assert.equal(events[0]?.kind, "date-changed");
  assert.match(events[0]?.body ?? "", /from TBC to/);
});

test("newly conflicting notifies once, as a conflict rather than a date change", () => {
  const before = deadline("a", "2026-11-01T12:00:00.000Z");
  const after = deadline("a", "2026-11-08T12:00:00.000Z", {
    status: "conflict",
    sources: [source("2026-11-08T12:00:00.000Z"), { ...source("2026-11-01T12:00:00.000Z"), type: "document" }],
  });
  const events = eventsFromDiff([before], [after]);
  assert.deepEqual(events.map((e) => e.kind), ["new-conflict"]);
  // Still in conflict next sync: nothing new.
  assert.deepEqual(eventsFromDiff([after], [after]), []);
});

test("a VLE date disagreeing with a user-verified deadline notifies once, keeping the student's date", () => {
  const verified = deadline("a", "2026-11-08T12:00:00.000Z", { status: "user-verified" });
  const fresh = [deadline("a", "2026-11-01T12:00:00.000Z")];
  const merged = mergeDeadlines([verified], fresh, now);
  assert.equal(merged[0]?.status, "user-verified");
  assert.equal(merged[0]?.due?.iso, "2026-11-08T12:00:00.000Z");

  assert.deepEqual(eventsFromDiff([verified], merged), [
    {
      kind: "new-conflict",
      deadlineId: "a",
      title: "ECS505U · Coursework a",
      body: "A source now says Sun 1 Nov 2026, 12:00; keeping your date Sun 8 Nov 2026, 12:00",
      sourceUrl: "https://vle.example/mod/assign/view.php?id=1",
    },
  ]);

  // The same disagreeing source next sync, and an unchanged re-sync, stay silent.
  const again = mergeDeadlines(merged, fresh, now);
  assert.equal(again[0]?.history.length, merged[0]?.history.length);
  assert.deepEqual(eventsFromDiff(merged, again), []);
  const agreeing = mergeDeadlines([verified], [deadline("a", "2026-11-08T12:00:00.000Z")], now);
  assert.deepEqual(eventsFromDiff([verified], agreeing), []);
});

test("a new deadline that is already in conflict notifies as a conflict", () => {
  const old = deadline("x", "2026-11-01T12:00:00.000Z");
  const fresh = deadline("a", "2026-11-08T12:00:00.000Z", { status: "conflict" });
  assert.deepEqual(eventsFromDiff([old], [old, fresh]).map((e) => e.kind), ["new-conflict"]);
});

test("formative, needs-check, tbc and cancelled deadlines never notify", () => {
  const old = deadline("x", "2026-11-01T12:00:00.000Z");
  const merged = [
    old,
    deadline("f", "2026-11-02T12:00:00.000Z", { formative: true }),
    deadline("n", "2028-11-02T12:00:00.000Z", { status: "needs-check", checkReason: "placeholder" }),
    deadline("t", null),
  ];
  assert.deepEqual(eventsFromDiff([old], merged), []);

  const movedFormative = deadline("f", "2026-11-09T12:00:00.000Z", { formative: true });
  assert.deepEqual(eventsFromDiff([deadline("f", "2026-11-02T12:00:00.000Z", { formative: true })], [movedFormative]), []);

  const cancelled = { ...old, status: "cancelled" as const };
  assert.deepEqual(eventsFromDiff([old], [cancelled]), []);
});

/* ------------------------------------------------------------- dueSoon */

test("dueSoon reminds once for confirmed and user-verified deadlines in the next 48h", () => {
  const deadlines = [
    deadline("soon", "2026-10-17T12:00:00.000Z"),
    deadline("verified", "2026-10-18T11:00:00.000Z", { status: "user-verified" }),
    deadline("later", "2026-10-18T12:30:00.000Z"),
    deadline("past", "2026-10-16T11:00:00.000Z"),
    deadline("formative", "2026-10-17T12:00:00.000Z", { formative: true }),
    deadline("conflict", "2026-10-17T12:00:00.000Z", { status: "conflict" }),
    deadline("check", "2026-10-17T12:00:00.000Z", { status: "needs-check" }),
    deadline("cancelled", "2026-10-17T12:00:00.000Z", { status: "cancelled" }),
    deadline("tbc", null),
  ];
  const first = dueSoon(deadlines, now, new Set());
  assert.deepEqual(first.events.map((e) => e.deadlineId), ["soon", "verified"]);
  assert.equal(first.events[0]?.kind, "due-soon");
  assert.equal(first.events[0]?.body, "Due Sat 17 Oct 2026, 13:00 (in 24 hours)");
  assert.equal(first.events[1]?.body, "Due Sun 18 Oct 2026, 12:00 (in 47 hours)");
  assert.deepEqual(
    [...first.notified].sort(),
    ["soon|2026-10-17T12:00:00.000Z", "verified|2026-10-18T11:00:00.000Z"],
  );

  const second = dueSoon(deadlines, new Date(now.getTime() + 60 * 60 * 1000), first.notified);
  // An hour on: the two are not repeated, and "later" has entered the window.
  assert.deepEqual(second.events.map((e) => e.deadlineId), ["later"]);
  assert.deepEqual(dueSoon(deadlines, now, first.notified).events, []);
});

test("dueSoon re-notifies when the date moves, and respects a custom window", () => {
  const original = deadline("a", "2026-10-17T12:00:00.000Z");
  const { notified } = dueSoon([original], now, new Set());
  const moved = deadline("a", "2026-10-17T18:00:00.000Z");
  assert.equal(dueSoon([moved], now, notified).events.length, 1);
  assert.equal(dueSoonKey(moved), "a|2026-10-17T18:00:00.000Z");

  assert.equal(dueSoon([original], now, new Set(), 12).events.length, 0);
  const close = deadline("b", "2026-10-16T12:20:00.000Z");
  assert.equal(dueSoon([close], now, new Set(), 12).events[0]?.body, "Due Fri 16 Oct 2026, 13:20 (in under an hour)");
});

test("dueSoon drops keys whose date has passed", () => {
  const already = new Set(["old|2026-10-01T12:00:00.000Z", "a|2026-10-17T12:00:00.000Z"]);
  const { events, notified } = dueSoon([], now, already);
  assert.deepEqual(events, []);
  assert.deepEqual([...notified], ["a|2026-10-17T12:00:00.000Z"]);
});

/* ------------------------------------------------------------- filesSummary */

test("filesSummary", () => {
  assert.equal(filesSummary([]), null);
  assert.equal(filesSummary([{ module: "ECS505U", added: 0 }]), null);
  assert.deepEqual(
    filesSummary([
      { module: "ECS505U", added: 5 },
      { module: "ECS401U", added: 0 },
      { module: "ECS414U", added: 4 },
      { module: "ECS419U", added: 3 },
    ]),
    { kind: "files-summary", title: "12 new files in 3 modules", body: "ECS505U (5), ECS414U (4), ECS419U (3)" },
  );
  assert.equal(filesSummary([{ module: "ECS505U", added: 1 }])?.title, "1 new file in 1 module");
});

/* ------------------------------------------------------------- persistence */

test("loadNotified and saveNotified round-trip through notified.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawler-notified-"));
  try {
    const stateDir = join(dir, ".crawler");
    assert.deepEqual(await loadNotified(stateDir), new Set());

    const keys = new Set(["b|2026-10-18T11:00:00.000Z", "a|2026-10-17T12:00:00.000Z"]);
    await saveNotified(stateDir, keys);
    assert.deepEqual(await loadNotified(stateDir), keys);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, "notified.json"), "utf8")), [
      "a|2026-10-17T12:00:00.000Z",
      "b|2026-10-18T11:00:00.000Z",
    ]);

    await writeFile(join(stateDir, "notified.json"), "{not json", "utf8");
    assert.deepEqual(await loadNotified(stateDir), new Set());
    await writeFile(join(stateDir, "notified.json"), JSON.stringify({ keys: [] }), "utf8");
    assert.deepEqual(await loadNotified(stateDir), new Set());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
