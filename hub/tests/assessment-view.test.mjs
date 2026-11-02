import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorId, bigCountdown, buildTimeline, cardsBar, exercisesBar, londonDayStart, papersBar, stackSegments, topicTarget, weakestTopics,
} from "../lib/assessment-view.ts";

const DAY = 24 * 60 * 60 * 1000;
// Monday 2 November 2026, midday in London (GMT).
const NOW = Date.parse("2026-11-02T12:00:00Z");
const at = (iso) => Date.parse(iso);

test("timeline places deadlines by London day across eight weeks", () => {
  const t = buildTimeline(
    [
      { id: "today", at: at("2026-11-02T23:30:00Z") },
      { id: "next-week", at: at("2026-11-09T09:00:00Z") },
      { id: "edge", at: at("2026-12-27T10:00:00Z") },
      { id: "after", at: at("2026-12-28T10:00:00Z") },
      { id: "tbc", at: null },
    ],
    NOW,
  );
  assert.deepEqual(t.dots.map((d) => [d.id, d.day]), [["today", 0], ["next-week", 7], ["edge", 55]]);
  assert.deepEqual(t.later, ["after"]);
  assert.deepEqual(t.undated, ["tbc"]);
  assert.ok(t.dots.every((d) => d.pos > 0 && d.pos < 1));
  assert.ok(Math.abs(t.dots[1].pos - 7.5 / 56) < 1e-9);
});

test("timeline has a tick per week with dated labels", () => {
  const t = buildTimeline([], NOW);
  assert.equal(t.ticks.length, 9);
  assert.equal(t.ticks[0].label, "Today");
  assert.equal(t.ticks[1].label, "9 Nov");
  assert.equal(t.ticks[8].pos, 1);
  assert.equal(t.lanes, 1);
});

test("timeline treats late-evening UTC in summer as the next London day", () => {
  const summer = Date.parse("2026-06-01T12:00:00Z");
  assert.equal(londonDayStart(Date.parse("2026-06-01T23:30:00Z")), Date.parse("2026-06-02T00:00:00Z"));
  const t = buildTimeline([{ id: "x", at: Date.parse("2026-06-01T23:30:00Z") }], summer);
  assert.equal(t.dots[0].day, 1);
});

test("deadlines already under way sit at today, and close dots take separate rows", () => {
  const t = buildTimeline(
    [
      { id: "started", at: NOW - 3 * DAY },
      { id: "a", at: at("2026-11-03T10:00:00Z") },
      { id: "b", at: at("2026-11-03T15:00:00Z") },
      { id: "far", at: at("2026-12-01T10:00:00Z") },
    ],
    NOW,
  );
  const by = Object.fromEntries(t.dots.map((d) => [d.id, d]));
  assert.equal(by.started.day, 0);
  // today and tomorrow are one day apart, under the gap, so they stack.
  assert.notEqual(by.started.lane, by.a.lane);
  assert.notEqual(by.a.lane, by.b.lane);
  assert.equal(by.far.lane, 0);
  assert.equal(t.lanes, 3);
});

test("a crowd of dots never uses more than four rows", () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, at: at("2026-11-10T09:00:00Z") + i }));
  const t = buildTimeline(entries, NOW);
  assert.equal(t.dots.length, 9);
  assert.ok(Math.max(...t.dots.map((d) => d.lane)) <= 3);
  assert.equal(t.lanes, 4);
});

test("anchor ids are attribute-safe and distinct per deadline", () => {
  assert.equal(anchorId("user:abc 1/2"), "dl-user_abc_1_2");
  assert.notEqual(anchorId("a"), anchorId("b"));
});

test("big countdown splits a number from its unit", () => {
  assert.deepEqual(bigCountdown("In 3 days"), { big: "3", small: "days" });
  assert.deepEqual(bigCountdown("In 1 hour"), { big: "1", small: "hour" });
  assert.deepEqual(bigCountdown("In 5 weeks"), { big: "5", small: "weeks" });
  assert.deepEqual(bigCountdown("Tomorrow"), { big: "Tomorrow", small: "" });
  assert.deepEqual(bigCountdown("Date TBC"), { big: "Date TBC", small: "" });
});

test("stack segments share the bar by weight and leave a remainder", () => {
  const s = stackSegments([
    { label: "Exam", weight: 60 },
    { label: "Coursework", weight: 30 },
    { label: "Quiz", weight: 5 },
    { label: "Lab", weight: null },
  ]);
  assert.deepEqual(s.segments.map((x) => [x.label, x.percent, x.share, x.compact, x.listed]), [
    ["Exam", 60, 60, false, true],
    ["Coursework", 30, 30, false, true],
    ["Quiz", 5, 5, true, true],
    ["Not listed", 5, 5, true, false],
  ]);
  assert.deepEqual(s.unweighted, ["Lab"]);
  assert.equal(s.total, 95);
});

test("stack segments fill the bar exactly when weights add to 100", () => {
  const s = stackSegments([{ label: "Exam", weight: 70 }, { label: "Report", weight: 30 }]);
  assert.equal(s.segments.length, 2);
  assert.equal(s.segments.reduce((sum, x) => sum + x.share, 0), 100);
});

test("stack segments scale down weights over 100 but keep the listed figures", () => {
  const s = stackSegments([{ label: "A", weight: 80 }, { label: "B", weight: 40 }]);
  assert.deepEqual(s.segments.map((x) => [x.percent, x.share]), [[80, 66.7], [40, 33.3]]);
  assert.equal(s.total, 120);
});

test("stack segments for no weights are empty, and zero or bad weights draw nothing", () => {
  assert.deepEqual(stackSegments([]).segments, []);
  const s = stackSegments([{ label: "Formative", weight: 0 }, { label: "Odd", weight: Number.NaN }, { label: "TBC", weight: null }]);
  assert.deepEqual(s.segments, []);
  assert.deepEqual(s.unweighted, ["Odd", "TBC"]);
});

test("each readiness bar says its own thing and shows a dash with no material", () => {
  assert.deepEqual(cardsBar({ total: 40, reviewed: 12, weak: 5, mastered: 1, points: 6, strength: 0.15 }), { value: 15, text: "12 of 40 reviewed, 5 weak" });
  assert.equal(cardsBar({ total: 8, reviewed: 8, weak: 0, mastered: 2, points: 6, strength: 0.75 }).text, "8 of 8 reviewed");
  assert.deepEqual(exercisesBar({ total: 8, done: 3, right: 2, partly: 1, wrong: 0, points: 2.5, strength: 0.3125 }), { value: 31, text: "3 of 8 done" });
  assert.deepEqual(papersBar({ attempts: 2, got: 13, total: 20, strength: 0.65, latest: 1 }), { value: 65, text: "65% on last papers" });
  assert.equal(papersBar({ attempts: 1, got: 1, total: 2, strength: 0.5, latest: 1 }).text, "50% on last paper");
  for (const bar of [cardsBar(null), exercisesBar(null), papersBar(null)]) assert.deepEqual(bar, { value: null, text: "—" });
});

test("weakest topics skip Other and topics with nothing to practise", () => {
  const topic = (name, priority, level, extra = {}) => ({ key: name, name, number: 1, other: false, cards: null, exercises: null, papers: null, priority, level, ...extra });
  const picked = weakestTopics([
    topic("Easy", 0.1, "strong"),
    topic("Empty", 0, "none"),
    topic("Other", 0.9, "weak", { other: true }),
    topic("Hard", 0.8, "weak"),
    topic("Middle", 0.5, "building"),
  ]);
  assert.deepEqual(picked.map((t) => t.name), ["Hard", "Middle"]);
  assert.deepEqual(weakestTopics([], 2), []);
});

test("a topic link goes to its cards first, then exercises, then papers", () => {
  const cards = (extra) => ({ total: 10, reviewed: 10, weak: 0, mastered: 0, points: 0, strength: 0, ...extra });
  assert.deepEqual(topicTarget({ cards: cards({ weak: 2 }), exercises: { total: 1 } }), { view: "cards", mode: "weak" });
  assert.deepEqual(topicTarget({ cards: cards({ reviewed: 4 }), exercises: null }), { view: "cards", mode: "unseen" });
  assert.deepEqual(topicTarget({ cards: cards(), exercises: null }), { view: "cards", mode: "smart" });
  assert.deepEqual(topicTarget({ cards: null, exercises: { total: 3 } }), { view: "tutorials" });
  assert.deepEqual(topicTarget({ cards: null, exercises: null }), { view: "papers" });
});
