import assert from "node:assert/strict";
import test from "node:test";

import { SHEET_SCHEMA, EXPLAIN_SCHEMA, capOnPage, convertSheet, explainPart } from "../lib/tutorial-generate.ts";
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
