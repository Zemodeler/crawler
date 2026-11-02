import assert from "node:assert/strict";
import test from "node:test";

import { KIND_WEIGHTS, buildReadiness, examReadiness, matchTopic, nextActionFor } from "../lib/readiness.ts";
import { exerciseKey } from "../lib/tutorial.ts";

const DP = "Flashcards/01 - Design Patterns/core.csv";
const TEST = "Flashcards/02 - Testing/core.csv";
const files = [
  { path: "Revision/Topic Packs/01 - Design Patterns (Topic Pack).md" },
  { path: "Revision/Topic Packs/02 - Testing (Topic Pack).md" },
];
const base = { files, cardCounts: {}, reviews: {}, sheets: [], progress: { marks: {} }, attempts: [] };

const sheet = (topics, id = "s-week1") => ({
  id,
  exercises: topics.map((topic, i) => ({ id: String(i + 1), topic })),
});
const mcq = (id, topic, marks = 1) => ({ id, type: "mcq", topic, prompt: "?", options: ["a", "b"], correctIndex: 0, modelAnswer: "", explanation: "", marks });
const attempt = (id, createdAt, questions, choices) => ({
  id,
  paperId: "p",
  title: "Paper",
  kind: "mcq",
  createdAt,
  seconds: 1,
  questions,
  answers: Object.fromEntries(questions.map((q, i) => [q.id, { choice: choices[i] }])),
  score: 0,
  total: 0,
  percent: 0,
});
const byName = (list, name) => list.find((t) => t.name === name);

test("a free-text topic matches the canonical key first, then the topic sharing most words", () => {
  const topics = [
    { key: "Design and Patterns", name: "Design and Patterns" },
    { key: "Software Testing", name: "Software Testing" },
  ];
  assert.equal(matchTopic("Design & Patterns", topics), "Design and Patterns");
  assert.equal(matchTopic("Unit testing basics", topics), "Software Testing");
  assert.equal(matchTopic("Quantum chromodynamics", topics), null);
});

test("a topic text that fits two topics equally well is not guessed", () => {
  const topics = [
    { key: "Design Patterns", name: "Design Patterns" },
    { key: "Design Principles", name: "Design Principles" },
  ];
  assert.equal(matchTopic("Design", topics), null);
});

test("card strength counts unreviewed cards as unknown and tracks weak and mastered", () => {
  const topics = buildReadiness({
    ...base,
    cardCounts: { [DP]: 4 },
    reviews: { [`${DP}:a`]: { confidence: 5 }, [`${DP}:b`]: { confidence: 1 }, [`${DP}:c`]: { confidence: 3 } },
  });
  const dp = byName(topics, "Design Patterns");
  assert.deepEqual(
    { total: dp.cards.total, reviewed: dp.cards.reviewed, weak: dp.cards.weak, mastered: dp.cards.mastered },
    { total: 4, reviewed: 3, weak: 1, mastered: 1 },
  );
  assert.equal(dp.cards.strength, (1 + 0 + 0.5) / 4);
  assert.deepEqual(dp.decks, [DP]);
  assert.equal(byName(topics, "Testing").cards, null);
});

test("reviews of cards that left the deck never count for more than the deck holds", () => {
  const reviews = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${DP}:${i}`, { confidence: 5 }]));
  const dp = byName(buildReadiness({ ...base, cardCounts: { [DP]: 4 }, reviews }), "Design Patterns");
  assert.equal(dp.cards.reviewed, 4);
  assert.equal(dp.cards.strength, 1);
});

test("a loose deck with no topic folder belongs to no topic", () => {
  const topics = buildReadiness({ ...base, cardCounts: { "Flashcards/loose.csv": 9 } });
  assert.ok(topics.every((t) => !t.cards));
});

test("exercises are matched to topics and unmatched ones are kept under Other", () => {
  const s = sheet(["Design patterns", "Software testing", "Astrophysics"]);
  const topics = buildReadiness({
    ...base,
    sheets: [s],
    progress: { marks: { [exerciseKey(s, s.exercises[0])]: "right", [exerciseKey(s, s.exercises[1])]: "wrong" } },
  });
  const dp = byName(topics, "Design Patterns");
  assert.deepEqual({ total: dp.exercises.total, done: dp.exercises.done, strength: dp.exercises.strength }, { total: 1, done: 1, strength: 1 });
  assert.equal(byName(topics, "Testing").exercises.wrong, 1);
  const other = topics.find((t) => t.other);
  assert.equal(other.exercises.total, 1);
  assert.equal(other.exercises.done, 0);
  assert.equal(topics.at(-1), other, "Other sorts last");
  assert.deepEqual(dp.exerciseKeys, [exerciseKey(s, s.exercises[0])]);
});

test("papers use only the latest three attempts that touched a topic", () => {
  const q = [mcq("q1", "Design patterns")];
  const old = attempt("a0", 1, q, [1]); // wrong, but the oldest of four
  const recent = [2, 3, 4].map((n) => attempt(`a${n}`, n, q, [0])); // right
  const dp = byName(buildReadiness({ ...base, attempts: [old, ...recent] }), "Design Patterns");
  assert.equal(dp.papers.attempts, 3);
  assert.equal(dp.papers.strength, 1);
  assert.equal(dp.papers.latest, 4);
});

test("the subject decides which weakness is ordered first", () => {
  const cardsOnly = "Flashcards/01 - Design Patterns/core.csv";
  const perfect = "Flashcards/02 - Testing/core.csv";
  const sheetA = sheet(["Design patterns"], "s-a");
  const sheetB = sheet(["Software testing"], "s-b");
  const input = {
    ...base,
    // Design Patterns: cards never reviewed, exercise right. Testing: cards perfect, exercise wrong.
    cardCounts: { [cardsOnly]: 2, [perfect]: 2 },
    reviews: { [`${perfect}:a`]: { confidence: 5 }, [`${perfect}:b`]: { confidence: 5 } },
    sheets: [sheetA, sheetB],
    progress: { marks: { [exerciseKey(sheetA, sheetA.exercises[0])]: "right", [exerciseKey(sheetB, sheetB.exercises[0])]: "wrong" } },
  };
  assert.equal(buildReadiness({ ...input, subject: "law" })[0].name, "Design Patterns");
  assert.equal(buildReadiness({ ...input, subject: "stem" })[0].name, "Testing");
  for (const row of Object.values(KIND_WEIGHTS)) assert.ok(Math.abs(row.cards + row.exercises + row.papers - 1) < 1e-9);
});

test("topic levels: nothing, not started, needs work, getting there, on track", () => {
  const reviews = { [`${DP}:a`]: { confidence: 1 }, [`${DP}:b`]: { confidence: 1 }, [`${TEST}:a`]: { confidence: 5 }, [`${TEST}:b`]: { confidence: 4 } };
  const topics = buildReadiness({ ...base, cardCounts: { [DP]: 2, [TEST]: 2, "Flashcards/03 - Fresh/core.csv": 3 }, reviews });
  assert.equal(byName(topics, "Design Patterns").level, "weak");
  assert.equal(byName(topics, "Testing").level, "strong");
  assert.equal(byName(topics, "Fresh").level, "new");
  const empty = buildReadiness(base);
  assert.ok(empty.every((t) => t.level === "none"));
});

test("an exam's readiness covers the topics it names and sums their evidence", () => {
  const reviews = { [`${DP}:a`]: { confidence: 1 }, [`${DP}:b`]: { confidence: 5 }, [`${TEST}:a`]: { confidence: 5 } };
  const topics = buildReadiness({ ...base, cardCounts: { [DP]: 2, [TEST]: 1 }, reviews });
  const named = examReadiness(topics, "Design Patterns mid-term test");
  assert.equal(named.named, true);
  assert.deepEqual(named.topics.map((t) => t.name), ["Design Patterns"]);
  assert.equal(named.cards.total, 2);
  assert.equal(named.cards.weak, 1);
  assert.equal(named.exercises, null);
  assert.equal(named.papers, null);

  const unnamed = examReadiness(topics, "Final exam");
  assert.equal(unnamed.named, false);
  assert.equal(unnamed.topics.length, 2);
  assert.equal(unnamed.cards.total, 3);
  assert.equal(unnamed.topics[0].name, "Design Patterns", "weakest first");
});

test("the next action names the weakest topic and the kind of practice that helps most", () => {
  const reviews = { [`${DP}:a`]: { confidence: 1 }, [`${DP}:b`]: { confidence: 2 } };
  const topics = buildReadiness({ ...base, cardCounts: { [DP]: 3 }, reviews });
  const next = examReadiness(topics, "Final exam", "law").next;
  assert.equal(next.kind, "cards");
  assert.equal(next.topic, "Design Patterns");
  assert.equal(next.view, "cards");
  assert.equal(next.mode, "weak");
  assert.match(next.label, /Revisit 2 weak cards on Design Patterns/);

  const s = sheet(["Design patterns", "Design patterns"]);
  const withExercises = buildReadiness({ ...base, sheets: [s] });
  const action = nextActionFor(byName(withExercises, "Design Patterns"), "stem");
  assert.equal(action.kind, "exercises");
  assert.equal(action.view, "tutorials");
  assert.match(action.detail, /2 not tried yet/);
});

test("a topic with only a study pack is offered a paper; one fully mastered or in Other is offered nothing", () => {
  const packOnly = byName(buildReadiness(base), "Testing");
  assert.equal(nextActionFor(packOnly).kind, "papers");
  const mastered = byName(buildReadiness({ ...base, cardCounts: { [TEST]: 1 }, reviews: { [`${TEST}:a`]: { confidence: 5 } } }), "Testing");
  assert.equal(nextActionFor(mastered), null);
  const s = sheet(["Astrophysics"]);
  const other = buildReadiness({ ...base, sheets: [s] }).find((t) => t.other);
  assert.equal(nextActionFor(other), null);
});
