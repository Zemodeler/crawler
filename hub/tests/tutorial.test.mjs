import assert from "node:assert/strict";
import test from "node:test";

import {
  addableFiles,
  importLegacyProgress,
  lectureFor,
  packsFor,
  pairFor,
  pairSheets,
  parseTutorialFile,
  setupRows,
  sheetLabel,
  sheetNumber,
  splitMath,
  splitPages,
  tally,
  upsertSheet,
  verifyRef,
  withExplanation,
} from "../lib/tutorial.ts";

const f = (path) => ({ path, name: path.split("/").pop() });

// File names exactly as QMplus delivered them for ECS509U in 2026-27.
const LAB = "Course Materials/Labs and Seminars/";
const LEC = "Course Materials/Lectures/";
const ECS509U = [
  "ecs509u-exercise1-solution.pdf", "ecs509u-exercise1.docx",
  "ecs509u-exercise2A-solution.pdf", "ecs509u-exercise2A.docx",
  "ecs509u-exercise2B-solution.pdf", "ecs509u-exercise2B.docx",
  "ecs509u-exercise4-part A-solutions.pdf", "ecs509u-exercise4-part A.docx",
  "ecs509u-exercise5-part A-2026.docx", "ecs509u-exercise5-part A-solution-2026.pdf",
  "ecs509u-exercise6-part A - solutions-2026.pdf", "ecs509u-exercise6-part A -2026.docx",
  "ecs509u-extra exercises - probabilities.pdf",
].map((n) => f(LAB + n)).concat(
  [
    "01 - ecs509u-Lecture1-core slides.pdf", "02 - ecs509u-Lecture1.pdf",
    "04 - ecs509u-Lecture2.pdf",
    "07 - ecs509u-week4-core slides.pdf", "08 - ecs509u-week4-lecture slides-complete.pdf",
    "09 - ecs509u-week5-core slides.pdf", "14 - ecs509u-week5-lecture slides-core-2026.pdf",
    "10 - mh-ecs509u-week6-handouts.pdf", "11 - ecs509u-week6-handouts.pdf", "16 - ecs509u-week6-complete-2026.pdf",
    "20 - ECS509U end-term test location V2102.pdf",
    "19 - Summary page with probability formulas files/Probability formulas.pdf",
  ].map((n) => f(LEC + n)),
).concat(
  // Study Hub's own files in the module, which must never be taken for tutorial sheets.
  ["Revision/Guides/04 - Model Worked Problems.md", "Revision/Guides/00 - Problem-Solving Technique + Method Map.md", "0 - START HERE.md"].map(f),
);

test("sheet numbers come from exercise names, with or without 'part'", () => {
  assert.deepEqual(sheetNumber("ecs509u-exercise2A-solution.pdf"), { week: 2, part: "A" });
  assert.deepEqual(sheetNumber("ecs509u-exercise4-part B-solutions.pdf"), { week: 4, part: "B" });
  assert.deepEqual(sheetNumber("ecs509u-exercise1.docx"), { week: 1, part: "" });
  assert.deepEqual(sheetNumber("Tutorial 3 answers.pdf"), { week: 3, part: "" });
  assert.deepEqual(sheetNumber("Random notes.pdf"), { week: null, part: "" });
});

test("pairs every solution with its sheet and the week's most complete lecture deck", () => {
  const pairs = pairSheets(ECS509U);
  assert.deepEqual(pairs.map((p) => p.label), ["Week 1", "Week 2A", "Week 2B", "Week 4A", "Week 5A", "Week 6A", "Extra exercises – probabilities"]);
  const byLabel = Object.fromEntries(pairs.map((p) => [p.label, p]));
  assert.equal(byLabel["Week 1"].sheetPath, LAB + "ecs509u-exercise1.docx");
  assert.equal(byLabel["Week 1"].lecturePath, LEC + "02 - ecs509u-Lecture1.pdf");
  assert.equal(byLabel["Week 4A"].sheetPath, LAB + "ecs509u-exercise4-part A.docx");
  assert.equal(byLabel["Week 4A"].lecturePath, LEC + "08 - ecs509u-week4-lecture slides-complete.pdf");
  assert.equal(byLabel["Week 5A"].sheetPath, LAB + "ecs509u-exercise5-part A-2026.docx");
  assert.equal(byLabel["Week 5A"].lecturePath, LEC + "14 - ecs509u-week5-lecture slides-core-2026.pdf");
  assert.equal(byLabel["Week 6A"].sheetPath, LAB + "ecs509u-exercise6-part A -2026.docx");
  assert.equal(byLabel["Week 6A"].lecturePath, LEC + "16 - ecs509u-week6-complete-2026.pdf");
  // Ids are stable, so re-converting replaces rather than duplicates.
  assert.equal(pairSheets(ECS509U)[0].id, pairs[0].id);
  assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length);
});

test("an extra exercise set with its answers inside is a sheet of its own", () => {
  const extra = pairSheets(ECS509U).find((p) => p.label === "Extra exercises – probabilities");
  assert.ok(extra);
  assert.equal(extra.solutionPath, LAB + "ecs509u-extra exercises - probabilities.pdf");
  assert.equal(extra.sheetPath, undefined);
  assert.equal(extra.week, null);
  assert.equal(extra.lecturePath, undefined);
  assert.equal(extra.id, "s-ecs509uextraexercisesprobabilities");
});

test("an extra exercise set with a separate solutions file is paired with it", () => {
  const files = [f(LAB + "Additional problems.pdf"), f(LAB + "Additional problems - solutions.pdf")];
  const pairs = pairSheets(files);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].label, "Additional problems");
  assert.equal(pairs[0].sheetPath, LAB + "Additional problems.pdf");
  assert.equal(pairs[0].solutionPath, LAB + "Additional problems - solutions.pdf");
});

test("Study Hub's own revision guides are never listed as sheets", () => {
  assert.ok(!pairSheets(ECS509U).some((p) => /Model Worked Problems|Revision\//.test(p.solutionPath)));
});

test("sheet labels drop the module code and solution words", () => {
  assert.equal(sheetLabel("ecs509u-extra exercises - probabilities.pdf"), "Extra exercises – probabilities");
  assert.equal(sheetLabel("ECS509U_practice_questions_solutions.pdf"), "Practice questions");
  assert.equal(sheetLabel("Mock test.docx"), "Mock test");
});

test("files added by hand get a row, and converted ones come back as rows", () => {
  const found = pairSheets(ECS509U);
  const mock = f(LAB + "Mock test answers.pdf");
  const files = [...ECS509U, mock];
  const addable = addableFiles(files, found);
  assert.ok(addable.some((x) => x.path === mock.path));
  assert.ok(!addable.some((x) => x.path === found[0].solutionPath || x.path === found[0].sheetPath));
  // Model Worked Problems is not found by name but can still be added by hand.
  assert.ok(addable.some((x) => x.name === "04 - Model Worked Problems.md"));

  const hand = pairFor(f(LAB + "Mock test answers.pdf"), files);
  assert.equal(hand.label, "Mock test");
  const rows = setupRows(found, [], [hand], files);
  assert.equal(rows.length, found.length + 1);
  assert.equal(rows.at(-1).id, hand.id);
  // Adding a row already found by name does not duplicate it.
  assert.equal(setupRows(found, [], [found[0]], files).length, found.length);

  const sheet = { ...hand, title: "", convertedAt: 1, exercises: [] };
  const back = setupRows(found, [sheet], [], files);
  assert.equal(back.length, found.length + 1);
  // A converted sheet whose file has gone is not listed.
  assert.equal(setupRows(found, [sheet], [], ECS509U).length, found.length);
});

test("no lecture is guessed for a week that has none", () => {
  assert.equal(lectureFor(3, ECS509U), undefined);
  assert.equal(lectureFor(null, ECS509U), undefined);
});

test("splitPages follows the extractor's page markers", () => {
  const pages = splitPages("--- Page 1 ---\nIntro\n\n--- Page 2 ---\nBayes theorem\n\n--- Page 4 ---\nInverse matrices");
  assert.deepEqual(pages, ["Intro", "Bayes theorem", "", "Inverse matrices"]);
});

test("a slide link must exist and mention its label on or next to the page", () => {
  const pages = ["Welcome", "Kolmogorov's axioms: P(S) = 1", "Consequences", "Matrix inverses"];
  assert.equal(verifyRef({ page: 2, label: "Kolmogorov’s axioms" }, pages), true);
  assert.equal(verifyRef({ page: 3, label: "Axioms" }, pages), true, "the neighbouring page counts");
  assert.equal(verifyRef({ page: 9, label: "Axioms" }, pages), false);
  assert.equal(verifyRef({ page: 1, label: "Determinants of 3x3" }, pages), false);
  assert.equal(verifyRef({ page: 4, label: "Inverses" }, pages), true, "plural and singular match");
});

test("study packs are matched by shared topic words", () => {
  const packs = [f("Revision/Study pack - Bayes theorem.md"), f("Revision/Study pack - Matrix inverses.md"), f("Revision/Study pack - Counting.md")];
  assert.deepEqual(packsFor({ topic: "Bayes' theorem", title: "Faulty components" }, packs).map((p) => p.name), ["Study pack - Bayes theorem.md"]);
  assert.deepEqual(packsFor({ topic: "Inverses", title: "Find the inverse matrix" }, packs).map((p) => p.name), ["Study pack - Matrix inverses.md"]);
  assert.deepEqual(packsFor({ topic: "Random variables", title: "Expected value" }, packs), []);
});

test("matrix tokens split out of text and malformed ones stay text", () => {
  assert.deepEqual(splitMath("A = [[5 3; 4 -2]] so"), ["A = ", { matrix: [["5", "3"], ["4", "−2"]] }, " so"]);
  assert.deepEqual(splitMath("x [[1 2; 3]] y"), ["x [[1 2; 3]] y"]);
  assert.deepEqual(splitMath("[[1/3, -1/3]]"), [{ matrix: [["1/3", "−1/3"]] }]);
});

const sheet = (id, week, part, exercises) => ({
  id, label: `Week ${week}${part}`, week, part, title: "t", solutionPath: `${id}.pdf`, convertedAt: 0,
  exercises: exercises.map((n) => ({
    id: String(n), number: String(n), title: `Ex ${n}`, topic: "Topic", stem: "", basics: "",
    parts: [{ label: "a", question: "q", final: "f", working: "w" }], refs: [],
  })),
});

test("upserting keeps sheets in week order and replaces by id", () => {
  let file = { version: 1, sheets: [] };
  file = upsertSheet(file, sheet("b", 2, "A", [1]));
  file = upsertSheet(file, sheet("a", 1, "", [1, 2]));
  file = upsertSheet(file, sheet("b", 2, "A", [1, 2, 3]));
  assert.deepEqual(file.sheets.map((s) => [s.id, s.exercises.length]), [["a", 2], ["b", 3]]);
  const explained = withExplanation(file, "b", "2", 0, "Step 1…");
  assert.equal(explained.sheets[1].exercises[1].parts[0].explain, "Step 1…");
  assert.equal(file.sheets[1].exercises[1].parts[0].explain, undefined, "the original is not changed");
});

test("a damaged tutorial file reads as empty", () => {
  assert.deepEqual(parseTutorialFile(null).sheets, []);
  assert.deepEqual(parseTutorialFile({ version: 2, sheets: [] }).sheets, []);
  assert.equal(parseTutorialFile({ version: 1, sheets: [sheet("a", 1, "", [1]), { nope: true }] }).sheets.length, 1);
});

test("progress from the stand-alone practice page is imported by week, part and number", () => {
  const sheets = [sheet("w1", 1, "", [1, 2]), sheet("w6a", 6, "A", [1])];
  const backup = {
    "ecs509u:marks": JSON.stringify({ "1-1": "ok", "6A-1": "no", "9-9": "ok" }),
    "ecs509u:notes:6A-1": JSON.stringify("det = -18"),
    "ecs509u:cur": "3",
  };
  const { progress, matched } = importLegacyProgress(backup, sheets, { marks: {}, notes: {} });
  assert.equal(matched, 2);
  assert.deepEqual(progress.marks, { "w1/1": "right", "w6a/1": "wrong" });
  assert.deepEqual(progress.notes, { "w6a/1": "det = -18" });
  assert.deepEqual(tally(sheets, progress), { total: 3, right: 1, partly: 0, wrong: 1, done: 2 });
});
