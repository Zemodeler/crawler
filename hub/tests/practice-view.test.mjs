import assert from "node:assert/strict";
import test from "node:test";

import { buildReadiness } from "../lib/readiness.ts";
import { exerciseKey } from "../lib/tutorial.ts";
import {
  barFor,
  cardsBar,
  countCards,
  doNext,
  exerciseKeysFor,
  exercisesBar,
  exercisesByCategory,
  focusBrief,
  hasNoMaterial,
  papersBar,
  parseReviews,
  practiceSearch,
  reviseTarget,
  splitTopics,
  topicCategories,
  topicsForSheets,
} from "../lib/practice-view.ts";

const csv = (rows) => `Question,Answer\n${rows.map((r) => r.join(",")).join("\n")}\n`;
const files = [
  { path: "Revision/Topic Packs/01 - Design Patterns (Topic Pack).md", ext: "md" },
  { path: "Revision/Topic Packs/02 - Testing (Topic Pack).md", ext: "md" },
  { path: "Flashcards/01 - Design Patterns/core.csv", ext: "csv", text: csv([["a", "b"], ["c", "d"], ["e", "f"]]) },
];
const sheet = { id: "s-week1", exercises: [{ id: "1", topic: "Design Patterns" }, { id: "2", topic: "Testing" }, { id: "3", topic: "Unrelated zebra" }] };
const key = (n) => exerciseKey(sheet, sheet.exercises[n]);

test("practiceSearch keeps the module and the topic or mode just chosen, and drops how the student arrived", () => {
  const arrived = "?view=papers&module=2025-26%2FECS505U&source=a.pdf&auto=1&exam=Final+exam&topic=Old";
  assert.equal(practiceSearch(arrived, { view: "dashboard" }), "?view=dashboard&module=2025-26%2FECS505U");
  assert.equal(
    practiceSearch(arrived, { view: "cards", topic: "Design Patterns", mode: "weak" }),
    "?view=cards&mode=weak&topic=Design+Patterns&module=2025-26%2FECS505U",
  );
  // A card mode means nothing outside the Cards view.
  assert.equal(practiceSearch("", { view: "tutorials", topic: "Testing", mode: "weak" }), "?view=tutorials&topic=Testing");
});

test("focusBrief is empty without a topic", () => {
  assert.equal(focusBrief("Hypothesis testing"), "Focus on Hypothesis testing");
  assert.equal(focusBrief(""), "");
});

test("countCards counts rows with a question and an answer, and skips decks without both columns", () => {
  const counts = countCards([
    { path: "a.csv", ext: "csv", text: "﻿Question,Answer\nq1,a1\nq2,\n,a3\nq4,a4\n" },
    { path: "b.csv", ext: "csv", text: "Front,Back\nx,y\n" },
    { path: "c.md", ext: "md", text: "Question,Answer\nx,y\n" },
    { path: "d.csv", ext: "csv" },
  ]);
  assert.deepEqual(counts, { "a.csv": 2 });
});

test("parseReviews keeps only reviews with a numeric confidence and survives bad storage", () => {
  assert.deepEqual(parseReviews(JSON.stringify({ reviews: { "x:1": { confidence: 4, due: 1 }, "x:2": { confidence: "5" }, "x:3": null } })), { "x:1": { confidence: 4 } });
  assert.deepEqual(parseReviews("not json"), {});
  assert.deepEqual(parseReviews(null), {});
  assert.deepEqual(parseReviews(JSON.stringify({ reviews: [1] })), { });
});

test("topicCategories matches folders by the canonical topic key", () => {
  const categories = ["Design Patterns", "Software & Testing", "General"];
  assert.deepEqual(topicCategories(categories, "Design Patterns"), ["Design Patterns"]);
  assert.deepEqual(topicCategories(categories, "Software and Testing"), ["Software & Testing"]);
  assert.deepEqual(topicCategories(categories, "Nothing"), []);
});

test("each bar reads as its own text and a dash when the kind has no material", () => {
  assert.deepEqual(cardsBar({ total: 40, reviewed: 12, weak: 5, mastered: 1, points: 8, strength: 0.2 }), { percent: 20, text: "12 of 40 reviewed, 5 weak", empty: "" });
  assert.equal(cardsBar({ total: 4, reviewed: 0, weak: 0, mastered: 0, points: 0, strength: 0 }).text, "0 of 4 reviewed");
  assert.equal(exercisesBar({ total: 8, done: 3, right: 2, partly: 1, wrong: 0, points: 2.5, strength: 0.31 }).text, "3 of 8 done");
  assert.equal(exercisesBar({ total: 8, done: 3, right: 1, partly: 0, wrong: 2, points: 1, strength: 0.12 }).text, "3 of 8 done, 2 missed");
  assert.equal(papersBar({ attempts: 3, got: 13, total: 20, strength: 0.65, latest: 1 }).text, "65% on last papers");
  assert.equal(papersBar({ attempts: 1, got: 13, total: 20, strength: 0.65, latest: 1 }).text, "65% on last paper");
  for (const bar of [cardsBar(null), exercisesBar(null), papersBar(null)]) {
    assert.equal(bar.percent, null);
    assert.equal(bar.text, "–");
    assert.ok(bar.empty);
  }
});

test("a topic's bars come from the evidence kinds separately", () => {
  const list = buildReadiness({
    files,
    cardCounts: { "Flashcards/01 - Design Patterns/core.csv": 3 },
    reviews: { "Flashcards/01 - Design Patterns/core.csv:a": { confidence: 1 } },
    sheets: [sheet],
    progress: { marks: { [key(0)]: "right" } },
    attempts: [],
  });
  const dp = list.find((t) => t.name === "Design Patterns");
  assert.equal(barFor(dp, "cards").text, "1 of 3 reviewed, 1 weak");
  assert.equal(barFor(dp, "exercises").text, "1 of 1 done");
  assert.equal(barFor(dp, "papers").text, "–");
});

test("splitTopics puts Other aside and doNext skips it", () => {
  const list = buildReadiness({
    files,
    cardCounts: { "Flashcards/01 - Design Patterns/core.csv": 3 },
    reviews: {},
    sheets: [sheet],
    progress: { marks: {} },
    attempts: [],
  });
  const { topics, other } = splitTopics(list);
  assert.ok(other && other.other);
  assert.ok(topics.every((t) => !t.other));
  const action = doNext(list);
  assert.ok(action);
  assert.notEqual(action.topicKey, "other");
  assert.equal(doNext([other]), null);
  assert.equal(doNext([]), null);
});

test("hasNoMaterial is true only when no topic has cards, exercises or papers", () => {
  assert.equal(hasNoMaterial([]), true);
  const onlyPack = buildReadiness({ files: [files[0]], cardCounts: {}, reviews: {}, sheets: [], progress: { marks: {} }, attempts: [] });
  assert.equal(hasNoMaterial(onlyPack), true);
  const withCards = topicsForSheets(files, []);
  assert.equal(hasNoMaterial(withCards), false);
});

test("an exercise finds its topic's cards, and a topic finds its exercises", () => {
  const topics = topicsForSheets(files, [sheet]);
  assert.deepEqual(exerciseKeysFor(topics, "Design Patterns"), [key(0)]);
  assert.deepEqual(exerciseKeysFor(topics, "Testing"), [key(1)]);
  assert.equal(exerciseKeysFor(topics, "Algebra"), null);
  assert.equal(exerciseKeysFor(topics, "Other"), null);
  // Design Patterns has a deck; Testing has a study pack but no cards; the zebra exercise is under Other.
  assert.equal(reviseTarget(topics, key(0)), "Design Patterns");
  assert.equal(reviseTarget(topics, key(1)), null);
  assert.equal(reviseTarget(topics, key(2)), null);
  assert.equal(reviseTarget(topics, "missing"), null);
});

test("exercisesByCategory counts the exercises each card category has and ignores unmatched ones", () => {
  const counts = exercisesByCategory(["Design Patterns", "Testing", "Algebra"], [sheet]);
  assert.deepEqual(counts, { "Design Patterns": 1, Testing: 1 });
});
