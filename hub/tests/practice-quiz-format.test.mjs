import assert from "node:assert/strict";
import test from "node:test";

import { awarded, blankAnswerText, blankCorrect, clozeParts, hasAnswer, parseNumber, retryPaper, statusOf, studyPackMarkdown } from "../lib/practice.ts";
import {
  PAPER_SCHEMA, autoPick, buildPaperPrompt, generatePaper, isPracticeQuizFile, readSources, usableBlanks, usableQuestions,
} from "../lib/practice-generate.ts";
import { inferCategory } from "../lib/course-format.ts";
import { validate } from "../lib/ai/schema.ts";

const QUIZ_PATH = "2026-27/ECS509U - Probability and Matrices/Course Materials/Past Papers/Practice quizzes/Probability demo quiz.md";
const QUIZ_TEXT = "# Probability demo quiz\n\n## Question 1 (6 marks)\n\n| X | p(X=a) (at least 2 digits in decimal) |\n| --- | --- |\n| 1 | [1] |\n";
const quizFile = () => ({ path: QUIZ_PATH, name: "Probability demo quiz.md", ext: "md", category: inferCategory(QUIZ_PATH, "md"), text: QUIZ_TEXT });

const cloze = (blanks, marks = 6) => ({
  id: "c1", type: "cloze", topic: "Random variables", marks, options: [], correctIndex: -1, modelAnswer: "Work it out.", explanation: "Geometric.",
  prompt: blanks.map((_, i) => `Part ${i + 1}: [${i + 1}]`).join("\n"), blanks,
});

test("typed numbers accept decimals, commas, fractions and percentages", () => {
  assert.equal(parseNumber("0.33"), 0.33);
  assert.equal(parseNumber(" 2,407 "), 2.407);
  assert.equal(parseNumber("1/3"), 1 / 3);
  assert.equal(parseNumber("33%"), 0.33);
  assert.equal(parseNumber("-.5"), -0.5);
  assert.equal(parseNumber("+840"), 840);
  for (const bad of ["", "abc", "1/0", "2^4", "0.3.3"]) assert.equal(parseNumber(bad), null, bad);
});

test("each box is marked on its own, within its tolerance, for an equal share of the marks", () => {
  const q = cloze([
    { kind: "number", answer: 1 / 3, tolerance: 0.005 },
    { kind: "text", answer: "P(7,4)", accept: ["7P4"] },
    { kind: "choice", options: ["C(7,4)", "P(7,4)"], correctIndex: 1 },
  ]);
  assert.ok(blankCorrect(q.blanks[0], "0.33"));
  assert.ok(blankCorrect(q.blanks[0], "1/3"));
  assert.ok(!blankCorrect(q.blanks[0], "0.32"));
  assert.ok(blankCorrect(q.blanks[1], " p(7, 4) "));
  assert.ok(blankCorrect(q.blanks[1], "7p4"));
  assert.ok(!blankCorrect(q.blanks[2], "0"));
  assert.equal(awarded(q, { blanks: ["0.33", "P(7,4)", "1"] }), 6);
  assert.equal(awarded(q, { blanks: ["0.33", "", "0"] }), 2);
  assert.equal(statusOf(q, { blanks: ["0.33", "", "0"] }), "partial");
  assert.equal(statusOf(q, { blanks: ["", "", ""] }), "skipped");
  assert.ok(!hasAnswer(q, undefined));
  // Thirds round to two decimals, as the course site shows a mark.
  assert.equal(awarded(cloze(q.blanks, 4), { blanks: ["0.33", "", ""] }), 1.33);
});

test("a right answer is shown to the precision its margin needs", () => {
  assert.equal(blankAnswerText({ kind: "number", answer: 2 / 9, tolerance: 0.005 }), "0.222 (±0.005)");
  assert.equal(blankAnswerText({ kind: "number", answer: 840, tolerance: 0 }), "840");
  assert.equal(blankAnswerText({ kind: "choice", options: ["a", "b"], correctIndex: 1 }), "b");
});

test("a fill-in prompt splits into its text and its boxes", () => {
  assert.deepEqual(clozeParts("The answer is [2] (2 dp)"), ["The answer is ", { blank: 1 }, " (2 dp)"]);
});

test("the study pack and a retry handle fill-in questions", () => {
  const q = cloze([{ kind: "number", answer: 840, tolerance: 0 }], 2);
  const attempt = {
    id: "a", paperId: "p", title: "Quiz", kind: "exam", createdAt: Date.parse("2026-11-03T10:00:00Z"), seconds: 60,
    questions: [q], answers: { c1: { blanks: ["820"] } }, score: 0, total: 2, percent: 0,
  };
  const pack = studyPackMarkdown(attempt);
  assert.match(pack, /\*\*Your answer:\*\* \[1\] 820/);
  assert.match(pack, /\*\*Correct answer:\*\* \[1\] 840/);
  assert.equal(retryPaper(attempt).kind, "exam");
});

const raw = (over = {}) => ({
  type: "cloze", topic: "Counting", marks: 4, options: [], correctIndex: -1,
  modelAnswer: "7^4 = 2401 and P(7,4) = 840.", explanation: "Counting with and without repeats.",
  prompt: "a) How many numbers? [1]\n\nb) Which formula?\n[2]\n\nThe resulting number is [3]",
  blanks: [
    { kind: "number", answer: "2401", tolerance: 0, options: [], correctIndex: -1 },
    { kind: "choice", answer: "", tolerance: 0, options: ["C(7,4)", "P(7,4)", "7^4"], correctIndex: 1 },
    { kind: "number", answer: "840", tolerance: 500, options: [], correctIndex: -1 },
  ],
  ...over,
});

test("a fill-in question needs one box per marker, in order, with markable answers", () => {
  const blanks = usableBlanks(raw().prompt, raw().blanks, () => 0);
  assert.equal(blanks.length, 3);
  assert.deepEqual(blanks[0], { kind: "number", answer: 2401, tolerance: 0 });
  // A careless tolerance is capped at a tenth of the answer.
  assert.equal(blanks[2].tolerance, 84);
  // The choice is shuffled and its key follows it.
  assert.equal(blanks[1].options[blanks[1].correctIndex], "P(7,4)");

  assert.equal(usableBlanks("Only [1] here", raw().blanks), null, "more boxes than markers");
  assert.equal(usableBlanks("[2] then [1] then [3]", raw().blanks), null, "markers out of order");
  assert.equal(usableBlanks("[1] [2] [3]", [raw().blanks[0], { ...raw().blanks[1], correctIndex: 7 }, raw().blanks[2]]), null, "choice key out of range");
  assert.equal(usableBlanks("[1]", [{ kind: "number", answer: "about 3", tolerance: 0, options: [], correctIndex: -1 }]), null, "not a number");
});

test("fill-in questions are kept for exam papers and exercises, never in an MCQ quiz", () => {
  assert.equal(usableQuestions([raw()], "exam").questions[0].type, "cloze");
  assert.equal(usableQuestions([raw()], "exercise").questions.length, 1);
  assert.equal(usableQuestions([raw()], "mcq").questions.length, 0);
  assert.equal(usableQuestions([raw({ blanks: [] })], "exam").questions.length, 0);
});

test("the paper schema accepts a fill-in question", () => {
  assert.deepEqual(validate({ title: "Quiz-style paper", questions: [raw()] }, PAPER_SCHEMA), []);
});

test("a practice quiz from the course site is always picked, read first and labelled", async () => {
  const quiz = quizFile();
  assert.ok(isPracticeQuizFile(quiz));
  assert.ok(!isPracticeQuizFile({ path: "x/Past Papers/2024 exam.md" }));
  assert.ok(autoPick([quiz]).has(QUIZ_PATH));
  const notes = { path: "a/Lectures/notes.md", name: "notes.md", ext: "md", category: "Source materials", text: "Notes on probability." };
  const block = await readSources([notes, quiz]);
  assert.equal(block.practiceQuizzes, 1);
  assert.equal(block.pastPapers, 0);
  assert.ok(block.text.indexOf("### PRACTICE QUIZ: Probability demo quiz.md") < block.text.indexOf("notes.md"));
});

test("with a practice quiz the prompt asks to copy its format; without one, no boxes", () => {
  const withQuiz = buildPaperPrompt({ kind: "exam", count: 6, brief: "", module: "ECS509U", pastPapers: 0, practiceQuizzes: 1 });
  assert.match(withQuiz, /Copy exactly how that quiz asks/);
  assert.match(withQuiz, /"type": "cloze"/);
  const mcq = buildPaperPrompt({ kind: "mcq", count: 10, brief: "", module: "ECS509U", pastPapers: 0, practiceQuizzes: 1 });
  assert.match(mcq, /asked the way the quiz's multiple-choice parts ask/);
  assert.doesNotMatch(mcq, /"type": "cloze"/);
  const plain = buildPaperPrompt({ kind: "exam", count: 6, brief: "", module: "ECS509U", pastPapers: 1 });
  assert.doesNotMatch(plain, /PRACTICE QUIZ/);
  assert.match(plain, /Every question has "blanks": \[\]/);
});

test("a paper written from a practice quiz keeps its fill-in questions end to end", async () => {
  let asked;
  const client = {
    async generate(request) {
      asked = request;
      const questions = ["numbers", "codes", "plates"].map((word) => raw({ prompt: raw().prompt.replace("numbers", word) }));
      return { data: { title: "Probability quiz practice", questions } };
    },
  };
  const { paper } = await generatePaper({ client, kind: "exam", count: 6, brief: "", module: "ECS509U", sources: [quizFile()], random: () => 0 });
  assert.match(asked.system, /PRACTICE QUIZ files are the module's own online quiz/);
  assert.equal(paper.questions.length, 3);
  assert.ok(paper.questions.every((q) => q.type === "cloze" && q.blanks.length === 3));
});
