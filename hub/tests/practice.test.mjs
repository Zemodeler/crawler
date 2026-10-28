import assert from "node:assert/strict";
import test from "node:test";

import {
  awarded,
  buildAttempt,
  gradeBand,
  progression,
  retryPaper,
  scoreOf,
  statusOf,
  studyPackMarkdown,
  topicScores,
} from "../lib/practice.ts";
import { PAPER_SCHEMA, buildPaperPrompt, generatePaper, shuffled, usableQuestions } from "../lib/practice-generate.ts";
import { validate } from "../lib/ai/schema.ts";

const mcq = (id, topic, correctIndex = 0) => ({
  id, type: "mcq", topic, prompt: `Question ${id} about ${topic}?`,
  options: ["right", "wrong one", "wrong two", "wrong three"], correctIndex,
  modelAnswer: "", explanation: `Because ${id}.`, marks: 1,
});
const short = (id, topic, marks = 4) => ({
  id, type: "short", topic, prompt: `Work out ${id} for ${topic}.`, options: [], correctIndex: -1,
  modelAnswer: `The answer to ${id} is 42.`, explanation: "Use the method.", marks,
});
const paper = {
  id: "p1", title: "Mock", kind: "exam",
  questions: [mcq("a", "Averages"), mcq("b", "Averages"), mcq("c", "Tests"), short("d", "Tests")],
};

test("marking: an MCQ is right only on the keyed option, a written answer follows the self-mark", () => {
  assert.equal(awarded(paper.questions[0], { choice: 0 }), 1);
  assert.equal(awarded(paper.questions[0], { choice: 2 }), 0);
  assert.equal(awarded(paper.questions[0], undefined), 0);
  assert.equal(awarded(paper.questions[3], { text: "x", self: "right" }), 4);
  assert.equal(awarded(paper.questions[3], { text: "x", self: "partly" }), 2);
  assert.equal(awarded(paper.questions[3], { text: "x", self: "wrong" }), 0);
  assert.equal(statusOf(paper.questions[0], undefined), "skipped");
  assert.equal(statusOf(paper.questions[3], { text: "x", self: "partly" }), "partial");
  assert.equal(statusOf(paper.questions[0], { choice: 3 }), "wrong");
});

test("the score is marks, not question count, and the grade bands are the UK ones", () => {
  const { score, total, percent } = scoreOf(paper.questions, { a: { choice: 0 }, b: { choice: 1 }, c: { choice: 0 }, d: { text: "x", self: "partly" } });
  assert.deepEqual([score, total, percent], [4, 7, 57]);
  assert.equal(gradeBand(70).short, "1st");
  assert.equal(gradeBand(69).short, "2:1");
  assert.equal(gradeBand(50).short, "2:2");
  assert.equal(gradeBand(40).short, "3rd");
  assert.equal(gradeBand(39).short, "Fail");
  assert.equal(scoreOf([], {}).percent, 0);
});

test("topics are ranked weakest first", () => {
  const attempt = buildAttempt(paper, { a: { choice: 0 }, b: { choice: 0 }, c: { choice: 2 }, d: { text: "x", self: "wrong" } }, 90);
  const topics = topicScores([attempt]);
  assert.equal(topics[0].topic, "Tests");
  assert.equal(topics[0].percent, 0);
  assert.equal(topics[1].topic, "Averages");
  assert.equal(topics[1].percent, 100);
});

test("the study pack lists only what was missed, with the right answer and why", () => {
  const attempt = buildAttempt(paper, { a: { choice: 0 }, b: { choice: 2 }, c: { choice: 0 }, d: { text: "no idea", self: "wrong" } }, 125, Date.UTC(2026, 9, 28));
  const md = studyPackMarkdown(attempt);
  assert.match(md, /^# Study pack: Mock/);
  assert.match(md, /Score 2\/7 \(29%\), grade Fail\. Time 2:05\./);
  assert.match(md, /Question b about Averages\?/);
  assert.match(md, /\*\*Your answer:\*\* wrong two/);
  assert.match(md, /\*\*Correct answer:\*\* right/);
  assert.match(md, /The answer to d is 42\./);
  assert.doesNotMatch(md, /Question a about/);
  assert.doesNotMatch(md, /\n[ \t]+- /, "no nested lists, which the reader cannot render");

  const perfect = buildAttempt({ ...paper, questions: [mcq("a", "Averages")] }, { a: { choice: 0 } }, 10);
  assert.match(studyPackMarkdown(perfect), /every question right/);
});

test("retrying builds a paper from the missed questions only, and nothing when none were missed", () => {
  const attempt = buildAttempt(paper, { a: { choice: 0 }, b: { choice: 2 }, c: { choice: 0 }, d: { text: "x", self: "partly" } }, 60);
  const retry = retryPaper(attempt);
  assert.deepEqual(retry.questions.map((q) => q.id), ["b", "d"]);
  assert.equal(retry.kind, "exam");
  assert.equal(retryPaper(buildAttempt({ ...paper, questions: [mcq("a", "x")] }, { a: { choice: 0 } }, 1)), null);
});

test("progression compares the latest attempt with the one before and with the start", () => {
  const at = (percent, i) => ({ percent, createdAt: i });
  assert.equal(progression([]), null);
  assert.deepEqual(progression([at(50, 1)]), { count: 1, average: 50, best: 50, latest: 50, sinceLast: null, overall: null });
  const p = progression([at(40, 1), at(50, 2), at(45, 3), at(60, 4), at(70, 5)]);
  assert.equal(p.sinceLast, 10);
  assert.equal(p.overall, 13); // mean(45,60,70)=58.3 minus mean(40,50,45)=45
  assert.equal(p.best, 70);
  // Order comes from the timestamp, not from the array.
  assert.equal(progression([at(70, 5), at(40, 1)]).sinceLast, 30);
});

/* ------------------------------------------------------------ generation */

const raw = (over = {}) => ({
  type: "mcq", topic: "Averages", prompt: "What is the mean of 2, 4 and 6?",
  options: ["4", "3", "6", "12"], correctIndex: 0, modelAnswer: "", explanation: "Sum is 12, divided by 3.", marks: 1, ...over,
});

test("usableQuestions keeps the right option marked after shuffling and drops unmarkable questions", () => {
  const { questions, dropped } = usableQuestions(
    [
      raw(),
      raw({ prompt: "What is the mean of 2, 4 and 6?" }), // duplicate prompt
      raw({ prompt: "Options repeat here?", options: ["4", "4", "5", "6"] }),
      raw({ prompt: "Key out of range?", correctIndex: 9 }),
      raw({ prompt: "Only two options?", options: ["a", "b"] }),
      raw({ type: "short", prompt: "Explain the median.", options: [], correctIndex: -1, modelAnswer: "", marks: 3 }),
      raw({ type: "short", prompt: "Explain the mode.", options: [], correctIndex: -1, modelAnswer: "The most frequent value.", marks: 99 }),
    ],
    "exam",
    () => 0.1,
  );
  assert.equal(dropped, 5);
  assert.equal(questions.length, 2);
  const first = questions[0];
  assert.equal(first.options[first.correctIndex], "4");
  assert.equal(new Set(first.options).size, 4);
  assert.equal(questions[1].marks, 10);
  assert.equal(questions[1].correctIndex, -1);
});

test("an MCQ quiz drops written questions and exercises drop MCQs", () => {
  const mixed = [raw(), raw({ type: "short", prompt: "Explain the mode.", options: [], correctIndex: -1, modelAnswer: "Most frequent.", marks: 2 })];
  assert.deepEqual(usableQuestions(mixed, "mcq").questions.map((q) => q.type), ["mcq"]);
  assert.deepEqual(usableQuestions(mixed, "exercise").questions.map((q) => q.type), ["short"]);
});

test("shuffled keeps every item and uses the supplied randomness", () => {
  assert.deepEqual([...shuffled([1, 2, 3, 4, 5])].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(shuffled([1, 2, 3], () => 0), [2, 3, 1]);
});

test("the paper schema accepts a normal answer and rejects an unknown question type", () => {
  assert.deepEqual(validate({ title: "Mock paper", questions: [raw()] }, PAPER_SCHEMA), []);
  assert.notDeepEqual(validate({ title: "Mock paper", questions: [raw({ type: "essay" })] }, PAPER_SCHEMA), []);
});

test("the prompt carries the student's brief, the past-paper rule and the counts", () => {
  const p = buildPaperPrompt({ kind: "exam", count: 10, brief: "harder, more calculations", module: "ECS529U", pastPapers: 2 });
  assert.match(p, /exactly 10 questions/);
  assert.match(p, /harder, more calculations/);
  assert.match(p, /Never copy a past question/);
  assert.match(p, /Match the past papers/);
  const none = buildPaperPrompt({ kind: "mcq", count: 5, brief: "", module: "M", pastPapers: 0 });
  assert.match(none, /no past paper/);
  assert.doesNotMatch(none, /student's own request/);
});

function fakeClient(data) {
  const seen = [];
  return {
    seen,
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async generate(request) {
      seen.push(request);
      return { data, raw: "", usage: {}, costUsd: null, model: "fake", transport: "apikey", repaired: false };
    },
  };
}
const file = (path, text, category = "Past papers") => ({
  path, name: path.split("/").pop(), ext: "txt", category, topic: "", text,
  file: { name: path, size: text.length, text: async () => text },
});

test("generatePaper reads the sources, fences them and returns a stored-ready paper", async () => {
  const client = fakeClient({ title: "Mock A", questions: [raw(), raw({ prompt: "What is the median of 1, 5, 9?", options: ["5", "1", "9", "15"] }), raw({ prompt: "What is the range of 1, 5, 9?", options: ["8", "1", "9", "5"] })] });
  const { paper, dropped } = await generatePaper({
    client, kind: "mcq", count: 3, brief: "easy", module: "M",
    sources: [file("Course Materials/Past Papers/2023.txt", "Q1. What is the mean of 3 numbers? ".repeat(5)), file("Course Materials/Lectures/w1.txt", "Averages and spread explained at length. ".repeat(5), "Source materials")],
  });
  assert.equal(paper.questions.length, 3);
  assert.equal(dropped, 0);
  assert.deepEqual(paper.sources, ["Course Materials/Past Papers/2023.txt", "Course Materials/Lectures/w1.txt"]);
  const request = client.seen[0];
  assert.match(request.messages[0].content, /### PAST PAPER: 2023\.txt/);
  assert.match(request.messages[0].content, /<untrusted_course_content/);
  assert.ok(request.messages[0].content.indexOf("PAST PAPER") < request.messages[0].content.indexOf("COURSE MATERIAL"));
  assert.match(request.system, /easy/);
});

test("generatePaper fails clearly with no readable source or too few usable questions", async () => {
  await assert.rejects(
    generatePaper({ client: fakeClient({ title: "x", questions: [] }), kind: "mcq", count: 5, brief: "", module: "M", sources: [file("a.txt", "   ")] }),
    /could be read/,
  );
  await assert.rejects(
    generatePaper({ client: fakeClient({ title: "Mock", questions: [raw()] }), kind: "mcq", count: 5, brief: "", module: "M", sources: [file("a.txt", "some real course text ".repeat(5))] }),
    /enough usable questions/,
  );
});
