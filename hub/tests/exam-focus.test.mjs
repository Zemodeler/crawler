import assert from "node:assert/strict";
import test from "node:test";
import { buildFocus, countdown, isExamLike, keywords, parseSourceParams, pickSources, practiceHref, rankSources } from "../lib/exam-focus.ts";

const DAY = 24 * 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);
const file = (path, days = 0) => ({ path, modified: at("2026-10-01T12:00:00Z") + days * DAY });

test("exams, tests and quizzes are found by kind or title", () => {
  assert.ok(isExamLike({ kind: "exam", title: "Final" }));
  assert.ok(isExamLike({ kind: "quiz", title: "Week 3" }));
  assert.ok(isExamLike({ kind: "coursework", title: "In-class Test 1" }));
  assert.ok(isExamLike({ kind: "other", title: "Moodle Quizzes" }));
  assert.ok(!isExamLike({ kind: "coursework", title: "Contestant report" }));
  assert.ok(!isExamLike({ kind: "lab", title: "Lab 3" }));
});

test("countdown counts London days, hours and weeks", () => {
  const now = at("2026-10-28T10:00:00Z");
  assert.equal(countdown(at("2026-10-28T23:00:00Z"), at("2026-10-28T23:00:00Z"), true, now).label, "Today");
  assert.equal(countdown(at("2026-10-29T00:00:00Z"), at("2026-10-29T00:00:00Z"), true, now).label, "Tomorrow");
  assert.equal(countdown(at("2026-11-03T00:00:00Z"), at("2026-11-03T00:00:00Z"), true, now).label, "In 6 days");
  assert.equal(countdown(at("2026-11-25T00:00:00Z"), at("2026-11-25T00:00:00Z"), true, now).label, "In 4 weeks");
  assert.equal(countdown(at("2026-10-28T15:30:00Z"), at("2026-10-28T15:30:00Z"), false, now).label, "In 5 hours");
  assert.equal(countdown(at("2026-10-28T10:20:00Z"), at("2026-10-28T10:20:00Z"), false, now).label, "Within the hour");
  assert.equal(countdown(at("2026-10-27T10:00:00Z"), at("2026-10-27T10:00:00Z"), false, now).passed, true);
  assert.equal(countdown(at("2026-10-26T00:00:00Z"), at("2026-11-01T23:59:59Z"), true, now).label, "This week");
  assert.ok(countdown(at("2026-11-02T00:00:00Z"), at("2026-11-02T00:00:00Z"), true, now).urgent);
  assert.ok(!countdown(at("2026-11-25T00:00:00Z"), at("2026-11-25T00:00:00Z"), true, now).urgent);
});

test("keywords drop assessment filler and module codes", () => {
  assert.deepEqual(keywords("ECS505U Final Exam: Design Patterns and Testing"), ["design", "pattern", "testing"]);
  assert.deepEqual(keywords("Mid-term test"), []);
});

test("sources rank by topic relevance, then recency; packs, decks and guides are never sources", () => {
  const files = [
    file("Lectures/Week 1 Intro.pdf", 1),
    file("Lectures/Week 4 Design Patterns.pdf", -20),
    file("Lectures/Week 9 Networks.pdf", 30),
    file("Revision/Topic Packs/01 - Design Patterns (Topic Pack).md", 40),
    file("Flashcards/01 - Design Patterns/core.csv", 40),
    file("Notes/design.png", 40),
  ];
  const ranked = rankSources(files, "Final Exam: Design Patterns");
  assert.deepEqual(ranked.map((f) => f.path), ["Lectures/Week 4 Design Patterns.pdf", "Lectures/Week 9 Networks.pdf", "Lectures/Week 1 Intro.pdf"]);
  assert.ok(ranked[0].relevant && !ranked[1].relevant);
});

test("past papers lead for an exam but not for other assessments", () => {
  const files = [file("Past Papers/2024 paper.pdf", -50), file("Lectures/Week 9.pdf", 30), file("Lectures/Week 8.pdf", 20)];
  assert.equal(rankSources(files, "Final Exam", { exam: true })[0].path, "Past Papers/2024 paper.pdf");
  assert.equal(rankSources(files, "Week 5 quiz")[0].path, "Lectures/Week 9.pdf");
});

test("a title that names no topic still picks the most recent files, and a named topic stays focused", () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`Lectures/Week ${i + 1}.pdf`, i));
  assert.deepEqual(pickSources(files, "Midterm test").map((f) => f.path), ["Lectures/Week 8.pdf", "Lectures/Week 7.pdf", "Lectures/Week 6.pdf"]);

  const topical = [...files, file("Lectures/Recursion.pdf", -9), file("Seminars/Recursion seminar.pdf", -8), file("Lectures/Recursion II.pdf", -7)];
  assert.deepEqual(pickSources(topical, "Recursion test").map((f) => f.path).sort(), ["Lectures/Recursion II.pdf", "Lectures/Recursion.pdf", "Seminars/Recursion seminar.pdf"]);
  assert.equal(pickSources(topical, "Week 1 quiz", { limit: 2 }).length, 3);
  assert.deepEqual(pickSources([], "anything"), []);
});

const packs = [
  file("Revision/Topic Packs/01 - Agreement (Topic Pack).md"),
  file("Revision/Topic Packs/02 - Remedies (Topic Pack).md"),
  file("Revision/Topic Packs/03 - Privity (Topic Pack).md"),
];
const cardCounts = {
  "Flashcards/01 - Agreement/core.csv": 10,
  "Flashcards/02 - Remedies/core.csv": 10,
  "Flashcards/loose.csv": 4,
};

test("focus names the topics the assessment mentions, with their weak and unreviewed cards", () => {
  const reviews = {
    "Flashcards/02 - Remedies/core.csv:a": { confidence: 1 },
    "Flashcards/02 - Remedies/core.csv:b": { confidence: 2 },
    "Flashcards/02 - Remedies/core.csv:c": { confidence: 5 },
    "Flashcards/01 - Agreement/core.csv:d": { confidence: 1 },
  };
  const items = buildFocus({ files: packs, text: "Contract Remedies test", opened: {}, reviews, cardCounts });
  assert.deepEqual(items.filter((i) => i.kind === "topic"), [{ kind: "topic", label: "Remedies", detail: "2 weak cards · 7 not reviewed yet" }]);
  assert.ok(items.some((i) => i.label === "Revisit 3 weak flashcards"));
  assert.ok(items.some((i) => i.label === "20 flashcards not reviewed yet"));
});

test("with no topic named, focus falls to the topics that need most work", () => {
  const reviews = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Flashcards/01 - Agreement/core.csv:${i}`, { confidence: 5 }]));
  const topics = buildFocus({ files: packs, text: "Final exam", opened: {}, reviews, cardCounts }).filter((i) => i.kind === "topic");
  assert.deepEqual(topics.map((t) => t.label), ["Remedies"]);
});

test("focus lists unopened source files and says nothing about what is already opened", () => {
  const files = [file("Lectures/Week 1.pdf", 1), file("Lectures/Week 2.pdf", 2), file("Lectures/Week 3.pdf", 3)];
  const open = buildFocus({ files, text: "Test", opened: { "Lectures/Week 3.pdf": 1 }, reviews: {}, cardCounts: {} });
  assert.deepEqual(open, [{ kind: "files", label: "2 files not opened yet", detail: "Week 2.pdf, Week 1.pdf" }]);
  const all = buildFocus({ files, text: "Test", opened: Object.fromEntries(files.map((f) => [f.path, 1])), reviews: {}, cardCounts: {} });
  assert.deepEqual(all, []);
});

test("the practice link round-trips the module, sources and exam", () => {
  const sources = ["Lectures/Week 4 Design & Patterns.pdf", "Past Papers/2024.pdf"];
  const href = practiceHref("flashcards", { module: "2026-27/ECS505U - Software Engineering", sources, exam: "Final Exam" });
  assert.ok(href.startsWith("/flashcards?tab=practice&mode=smart&module="));
  const parsed = parseSourceParams(href.slice(href.indexOf("?")));
  assert.deepEqual(parsed, { module: "2026-27/ECS505U - Software Engineering", sources, auto: true, exam: "Final Exam" });
  assert.ok(practiceHref("generate", { module: "m", sources: [], exam: "x" }).startsWith("/generate?module=m"));
  assert.deepEqual(parseSourceParams(""), { module: "", sources: [], auto: false, exam: "" });
});
