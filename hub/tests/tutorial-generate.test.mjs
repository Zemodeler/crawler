import assert from "node:assert/strict";
import test from "node:test";

import { SHEET_SCHEMA, EXPLAIN_SCHEMA, capOnPage, convertSheet, explainPart, splitExercises } from "../lib/tutorial-generate.ts";
import { assertProviderPortable, validate } from "../lib/ai/schema.ts";

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
const file = (path, text, category = "Course materials") => ({
  path, name: path.split("/").pop(), ext: path.split(".").pop(), category, topic: "", text,
  file: { name: path, size: text.length, text: async () => text },
});

const LEC = "Course Materials/Lectures/week3-lecture-complete.pdf";
const SOL = "Course Materials/Labs/ecs509u-exercise3-solution.pdf";
const SHEET = "Course Materials/Labs/ecs509u-exercise3.docx";
const lecture = [
  "--- Page 1 ---\nWeek 3: Matrices",
  "--- Page 2 ---\nMatrix multiplication: rows times columns",
  "--- Page 3 ---\nThe inverse of a 2x2 matrix: swap, negate, divide by the determinant",
  "--- Page 4 ---\nConditional probability and Bayes theorem",
].join("\n");
const pair = { id: "s-ecs509uexercise3", label: "Week 3", week: 3, part: "", sheetPath: SHEET, solutionPath: SOL, lecturePath: LEC };
const files = [
  file(SOL, "--- Page 1 ---\nExercise 1. Find the inverse of [5 3; 4 2]. Answer: ..."),
  file(SHEET, "Exercise 1. Find the inverse."),
  file(LEC, lecture),
];

const part = (over = {}) => ({ label: "a", question: "Find A⁻¹.", final: "[[-1 1.5; 2 -2.5]]", working: "1. Swap the diagonal.\n2. Divide by det = -2.", note: "", ...over });
const exercise = (over = {}) => ({
  number: "1", title: "Inverse of a matrix", topic: "Matrix inverse", stem: "Let A = [[5 3; 4 2]].", hint: "",
  basics: "- The inverse undoes the matrix (slide 3).", parts: [part()], refs: [], ...over,
});

test("the sheet schema accepts a good sample and is provider-portable", () => {
  const sample = {
    title: "Matrices",
    exercises: [exercise({ hint: "Start with the determinant.", refs: [{ page: 3, label: "Inverse of a 2x2 matrix", same: true }] })],
  };
  assert.deepEqual(validate(sample, SHEET_SCHEMA), []);
  assert.ok(validate({ title: "Matrices", exercises: [exercise({ extra: 1 })] }, SHEET_SCHEMA).length > 0);
  assertProviderPortable(SHEET_SCHEMA, "tutorial_sheet");
  assertProviderPortable(EXPLAIN_SCHEMA, "explanation");
  assert.deepEqual(validate({ explanation: "Swap the diagonal." }, EXPLAIN_SCHEMA), []);
});

test("convertSheet keeps only slide links whose page exists and matches, and counts the rest", async () => {
  const client = fakeClient({
    title: "Matrices",
    exercises: [
      exercise({
        refs: [
          { page: 3, label: "Inverse of a 2x2 matrix", same: true },
          { page: 3, label: "Inverse again", same: false }, // duplicate page
          { page: 40, label: "Inverse", same: false }, // no such page
          { page: 4, label: "Bayes theorem", same: false }, // a different page that matches
        ],
      }),
      exercise({ number: "2", title: "Bayes", topic: "Unrelated topic", refs: [{ page: 1, label: "Eigenvalues", same: false }] }),
    ],
  });
  const { sheet, dropped, droppedRefs, unread } = await convertSheet({ client, module: "ECS509U", pair, files });
  assert.equal(dropped, 0);
  assert.deepEqual(unread, []);
  const [first, second] = sheet.exercises;
  assert.deepEqual(first.refs.map((r) => r.page), [3, 4]);
  assert.deepEqual(first.refs[0], { path: LEC, page: 3, label: "Inverse of a 2x2 matrix", same: true });
  assert.equal(first.refs[1].same, undefined);
  assert.deepEqual(second.refs, []);
  assert.equal(droppedRefs, 3);
  assert.equal(first.hint, undefined, "an empty hint is omitted");
  assert.equal(first.parts[0].note, undefined, "an empty note is omitted");
  assert.equal(sheet.id, pair.id);
  assert.equal(sheet.lecturePath, LEC);
  assert.equal(sheet.sheetPath, SHEET);
  assert.equal(sheet.solutionPath, SOL);
  assert.equal(sheet.title, "Matrices");
  assert.equal(typeof sheet.convertedAt, "number");
});

test("convertSheet makes ids unique and drops exercises without parts or answers", async () => {
  const client = fakeClient({
    title: "Sheet",
    exercises: [
      exercise({ number: "1" }),
      exercise({ number: "1" }),
      exercise({ number: "Extra 1" }),
      exercise({ number: "3", parts: [] }),
      exercise({ number: "4", parts: [part(), part({ question: "" })] }),
      exercise({ number: "5", parts: [part({ final: "", working: " " })] }),
      exercise({ number: "6", parts: [part({ final: "", note: "The official sheet gives 3; it should be 4." })] }),
    ],
  });
  const { sheet, dropped } = await convertSheet({ client, module: "M", pair, files });
  assert.deepEqual(sheet.exercises.map((e) => e.id), ["1", "1-2", "extra-1", "6"]);
  assert.equal(dropped, 3);
  assert.match(sheet.exercises[3].parts[0].note, /^The official sheet gives/);
});

test("convertSheet fails clearly when the solutions have no text, or nothing usable comes back", async () => {
  await assert.rejects(
    convertSheet({ client: fakeClient({ title: "x", exercises: [exercise()] }), module: "M", pair, files: [file(SOL, "   "), files[1], files[2]] }),
    (error) => error.name === "AiError" && /Could not read/.test(error.message) && Boolean(error.hint),
  );
  await assert.rejects(
    convertSheet({ client: fakeClient({ title: "x", exercises: [exercise({ parts: [] })] }), module: "M", pair, files }),
    /usable exercise/,
  );
});

test("convertSheet fences every file and the prompt carries the rules", async () => {
  const client = fakeClient({ title: "x", exercises: [exercise()] });
  const { unread } = await convertSheet({ client, module: "ECS509U", pair, files: [files[0], file(SHEET, ""), files[2]] });
  assert.deepEqual(unread, [SHEET]);
  const request = client.seen[0];
  assert.match(request.system, /<untrusted_course_content>/);
  assert.match(request.system, /\[\[5 3; 4 2\]\]/);
  assert.match(request.system, /TRANSCRIPTION/);
  assert.match(request.system, /The official sheet gives/);
  assert.match(request.system, /No LaTeX/);
  assert.equal(request.effort, "medium");
  assert.equal(request.maxOutputTokens, 16_000);
  const content = request.messages[0].content;
  assert.match(content, /### SOLUTIONS: ecs509u-exercise3-solution\.pdf\n\n<untrusted_course_content source="Course Materials\/Labs\/ecs509u-exercise3-solution\.pdf">/);
  assert.match(content, /### LECTURE: week3-lecture-complete\.pdf/);
  assert.doesNotMatch(content, /QUESTION SHEET/, "an empty sheet is not shown");
});

test("convertSheet without a lecture asks for no refs and keeps none", async () => {
  const client = fakeClient({ title: "x", exercises: [exercise({ refs: [{ page: 3, label: "Inverse", same: false }] })] });
  const noLecture = { ...pair, lecturePath: undefined };
  const { sheet, droppedRefs } = await convertSheet({ client, module: "M", pair: noLecture, files });
  assert.deepEqual(sheet.exercises[0].refs, []);
  assert.equal(droppedRefs, 1);
  assert.equal("lecturePath" in sheet, false);
  assert.match(client.seen[0].system, /always an empty list/);
});

test("capOnPage cuts long lectures on a page boundary", () => {
  const text = ["--- Page 1 ---", "a".repeat(50), "--- Page 2 ---", "b".repeat(50)].join("\n");
  assert.equal(capOnPage(text, 1000), text);
  const cut = capOnPage(text, 90);
  assert.ok(cut.endsWith("a".repeat(50)));
  assert.doesNotMatch(cut, /Page 2/);
  assert.equal(capOnPage("x".repeat(100), 10), "x".repeat(10));
});

test("explainPart grounds the explanation in the referenced slides and the matching study pack", async () => {
  const client = fakeClient({ explanation: "  The inverse undoes A. See slide 3 of week3-lecture-complete.pdf.  " });
  const sheet = { id: pair.id, label: "Week 3", week: 3, part: "", title: "Matrices", solutionPath: SOL, lecturePath: LEC, convertedAt: 1, exercises: [] };
  const ex = {
    id: "1", number: "1", title: "Inverse of a matrix", topic: "Matrix inverse", stem: "Let A = [[5 3; 4 2]].", basics: "",
    parts: [part({ note: "The official sheet gives 1.4; it should be 1.5." })],
    refs: [{ path: LEC, page: 3, label: "Inverse of a 2x2 matrix" }],
  };
  const all = [
    ...files,
    file("Notes/03 - Matrix Inverse (Topic Pack).md", "# Matrix inverse\nSwap, negate, divide by det.", "Study packs"),
    file("Notes/07 - Hypothesis tests (Topic Pack).md", "# Hypothesis tests\nNull and alternative.", "Study packs"),
    file("Course Materials/Formula sheet.pdf", "--- Page 1 ---\nFormula: det = ad - bc"),
  ];
  const explanation = await explainPart({ client, module: "ECS509U", sheet, exercise: ex, part: ex.parts[0], files: all });
  assert.equal(explanation, "The inverse undoes A. See slide 3 of week3-lecture-complete.pdf.");
  const request = client.seen[0];
  const content = request.messages[0].content;
  assert.match(content, /slide 3 of week3-lecture-complete\.pdf:\nThe inverse of a 2x2 matrix/);
  assert.match(content, /slide 2 of week3-lecture-complete\.pdf/, "the neighbouring page is included");
  assert.match(content, /### STUDY PACK: 03 - Matrix Inverse \(Topic Pack\)/);
  assert.match(content, /Swap, negate, divide by det\./);
  assert.doesNotMatch(content, /Hypothesis tests/);
  assert.match(content, /### FORMULA SHEET: Formula sheet\.pdf/);
  assert.match(content, /Find A⁻¹\./);
  assert.match(content, /The official sheet gives 1\.4/);
  assert.match(content, /<untrusted_course_content/);
  assert.match(request.system, /patient tutor/);
  assert.match(request.system, /\[\[5 3; 4 2\]\]/);
  assert.equal(request.effort, "medium");
});

test("explainPart fails clearly on an empty explanation", async () => {
  const sheet = { id: "s", label: "W", week: null, part: "", title: "", solutionPath: SOL, convertedAt: 1, exercises: [] };
  const ex = { id: "1", number: "1", title: "T", topic: "T", stem: "", basics: "", parts: [part()], refs: [] };
  await assert.rejects(
    explainPart({ client: fakeClient({ explanation: "  " }), module: "M", sheet, exercise: ex, part: ex.parts[0], files: [] }),
    /did not return an explanation/,
  );
});

/* ---------------------------------------------------------------- batching */

// The shape of pdftotext on "ecs509u-extra exercises - probabilities.pdf":
// a header, then "Exercise N." lines, each followed by the question and its answer.
const extraSheet = (n, body = 1500) =>
  [
    "Name: ECS509U: Probability and Matrices",
    "Extra probability exercises",
    "Student number:",
    "Probability laws",
    ...Array.from({ length: n }, (_, i) =>
      [`Exercise ${i + 1}.`, `We roll two dice, question ${i + 1}. What is the probability?`, `Answer ${i + 1}: `.padEnd(body, "x")].join("\n"),
    ),
  ].join("\n");

test("splitExercises splits at line-start headings and keeps the header with the first piece", () => {
  const pieces = splitExercises(extraSheet(11, 40));
  assert.deepEqual(pieces.map((p) => p.number), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.match(pieces[0].text, /^Name: ECS509U/);
  assert.match(pieces[0].text, /Exercise 1\.\nWe roll two dice, question 1\./);
  assert.match(pieces[10].text, /^Exercise 11\./);
  assert.doesNotMatch(pieces[1].text, /question 3/);

  const mixed = splitExercises("Intro\nQuestion 2 What?\nsee exercise 9 below\nproblem 4\nx\nTASK 1. y\nExtra 1\nz\nExercise\nno number");
  assert.deepEqual(mixed.map((p) => p.number), ["2", "4", "1", "Extra 1"]);
  assert.match(mixed[0].text, /^Intro\nQuestion 2 What\?\nsee exercise 9 below$/);
  assert.match(mixed[3].text, /Exercise\nno number$/);

  // pdftotext puts a form feed before a page's first line.
  assert.deepEqual(splitExercises("Exercise 1.\nQ\n\fExercise 2.\nQ").map((p) => p.number), ["1", "2"]);

  // Study Hub's PDF reader puts each page on one line: a heading inside a line counts
  // when it ends in "." and is the next number, so a back-reference does not split.
  const collapsed = "--- Page 1 ---\nName: ECS509U Probability laws Exercise 1. We roll two dice. Answer 35/36. Exercise 2. Spam filters, as in Exercise 1. again. Answer 1/2\n\n--- Page 2 ---\nExercise 3. A student... see exercise 2 above. Answer 8/10 Counting Exercise 4: A class of 14.";
  const flat = splitExercises(collapsed);
  assert.deepEqual(flat.map((p) => p.number), ["1", "2", "3", "4"]);
  assert.match(flat[0].text, /^--- Page 1 ---\nName: ECS509U Probability laws Exercise 1\. We roll two dice\. Answer 35\/36\.$/);
  assert.match(flat[1].text, /as in Exercise 1\. again\. Answer 1\/2\n\n--- Page 2 ---$/);
  assert.match(flat[2].text, /see exercise 2 above\. Answer 8\/10 Counting$/);

  assert.deepEqual(splitExercises("Exercise 1. only one heading"), []);
  assert.deepEqual(splitExercises("no headings at all"), []);
  // Questions first, answers after: the answer joins its question.
  const twice = splitExercises("Exercise 1. Q1\nExercise 2. Q2\nSolutions\nExercise 1. A1\nExercise 2. A2");
  assert.deepEqual(twice.map((p) => p.number), ["1", "2"]);
  assert.match(twice[0].text, /Q1[\s\S]*A1/);
});

/** A client answering each batch with the exercises its message asks for; `fail` makes that call throw. */
function batchClient({ fail } = {}) {
  const seen = [];
  return {
    seen,
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async generate(request) {
      seen.push(request);
      request.onProgress?.({ phase: "connecting" });
      if (fail === seen.length) throw new Error("timed out");
      const m = request.messages[0].content.match(/Convert ONLY exercises? (\d+)(?:–(\d+))?/);
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      const exercises = [];
      for (let n = from; n <= to; n++) exercises.push(exercise({ number: String(n), title: `Exercise ${n}` }));
      return { data: { title: "Extra probability", exercises }, raw: "", usage: {}, costUsd: null, model: "fake", transport: "apikey", repaired: false };
    },
  };
}
const EXTRA = "Course Materials/Labs and Seminars/ecs509u-extra exercises - probabilities.pdf";
const extraPair = { id: "s-extra", label: "Extra exercises", week: null, part: "", solutionPath: EXTRA, lecturePath: LEC };
const extraFiles = (n, body) => [file(EXTRA, extraSheet(n, body)), file(LEC, lecture)];

test("a long sheet is converted in batches of about four exercises, each naming its range", async () => {
  const client = batchClient();
  const progress = [];
  const partials = [];
  const { sheet, dropped } = await convertSheet({
    client, module: "ECS509U", pair: extraPair, files: extraFiles(11, 1500),
    onProgress: (p) => progress.push(p),
    onBatch: (s, state) => partials.push({ s: structuredClone(s), state }),
  });
  assert.equal(client.seen.length, 3);
  const contents = client.seen.map((r) => r.messages[0].content);
  assert.match(contents[0], /This is part 1 of 3 of the sheet\. Convert ONLY exercises 1–4 below; other parts are converted separately\./);
  assert.match(contents[1], /part 2 of 3 .*exercises 5–8/);
  assert.match(contents[2], /part 3 of 3 .*exercises 9–11/);
  assert.match(contents[1], /Exercise 5\./);
  assert.doesNotMatch(contents[1], /Exercise 4\.|Exercise 9\./, "only that batch's solutions are sent");
  for (const c of contents) assert.match(c, /### LECTURE: week3-lecture-complete\.pdf[\s\S]*Bayes theorem/, "the lecture goes with every batch");
  for (const r of client.seen) assert.equal(r.maxOutputTokens, 8_000);
  assert.equal(client.seen[0].system, client.seen[2].system);

  assert.deepEqual(progress.map((p) => p.batch), [{ index: 1, total: 3 }, { index: 2, total: 3 }, { index: 3, total: 3 }]);
  assert.deepEqual(partials.map((p) => p.state), [
    { batch: 1, batches: 3, exercises: 4 },
    { batch: 2, batches: 3, exercises: 8 },
    { batch: 3, batches: 3, exercises: 11 },
  ]);
  assert.deepEqual(partials[0].s.pending, { done: 1, total: 3 });
  assert.deepEqual(partials[1].s.pending, { done: 2, total: 3 });
  assert.equal("pending" in partials[2].s, false);
  assert.equal("pending" in sheet, false);
  assert.deepEqual(sheet.exercises.map((e) => e.number), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(new Set(sheet.exercises.map((e) => e.id)).size, 11);
  assert.equal(sheet.title, "Extra probability");
  assert.equal(dropped, 0);
});

test("batches are also capped by solutions text, and short sheets keep one call", async () => {
  const client = batchClient();
  await convertSheet({ client, module: "M", pair: extraPair, files: extraFiles(5, 3000) });
  assert.equal(client.seen.length, 3, "two 3,000-character exercises per batch at most");
  assert.match(client.seen[2].messages[0].content, /Convert ONLY exercise 5 below/);

  const small = fakeClient({ title: "x", exercises: [exercise(), exercise({ number: "2" })] });
  const { sheet } = await convertSheet({ client: small, module: "M", pair: extraPair, files: extraFiles(5, 200), onBatch: () => assert.fail("no batches") });
  assert.equal(small.seen.length, 1);
  assert.equal(small.seen[0].maxOutputTokens, 16_000);
  assert.doesNotMatch(small.seen[0].messages[0].content, /part 1 of/);
  assert.equal("pending" in sheet, false);
});

test("a long sheet sends the matching slice of the question sheet, or the whole sheet when numbers do not match", async () => {
  const QS = "Course Materials/Labs and Seminars/extra questions.docx";
  const questions = Array.from({ length: 8 }, (_, i) => `Exercise ${i + 1}. Set question ${i + 1}`).join("\n");
  const client = batchClient();
  await convertSheet({ client, module: "M", pair: { ...extraPair, sheetPath: QS }, files: [...extraFiles(8, 500), file(QS, questions)] });
  assert.match(client.seen[1].messages[0].content, /### QUESTION SHEET[\s\S]*Set question 5[\s\S]*Set question 8/);
  assert.doesNotMatch(client.seen[1].messages[0].content, /Set question 4\b/);

  const other = batchClient();
  await convertSheet({ client: other, module: "M", pair: { ...extraPair, sheetPath: QS }, files: [...extraFiles(8, 500), file(QS, "Question A\nQuestion B")] });
  assert.match(other.seen[1].messages[0].content, /### QUESTION SHEET[\s\S]*Question A\nQuestion B/);
});

test("a failing middle batch throws but earlier batches were delivered, and resume skips them", async () => {
  const partials = [];
  await assert.rejects(
    convertSheet({ client: batchClient({ fail: 2 }), module: "M", pair: extraPair, files: extraFiles(11, 1500), onBatch: (s) => partials.push(s) }),
    /timed out/,
  );
  assert.equal(partials.length, 1);
  const saved = partials[0];
  assert.deepEqual(saved.pending, { done: 1, total: 3 });
  assert.deepEqual(saved.exercises.map((e) => e.number), ["1", "2", "3", "4"]);

  const client = batchClient();
  const states = [];
  const { sheet } = await convertSheet({
    client, module: "M", pair: extraPair, files: extraFiles(11, 1500), resume: saved,
    onBatch: (s, state) => states.push({ state, pending: s.pending }),
  });
  assert.equal(client.seen.length, 2, "the finished batch is not converted again");
  assert.match(client.seen[0].messages[0].content, /part 2 of 3 .*exercises 5–8/);
  assert.deepEqual(states, [
    { state: { batch: 2, batches: 3, exercises: 8 }, pending: { done: 2, total: 3 } },
    { state: { batch: 3, batches: 3, exercises: 11 }, pending: undefined },
  ]);
  assert.deepEqual(sheet.exercises.map((e) => e.number), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.deepEqual(sheet.exercises.slice(0, 4), saved.exercises);
});

test("batched ids stay unique across batches and dropped counts add up", async () => {
  let call = 0;
  const seen = [];
  const client = {
    target: { provider: "anthropic", transport: "apikey", model: "fake" },
    async generate(request) {
      seen.push(request);
      call++;
      const exercises = call === 1
        ? [exercise({ number: "1" }), exercise({ number: "2", parts: [] })]
        : [exercise({ number: "1" }), exercise({ number: "3", refs: [{ page: 40, label: "x", same: false }] })];
      return { data: { title: "T", exercises }, raw: "", usage: {}, costUsd: null, model: "fake", transport: "apikey", repaired: false };
    },
  };
  const { sheet, dropped, droppedRefs } = await convertSheet({ client, module: "M", pair: extraPair, files: extraFiles(6, 100) });
  assert.equal(seen.length, 2);
  assert.deepEqual(sheet.exercises.map((e) => e.id), ["1", "1-2", "3"]);
  assert.equal(dropped, 1);
  assert.equal(droppedRefs, 1);
});
