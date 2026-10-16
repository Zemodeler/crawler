import assert from "node:assert/strict";
import { test } from "node:test";

import type { TermWeekMap } from "../src/extraction-types.ts";
import { resolveWeek, weekMapFor, weekMapFromQuote } from "../src/weeks.ts";

const semA = weekMapFor("qmul", "2026-27 Semester A")!;
const semB = weekMapFor("qmul", "2026-27 Semester B")!;

test("weekMapFor reads the configured QM terms", () => {
  assert.deepEqual(semA, { termStart: "2026-09-21", readingWeeks: [], source: { kind: "config" } });
  assert.equal(semB.termStart, "2027-01-25");
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
  assert.equal(resolveWeek(semB, 9, 1, "09:00").iso, "2027-03-22T09:00:00.000Z");
  assert.equal(resolveWeek(semB, 10, 1, "09:00").iso, "2027-03-29T08:00:00.000Z");
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
