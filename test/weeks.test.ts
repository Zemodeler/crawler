import assert from "node:assert/strict";
import { test } from "node:test";

import type { TermWeekMap } from "../src/extraction-types.ts";
import { resolveWeek, teachingWeekAt, weekMapFor, weekMapFromQuote } from "../src/weeks.ts";

const semA = weekMapFor("qmul", "2026-27 Semester A")!;

test("weekMapFor reads the confirmed QM Semester A only", () => {
  assert.deepEqual(semA, { termStart: "2026-09-21", readingWeeks: [], source: { kind: "config" } });
  assert.equal(weekMapFor("qmul", "2026-27 Semester B"), null);
  assert.equal(weekMapFor("surrey", "2026-27 Semester 1"), null);
  assert.equal(weekMapFor("surrey", "2026-27 Semester 2"), null);
  assert.equal(weekMapFor("qmul", "2031-32 Semester A"), null);
  assert.equal(weekMapFor("nowhere", "2026-27 Semester A"), null);
});

test("weekMapFor returns a copy the caller can't use to change the config", () => {
  semA.readingWeeks.push(99);
  assert.deepEqual(weekMapFor("qmul", "2026-27 Semester A")!.readingWeeks, []);
  semA.readingWeeks.pop();
});

test("resolveWeek: week 1 Monday, all-day, at London midnight (BST)", () => {
  assert.deepEqual(resolveWeek(semA, 1), { iso: "2026-09-20T23:00:00.000Z", allDay: true, tz: "Europe/London" });
});

test("resolveWeek: day and time of a later week", () => {
  // Week 9 is the week of Mon 16 Nov 2026; Friday 20 Nov, GMT.
  assert.deepEqual(resolveWeek(semA, 9, 5, "12:00"), {
    iso: "2026-11-20T12:00:00.000Z",
    allDay: false,
    tz: "Europe/London",
  });
});

test("resolveWeek honours the autumn clock change", () => {
  // Clocks go back on Sun 25 Oct 2026.
  assert.equal(resolveWeek(semA, 5, 1, "10:00").iso, "2026-10-19T09:00:00.000Z");
  assert.equal(resolveWeek(semA, 6, 1, "10:00").iso, "2026-10-26T10:00:00.000Z");
});

test("resolveWeek honours the spring clock change", () => {
  // Clocks go forward on Sun 28 Mar 2027.
  const map: TermWeekMap = { termStart: "2027-01-25", readingWeeks: [], source: { kind: "config" } };
  assert.equal(resolveWeek(map, 9, 1, "09:00").iso, "2027-03-22T09:00:00.000Z");
  assert.equal(resolveWeek(map, 10, 1, "09:00").iso, "2027-03-29T08:00:00.000Z");
});

test("resolveWeek skips reading weeks left out of the numbering", () => {
  const map: TermWeekMap = { termStart: "2026-09-21", readingWeeks: [7], source: { kind: "config" } };
  assert.equal(resolveWeek(map, 6, 1, "10:00").iso, "2026-10-26T10:00:00.000Z");
  // Calendar week 7 (2 Nov) is reading week, so teaching week 7 is 9 Nov.
  assert.equal(resolveWeek(map, 7, 1, "10:00").iso, "2026-11-09T10:00:00.000Z");
});

test("resolveWeek rejects nonsense", () => {
  assert.throws(() => resolveWeek(semA, 0));
  assert.throws(() => resolveWeek(semA, 3, 8));
  assert.throws(() => resolveWeek(semA, 3, 1, "25:00"));
});

test("weekMapFromQuote parses 'Week 1 begins …' quotes", () => {
  const url = "https://qmplus.qmul.ac.uk/mod/page/view.php?id=1";
  const quote = "Teaching Week 1 begins on Monday 21 September 2026 and runs for twelve weeks.";
  assert.deepEqual(weekMapFromQuote(quote, url), {
    termStart: "2026-09-21",
    readingWeeks: [],
    source: { kind: "quote", quote, url },
  });
  assert.equal(weekMapFromQuote("Week 1 starts 25th January 2027", url)?.termStart, "2027-01-25");
  assert.equal(weekMapFromQuote("Week one commences January 25, 2027.", url)?.termStart, "2027-01-25");
  assert.equal(weekMapFromQuote("Week 1 starts on 2026-09-21", url)?.termStart, "2026-09-21");
});

test("weekMapFromQuote moves a mid-week date back to its Monday", () => {
  // Wed 23 Sep 2026.
  assert.equal(weekMapFromQuote("Week 1 commences 23/09/2026", "u")?.termStart, "2026-09-21");
});

test("weekMapFromQuote needs a year and a week-1 statement", () => {
  assert.equal(weekMapFromQuote("Week 1 starts on Monday 21 September", "u"), null);
  assert.equal(weekMapFromQuote("Week 1 lecture: 21 September 2026", "u"), null);
  assert.equal(weekMapFromQuote("Week 3 begins 5 October 2026", "u"), null);
  assert.equal(weekMapFromQuote("Week 1 starts 31 September 2026", "u"), null);
});

test("teachingWeekAt: teaching began Tue 22 Sep 2026, so that week is week 1", () => {
  const week = (iso: string) => teachingWeekAt("qmul", new Date(iso));
  assert.deepEqual(week("2026-09-22T09:00:00Z"), { term: "2026-27 Semester A", week: 1, monday: "2026-09-21" });
  assert.equal(week("2026-09-21T00:30:00+01:00")?.week, 1); // Monday just after London midnight
  assert.equal(week("2026-09-20T22:59:00Z"), null); // Sunday 23:59 in London, before term
  assert.equal(week("2026-09-27T22:30:00Z")?.week, 1); // Sunday 23:30 in London
  assert.equal(week("2026-10-17T12:00:00Z")?.week, 4);
  assert.equal(week("2026-11-02T12:00:00Z")?.week, 7); // QM numbers its reading week
  assert.deepEqual(week("2026-12-07T12:00:00Z"), { term: "2026-27 Semester A", week: 12, monday: "2026-12-07" });
  assert.equal(week("2026-12-14T12:00:00Z"), null); // after the last teaching week
  assert.equal(week("2027-01-26T12:00:00Z"), null); // Semester B numbering remains unverified
  assert.equal(teachingWeekAt("surrey", new Date("2026-10-17T12:00:00Z")), null);
  assert.equal(teachingWeekAt("surrey", new Date("2027-02-08T12:00:00Z")), null);
});
