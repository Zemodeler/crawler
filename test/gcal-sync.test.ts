import assert from "node:assert/strict";
import { test } from "node:test";

import type { CalendarClient, CalendarEventInput, RemoteEvent } from "../src/calendar-types.ts";
import { syncCalendar } from "../src/gcal/sync.ts";
import type { Deadline, DeadlineStatus } from "../src/types.ts";

/** In-memory Google Calendar with etags and a log of write calls. */
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

const later = { iso: "2026-12-16T12:00:00.000Z", allDay: false, tz: "Europe/London" } as const;

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

test("creates events in Crawler's own calendar and skips what has no place on it", async () => {
  const fake = new FakeCalendar();
  const report = await syncCalendar(fake, [
    deadline("a"),
    deadline("b", "conflict"),
    deadline("c", "needs-check", { checkReason: "placeholder date" }),
    deadline("d", "tbc", { due: null }),
  ]);
  assert.deepEqual([...fake.calendars.keys()], ["University deadlines"]);
  assert.deepEqual(report.created, ["a", "b"]);
  assert.deepEqual(report.skipped, [
    { crawlerId: "c", reason: "needs-check: placeholder date" },
    { crawlerId: "d", reason: "tbc without a window" },
  ]);
  assert.equal(fake.byCrawlerId("b")!.summary, "⚠ ECS401U · Coursework b");
  assert.equal(fake.byCrawlerId("c"), undefined);
  assert.equal(fake.byCrawlerId("d"), undefined);
});

test("uses a custom calendar name", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")], { calendarName: "QMUL" });
  assert.deepEqual([...fake.calendars.keys()], ["QMUL"]);
});

test("a second run with no changes makes zero write calls", async () => {
  const fake = new FakeCalendar();
  const deadlines = [deadline("a"), deadline("b", "conflict"), deadline("c", "needs-check")];
  await syncCalendar(fake, deadlines);
  fake.writes = [];
  const report = await syncCalendar(fake, deadlines);
  assert.deepEqual(fake.writes, []);
  assert.equal(report.unchanged, 2);
  assert.deepEqual([report.created, report.updated, report.deleted, report.editedByUser], [[], [], [], []]);
});

test("updates an untouched event in place when its deadline changes", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  const before = fake.byCrawlerId("a")!;
  const report = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(report.updated, ["a"]);
  const after = fake.byCrawlerId("a")!;
  assert.equal(after.id, before.id);
  assert.equal(after.end.dateTime, "2026-12-16T12:00:00Z");
  assert.equal(fake.all().length, 1);
  // And it settles.
  fake.writes = [];
  await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(fake.writes, []);
});

test("an event the student edited is not overwritten and is reported", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  fake.studentEdit("a", { summary: "ECS401U CW2 - start early!" });
  fake.writes = [];
  const report = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(report.updated, []);
  assert.deepEqual(report.editedByUser, [{ crawlerId: "a", summary: "ECS401U CW2 - start early!" }]);
  assert.equal(fake.byCrawlerId("a")!.summary, "ECS401U CW2 - start early!");
  // With the deadline unchanged it is still left alone and still reported.
  const again = await syncCalendar(fake, [deadline("a")]);
  assert.deepEqual(fake.writes, []);
  assert.equal(again.editedByUser.length, 1);
});

test("an etag precondition failure is reported as a student edit", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  // The event changes between the list and the update; only the etag moves.
  const list = fake.listEvents.bind(fake);
  fake.listEvents = async (id: string) => {
    const events = await list(id);
    fake.studentEdit("a", {});
    return events;
  };
  const report = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(report.updated, []);
  assert.deepEqual(report.editedByUser, [{ crawlerId: "a", summary: "ECS401U · Coursework a" }]);
  assert.equal(fake.byCrawlerId("a")!.end.dateTime, "2026-12-14T10:00:00Z");
});

test("removes events whose deadline is gone or cancelled, never events without a crawlerId", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a"), deadline("b"), deadline("c")]);
  const calendarId = await fake.ensureCalendar("University deadlines");
  const own = { summary: "Dentist", description: "", start: { date: "2026-12-01" }, end: { date: "2026-12-02" } };
  fake.events.get(calendarId)!.push({ ...own, id: "mine", etag: '"x"' } as unknown as RemoteEvent);

  const deadlines = [deadline("a"), deadline("c", "cancelled")];
  const report = await syncCalendar(fake, deadlines);
  assert.deepEqual(report.deleted.sort(), ["b", "c"]);
  assert.deepEqual(report.skipped, [{ crawlerId: "c", reason: "cancelled" }]);
  assert.deepEqual(fake.all().map((e) => e.id).sort(), ["ev-1", "mine"]);

  fake.writes = [];
  await syncCalendar(fake, deadlines);
  assert.deepEqual(fake.writes, []);
});

test("an exam window lands as an all-day event", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [
    deadline("exam", "tbc", {
      kind: "exam",
      due: null,
      window: {
        from: { iso: "2027-05-04", allDay: true, tz: "Europe/London" },
        to: { iso: "2027-05-28", allDay: true, tz: "Europe/London" },
      },
    }),
  ]);
  const e = fake.byCrawlerId("exam")!;
  assert.deepEqual([e.start, e.end], [{ date: "2027-05-04" }, { date: "2027-05-29" }]);
});

test("a removed deadline with several copies loses every copy in one run", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a"), deadline("b")]);
  const copy = fake.duplicate("b");
  const edited = fake.duplicate("b", { summary: "My own note" });
  fake.writes = [];
  const report = await syncCalendar(fake, [deadline("a")]);
  assert.deepEqual(fake.writes.sort(), [`delete ${copy}`, `delete ${edited}`, "delete ev-2"].sort());
  assert.deepEqual(report.deleted, ["b"]);
  assert.deepEqual(fake.all().map((e) => e.id), ["ev-1"]);

  fake.writes = [];
  await syncCalendar(fake, [deadline("a")]);
  assert.deepEqual(fake.writes, []);
});

test("a cancelled deadline with several copies loses every copy in one run", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  fake.duplicate("a");
  fake.duplicate("a");
  const report = await syncCalendar(fake, [deadline("a", "cancelled")]);
  assert.deepEqual(report.deleted, ["a"]);
  assert.deepEqual(fake.all(), []);

  fake.writes = [];
  await syncCalendar(fake, [deadline("a", "cancelled")]);
  assert.deepEqual(fake.writes, []);
});

test("an untouched extra copy is deleted and the first copy is updated as before", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  const first = fake.byCrawlerId("a")!.id;
  const copy = fake.duplicate("a");
  fake.writes = [];
  const report = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(fake.writes, [`delete ${copy}`, "update a"]);
  assert.deepEqual(report.deleted, ["a"]);
  assert.deepEqual(report.updated, ["a"]);
  assert.deepEqual(report.editedByUser, []);
  assert.deepEqual(fake.all().map((e) => e.id), [first]);
  assert.equal(fake.byCrawlerId("a")!.end.dateTime, "2026-12-16T12:00:00Z");

  fake.writes = [];
  const again = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(fake.writes, []);
  assert.equal(again.unchanged, 1);
});

test("an untouched extra copy of an unchanged deadline is deleted, then the sync settles", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  const copy = fake.duplicate("a");
  fake.writes = [];
  const report = await syncCalendar(fake, [deadline("a")]);
  assert.deepEqual(fake.writes, [`delete ${copy}`]);
  assert.equal(report.unchanged, 1);
  assert.equal(fake.all().length, 1);

  fake.writes = [];
  await syncCalendar(fake, [deadline("a")]);
  assert.deepEqual(fake.writes, []);
});

test("an extra copy the student edited is left alone and reported", async () => {
  const fake = new FakeCalendar();
  await syncCalendar(fake, [deadline("a")]);
  const copy = fake.duplicate("a", { summary: "Revise for CW a" });
  fake.writes = [];
  const report = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(fake.writes, ["update a"]);
  assert.deepEqual(report.updated, ["a"]);
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(report.editedByUser, [{ crawlerId: "a", summary: "Revise for CW a" }]);
  assert.equal(fake.all().find((e) => e.id === copy)!.summary, "Revise for CW a");

  fake.writes = [];
  const again = await syncCalendar(fake, [deadline("a", "confirmed", { due: later })]);
  assert.deepEqual(fake.writes, []);
  assert.equal(again.unchanged, 1);
  assert.deepEqual(again.editedByUser, [{ crawlerId: "a", summary: "Revise for CW a" }]);
});
