import assert from "node:assert/strict";
import { test } from "node:test";

import { describeFreshness, syncDue } from "../src/schedule.ts";

const now = new Date("2026-10-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

test("never synced is due now", () => {
  assert.deepEqual(syncDue(null, now, { everyDays: 3 }), { due: true, reason: "never-synced", nextAt: now });
  assert.equal(syncDue("not a date", now, { everyDays: 3 }).reason, "never-synced");
});

test("not due before everyDays have passed; nextAt is last + everyDays", () => {
  const last = hoursAgo(48);
  const result = syncDue(last, now, { everyDays: 3 });
  assert.equal(result.due, false);
  assert.equal(result.reason, "not-due");
  assert.equal(result.nextAt.toISOString(), "2026-10-17T12:00:00.000Z");
});

test("due on its slot is scheduled; long overdue is a catch-up", () => {
  const onTime = syncDue(hoursAgo(72), now, { everyDays: 3 });
  assert.deepEqual(onTime, { due: true, reason: "scheduled", nextAt: now });
  assert.equal(syncDue(hoursAgo(72.5), now, { everyDays: 3 }).reason, "scheduled");

  const late = syncDue(hoursAgo(24 * 9), now, { everyDays: 3 });
  assert.deepEqual(late, { due: true, reason: "catch-up", nextAt: now });
});

test("everyDays changes the slot", () => {
  assert.equal(syncDue(hoursAgo(30), now, { everyDays: 1 }).due, true);
  assert.equal(syncDue(hoursAgo(30), now, { everyDays: 7 }).due, false);
  assert.equal(syncDue(hoursAgo(30), now, { everyDays: 7 }).nextAt.toISOString(), "2026-10-22T06:00:00.000Z");
});

test("describeFreshness", () => {
  assert.equal(describeFreshness(null, now), "never synced");
  assert.equal(describeFreshness(hoursAgo(0), now), "last synced just now");
  assert.equal(describeFreshness(hoursAgo(1 / 60), now), "last synced 1 minute ago");
  assert.equal(describeFreshness(hoursAgo(0.5), now), "last synced 30 minutes ago");
  assert.equal(describeFreshness(hoursAgo(5), now), "last synced 5 hours ago");
  assert.equal(describeFreshness(hoursAgo(30), now), "last synced 1 day ago");
  assert.equal(describeFreshness(hoursAgo(50), now), "last synced 2 days ago");
  // A clock that went backwards reads as just now, never "-1 minutes".
  assert.equal(describeFreshness(hoursAgo(-1), now), "last synced just now");
});
