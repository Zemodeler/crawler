import assert from "node:assert/strict";
import { test } from "node:test";

import { categorize, isVideo, planFiles } from "../src/sorter.ts";
import type { Category, ModulePlacement, VleFile, VleItem } from "../src/types.ts";

const placement: ModulePlacement = {
  code: "ECS505U",
  title: "Software Engineering",
  folder: "ECS505U - Software Engineering",
  year: "2026-27",
  isModule: true,
};
const BASE = "2026-27/ECS505U - Software Engineering/Course Materials";

const vleFile = (filename: string, filepath = "/", mimetype: string | null = null): VleFile => ({
  filename,
  filepath,
  url: `https://qmplus.example/pluginfile.php/1${filepath}${filename}`,
  size: 1000,
  mimetype,
  modified: null,
});

let nextId = 1000;
const fileItem = (
  filename: string,
  activity: string,
  section: string,
  options: { sectionIndex?: number; activityType?: string; activityId?: number; filepath?: string; mimetype?: string } = {},
): VleItem => ({
  kind: "file",
  file: vleFile(filename, options.filepath, options.mimetype ?? null),
  section,
  sectionIndex: options.sectionIndex ?? 0,
  activity,
  activityType: options.activityType ?? "resource",
  activityId: options.activityId ?? nextId++,
  activityUrl: "https://qmplus.example/mod/resource/view.php?id=1",
});

const assignment = (activityId: number, title: string, briefFiles: VleFile[]): VleItem => ({
  kind: "assignment",
  id: activityId + 1,
  activityId,
  title,
  due: null,
  cutoff: null,
  introHtml: "",
  briefFiles,
  url: `https://qmplus.example/mod/assign/view.php?id=${activityId}`,
  modified: null,
});

test("rule 0: files on an assignment are Assessment Guidance", () => {
  assert.deepEqual(categorize({ filename: "Level 5 - Task 3.docx", activity: "Lecture slides", activityType: "assign", section: "Week 1" }), {
    category: "Assessment Guidance",
    reason: 'activityType:"assign"',
  });
});

test("file name beats activity name beats section name", () => {
  assert.deepEqual(categorize({ filename: "Lab4_exercise_v23.pdf", activity: "Week 4 lecture slides", section: "Week 4" }), {
    category: "Labs and Seminars",
    reason: 'file:"Lab4_exercise_v23.pdf"',
  });
  assert.deepEqual(categorize({ filename: "02_x.pdf", activity: "Week 2 lecture slides", section: "Week 2 - Lab 1" }), {
    category: "Lectures",
    reason: 'activity:"Week 2 lecture slides"',
  });
  assert.deepEqual(categorize({ filename: "handout.pdf", activity: "Git", section: "Week 2 - Lab 1 (tutorial)" }), {
    category: "Labs and Seminars",
    reason: 'section:"Week 2 - Lab 1 (tutorial)"',
  });
  assert.deepEqual(categorize({ filename: "chaos.pdf", activity: "Chaos", section: "Intro" }), { category: "Other", reason: "no rule matched" });
});

test("within one piece of evidence, rule order decides", () => {
  // Past Papers before Assessment Guidance, Labs before Lectures.
  assert.equal(categorize({ filename: "Past paper marking scheme.pdf" }).category, "Past Papers");
  assert.equal(categorize({ filename: "Week 3 tutorial.pdf" }).category, "Labs and Seminars");
  assert.equal(categorize({ filename: "lecture3.vtt" }).category, "Transcripts");
  assert.equal(categorize({ filename: "Further reading.pdf" }).category, "Reference");
});

test("EX followed by a digit is a lab exercise, case-sensitively", () => {
  assert.equal(categorize({ filename: "Week4_EX1_v20.pdf" }).category, "Labs and Seminars");
  assert.equal(categorize({ filename: "Week4_ex1.pdf" }).category, "Lectures");
  assert.equal(categorize({ filename: "TEX1 notes.pdf" }).category, "Reference");
});

test("isVideo by mimetype or extension", () => {
  assert.equal(isVideo({ filename: "a.bin", mimetype: "video/quicktime" }), true);
  assert.equal(isVideo({ filename: "Lecture 1.MP4", mimetype: null }), true);
  for (const ext of ["mov", "m4v", "avi", "mkv", "webm"]) assert.equal(isVideo({ filename: `x.${ext}`, mimetype: null }), true);
  assert.equal(isVideo({ filename: "slides.pdf", mimetype: "application/pdf" }), false);
});

test("lectures get a teaching-order prefix by section, then item order", () => {
  const { jobs } = planFiles(
    [
      fileItem("b.pdf", "Week 2 lecture slides", "Week 2", { sectionIndex: 2 }),
      fileItem("a.pdf", "Week 1 lecture slides", "Week 1", { sectionIndex: 1 }),
      fileItem("c.pdf", "Week 2 lecture slides", "Week 2", { sectionIndex: 2 }),
      fileItem("lab.pdf", "Lab 1", "Week 1", { sectionIndex: 1 }),
    ],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [
      `${BASE}/Lectures/02 - b.pdf`,
      `${BASE}/Lectures/01 - a.pdf`,
      `${BASE}/Lectures/03 - c.pdf`,
      `${BASE}/Labs and Seminars/lab.pdf`,
    ],
  );
});

test("folder activities keep the activity name and sub-path", () => {
  const { jobs } = planFiles(
    [
      fileItem("2015_ECS505U_Final_Exam.pdf", "Past exam papers", "Exams", { activityType: "folder", activityId: 7 }),
      fileItem("2016 solutions.pdf", "Past exam papers", "Exams", { activityType: "folder", activityId: 7, filepath: "/Solutions/2016/" }),
    ],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => [j.relativePath, j.vleId]),
    [
      [`${BASE}/Past Papers/Past exam papers/2015_ECS505U_Final_Exam.pdf`, "moodle:file:7:/2015_ECS505U_Final_Exam.pdf"],
      [`${BASE}/Past Papers/Past exam papers/Solutions/2016/2016 solutions.pdf`, "moodle:file:7:/Solutions/2016/2016 solutions.pdf"],
    ],
  );
});

test("videos are skipped", () => {
  const { jobs, skipped } = planFiles(
    [fileItem("Recording.mp4", "Lecture recording", "Week 1", { activityId: 9 }), fileItem("x.bin", "Clip", "Week 1", { activityId: 10, mimetype: "video/mp4" })],
    placement,
  );
  assert.deepEqual(jobs, []);
  assert.deepEqual(skipped, [
    { vleId: "moodle:file:9:/Recording.mp4", filename: "Recording.mp4", why: "video" },
    { vleId: "moodle:file:10:/x.bin", filename: "x.bin", why: "video" },
  ]);
});

test("a page is one HTML file plus its images in '<name> files/'", () => {
  const page: VleItem = {
    kind: "page",
    html: "<p>Hello</p>",
    files: [vleFile("opening menu 3.gif", "/", "image/gif"), vleFile("open menu png.apng", "/img/")],
    section: "Getting started",
    sectionIndex: 1,
    activity: "Navigating &amp; Pages",
    activityType: "page",
    activityId: 42,
    activityUrl: "https://qmplus.example/mod/page/view.php?id=42",
  };
  const { jobs } = planFiles([page], placement);
  assert.deepEqual(
    jobs.map((j) => [j.relativePath, j.vleId, j.category]),
    [
      [`${BASE}/Other/Navigating & Pages.html`, "moodle:page:42", "Other"],
      [`${BASE}/Other/Navigating & Pages files/opening menu 3.gif`, "moodle:file:42:/opening menu 3.gif", "Other"],
      [`${BASE}/Other/Navigating & Pages files/img/open menu png.apng`, "moodle:file:42:/img/open menu png.apng", "Other"],
    ],
  );
  assert.equal(jobs[0]?.html, "<p>Hello</p>");
  assert.equal(jobs[1]?.html, undefined);
});

test("a page with no files is just its HTML job", () => {
  const page: VleItem = {
    kind: "page",
    html: "<p>Links</p>",
    files: [],
    section: "Resources",
    sectionIndex: 3,
    activity: "Extra resources",
    activityType: "page",
    activityId: 43,
    activityUrl: "https://qmplus.example/mod/page/view.php?id=43",
  };
  const { jobs } = planFiles([page], placement);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.relativePath, `${BASE}/Reference/Extra resources.html`);
  assert.equal(jobs[0]?.vleId, "moodle:page:43");
  assert.equal(jobs[0]?.html, "<p>Links</p>");
});

test("HTML files attached to a page are downloaded, not taken for its body", () => {
  const page: VleItem = {
    kind: "page",
    html: "<p>Body</p>",
    files: [vleFile("handout.html", "/", "text/html"), vleFile("index.html", "/extra/", "text/html"), vleFile("map.png", "/", "image/png")],
    section: "Getting started",
    sectionIndex: 1,
    activity: "Welcome",
    activityType: "page",
    activityId: 45,
    activityUrl: "https://qmplus.example/mod/page/view.php?id=45",
  };
  const { jobs } = planFiles([page], placement);
  assert.deepEqual(
    jobs.map((j) => [j.relativePath, j.vleId, j.html]),
    [
      [`${BASE}/Other/Welcome.html`, "moodle:page:45", "<p>Body</p>"],
      [`${BASE}/Other/Welcome files/handout.html`, "moodle:file:45:/handout.html", undefined],
      [`${BASE}/Other/Welcome files/extra/index.html`, "moodle:file:45:/extra/index.html", undefined],
      [`${BASE}/Other/Welcome files/map.png`, "moodle:file:45:/map.png", undefined],
    ],
  );
  assert.equal(jobs[1]?.file.url, "https://qmplus.example/pluginfile.php/1/handout.html");
});

test("lecture pages carry the prefix onto their files folder", () => {
  const page: VleItem = {
    kind: "page",
    html: "",
    files: [vleFile("diagram.png", "/", "image/png")],
    section: "Week 1",
    sectionIndex: 1,
    activity: "Lecture notes",
    activityType: "page",
    activityId: 44,
    activityUrl: "",
  };
  const { jobs } = planFiles([page], placement);
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [`${BASE}/Lectures/01 - Lecture notes.html`, `${BASE}/Lectures/01 - Lecture notes files/diagram.png`],
  );
});

test("assignment briefs go to Assessment Guidance", () => {
  const { jobs } = planFiles([assignment(77, "mySkills Task 3 (3%)", [vleFile("Level 5 - Task 3.docx")])], placement);
  assert.deepEqual(
    jobs.map((j) => [j.relativePath, j.vleId, j.category, j.reason]),
    [[`${BASE}/Assessment Guidance/Level 5 - Task 3.docx`, "moodle:file:77:/Level 5 - Task 3.docx", "Assessment Guidance", 'activityType:"assign"']],
  );
});

test("the same file seen as an assign file item and as a brief is planned once", () => {
  const { jobs } = planFiles(
    [fileItem("Brief.pdf", "CW1", "Coursework", { activityType: "assign", activityId: 5 }), assignment(5, "CW1", [vleFile("Brief.pdf")])],
    placement,
  );
  assert.equal(jobs.length, 1);
});

test("collisions are case-insensitive and numbered before the extension", () => {
  const { jobs } = planFiles(
    [
      fileItem("Notes.pdf", "Reading", "Week 1"),
      fileItem("notes.PDF", "Reading", "Week 2"),
      fileItem("NOTES.pdf", "Reading", "Week 3"),
      fileItem("README", "Reading", "Week 3"),
      fileItem("readme", "Reading", "Week 3"),
    ],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [
      `${BASE}/Reference/Notes.pdf`,
      `${BASE}/Reference/notes (2).PDF`,
      `${BASE}/Reference/NOTES (3).pdf`,
      `${BASE}/Reference/README`,
      `${BASE}/Reference/readme (2)`,
    ],
  );
});

test("a file may not take a folder's path, case-insensitively", () => {
  const { jobs } = planFiles(
    [fileItem("diagram.png", "assets", "Misc", { activityType: "folder" }), fileItem("Assets", "Assets", "Misc")],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [`${BASE}/Other/assets/diagram.png`, `${BASE}/Other/Assets (2)`],
  );
});

test("a new folder may not take a file's path; the folder segment is numbered", () => {
  const { jobs } = planFiles(
    [
      fileItem("Assets", "Assets", "Misc"),
      fileItem("diagram.png", "assets", "Misc", { activityType: "folder", activityId: 8 }),
      fileItem("logo.png", "assets", "Misc", { activityType: "folder", activityId: 8, filepath: "/img/" }),
      fileItem("Img", "Img", "Misc"),
    ],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [
      `${BASE}/Other/Assets`,
      `${BASE}/Other/assets (2)/diagram.png`,
      `${BASE}/Other/assets (2)/img/logo.png`,
      `${BASE}/Other/Img`,
    ],
  );
});

test("folder sub-paths and page files folders are numbered when a file holds the name", () => {
  const page: VleItem = {
    kind: "page",
    html: "",
    files: [vleFile("map.png", "/", "image/png")],
    section: "Misc",
    sectionIndex: 0,
    activity: "Tour",
    activityType: "page",
    activityId: 46,
    activityUrl: "",
  };
  const { jobs } = planFiles(
    [
      fileItem("Tour files", "Tour files", "Misc"),
      page,
      fileItem("Solutions", "Pack", "Misc", { activityType: "folder", activityId: 9 }),
      fileItem("a.pdf", "Pack", "Misc", { activityType: "folder", activityId: 9, filepath: "/solutions/" }),
    ],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [
      `${BASE}/Other/Tour files`,
      `${BASE}/Other/Tour.html`,
      `${BASE}/Other/Tour files (2)/map.png`,
      `${BASE}/Other/Pack/Solutions`,
      `${BASE}/Other/Pack/solutions (2)/a.pdf`,
    ],
  );
});

test("folders that differ only in case share the first spelling", () => {
  const { jobs } = planFiles(
    [
      fileItem("a.pdf", "Misc", "Misc", { activityType: "folder", activityId: 10 }),
      fileItem("b.pdf", "MISC", "Misc", { activityType: "folder", activityId: 11 }),
    ],
    placement,
  );
  assert.deepEqual(
    jobs.map((j) => j.relativePath),
    [`${BASE}/Other/Misc/a.pdf`, `${BASE}/Other/Misc/b.pdf`],
  );
});

test("names are sanitised in every segment", () => {
  const { jobs } = planFiles(
    [fileItem("a:b?.pdf", "Docs: <misc>", "Misc", { activityType: "folder", filepath: "/x|y/" })],
    { ...placement, folder: "ECS505U - Software Engineering" },
  );
  assert.equal(jobs[0]?.relativePath, `${BASE}/Other/Docs misc/x y/a b .pdf`);
});

/**
 * Regression: ECS505U as measured on 2026-10-16 (docs/design/03, spikes/qmplus-module).
 * Section and activity names are the ones the spike recorded as the deciding
 * evidence; where the file name decided, the activity is a neutral stand-in.
 */
test("ECS505U regression: every non-page file lands where it should", () => {
  type Row = [filename: string, activity: string, section: string, sectionIndex: number, expected: Category, activityType?: string];
  const rows: Row[] = [
    ["01_Introduction_and_Overview.pdf", "Lecture 1 Slides", "Week 1 - Introduction", 1, "Lectures"],
    ["chaos-report.pdf", "CHAOS report", "Week 1 - Introduction", 1, "Lectures"],
    ["What should you do next as a 2nd year CS student.pptx", "Careers talk", "Week 1 - Introduction", 1, "Lectures"],
    ["02_Systems_concepts_and_modelling.pdf", "Week 2 lecture slides", "Week 2 - System Concepts and Modelling", 2, "Lectures"],
    ["abstraction.pdf", "Abstraction", "Week 2 - System Concepts and Modelling", 2, "Lectures"],
    ["git-for-beginners-handout.pdf", "Git for beginners", "Week 2 - Lab 1 (tutorial)", 3, "Labs and Seminars"],
    ["atlassian_git_cheatsheet.pdf", "Git cheatsheet", "Week 2 - Lab 1 (tutorial)", 3, "Reference"],
    ["03_static_dynamic_uml.pdf", "Week 3 lecture - slides", "Week 3", 4, "Lectures"],
    ["03_static_dynamic_uml_updated.pdf", "Week 3 lecture - slides", "Week 3", 4, "Lectures"],
    ["Use-case_solution_v22.pdf", "Week 4 lab -  Multiple inheritance (Dice exercise) video solution", "Week 4", 5, "Labs and Seminars"],
    ["Dice_exercise_instructions_v15.pdf", "Dice", "Week 4", 5, "Labs and Seminars"],
    ["Week4_EX1_v20.pdf", "Exercise 1", "Week 4", 5, "Labs and Seminars"],
    ["Week4_EX2_15.pdf", "Exercise 2", "Week 4", 5, "Labs and Seminars"],
    ["04_Domain_requirememts_usecase_analysis_sommerville.pdf", "Domain &amp; Requirements Analysis - Lecture slides", "Week 5", 6, "Lectures"],
    ["04_Domain_requirememts_usecase_analysis_sommerville-update.pdf", "Domain &amp; Requirements Analysis - Lecture slides", "Week 5", 6, "Lectures"],
    ["Lab4_exercise_v23.pdf", "Lab 4", "Week 5 - Lab 4 (formative)", 7, "Labs and Seminars"],
    ["Lab4_class_diagram_exercise_v21.pdf", "Lab 4", "Week 5 - Lab 4 (formative)", 7, "Labs and Seminars"],
    ["Traceability_Matrix_template.docx", "Traceability matrix template", "Week 5 - Lab 4 (formative)", 7, "Labs and Seminars"],
    ["05_System_design.pdf", "System Design - lecture slides", "Week 6", 8, "Lectures"],
    ["05_Design_Patterns.pdf", "Week 6 lecture - slides", "Week 6", 8, "Lectures"],
    ["sequence_diagram_exercise_v21.pdf", "Sequence diagrams", "Week 6", 8, "Labs and Seminars"],
    ["Lab6_sequence_exercise_v20.vpp", "Visual Paradigm model", "Week 6", 8, "Labs and Seminars"],
    ["Lab7_exercise_v18.pdf", "Lab 7", "Week 7", 9, "Labs and Seminars"],
    ["Week7_LabExercise_v20.vpp", "Visual Paradigm model", "Week 7", 9, "Labs and Seminars"],
    ["08_sw_life_cycles.pdf", "Week 8 lecture slides", "Week 8", 10, "Lectures"],
    ["ecs505_junit_tutorial.pdf", "JUnit", "Week 9", 11, "Labs and Seminars"],
    ["09_Testing.pdf", "Week 9 lecture slides", "Week 9", 11, "Lectures"],
    ["10_QA_metrics_shortened.pdf", "Week 10 lecture slides", "Week 10", 12, "Lectures"],
    ["11_project management_short.pdf", "Week 11 lecture slides", "Week 11", 13, "Lectures"],
    ["11_ethical_legal_issues.pdf", "Lecture slides", "Week 11", 13, "Lectures"],
    ["505_revision_guide.pdf", "Revision guide", "Week 12 - REVISION", 14, "Lectures"],
    ["ECS505_Exam_Revision_Notes_2020.pdf", "Revision notes", "Week 12 - REVISION", 14, "Reference"],
    ["Level 5 - Task 3.docx", "mySkills Task 3", "Week 1 - Introduction", 1, "Assessment Guidance", "assign"],
  ];
  const papers = [
    "2015_ECS505U_Final_Exam.pdf",
    "2015_ECS505U_Final_Solutions_QMplus.pdf",
    "2016_ECS505U_final.pdf",
    "2016_ECS505U_Solutions_QMplus.pdf",
    "2017_ECS505U_final.pdf",
    "2017_ECS505U_solutions_QMplus.pdf",
    "2018_ECS505U_final.pdf",
    "2018_ECS505U_solutions_QMplus.pdf",
    "2019_ECS505U_final.pdf",
    "2019_ECS505U_Solutions_QMplus.pdf",
    "2020_ECS505U_final.pdf",
    "2020_ECS505U_solutions.pdf",
  ];
  const items: VleItem[] = [
    ...rows.map(([filename, activity, section, sectionIndex, , activityType]) =>
      fileItem(filename, activity, section, { sectionIndex, activityType: activityType ?? "resource" }),
    ),
    ...papers.map((filename) => fileItem(filename, "Past exam papers", "Exams", { sectionIndex: 15, activityType: "folder", activityId: 1 })),
  ];
  const { jobs, skipped } = planFiles(items, placement);
  assert.deepEqual(skipped, []);
  const byFile = new Map(jobs.map((j) => [j.file.filename, j]));
  for (const [filename, , , , expected] of rows) assert.equal(byFile.get(filename)?.category, expected, filename);
  for (const filename of papers) {
    assert.equal(byFile.get(filename)?.relativePath, `${BASE}/Past Papers/Past exam papers/${filename}`);
  }
  assert.equal(byFile.get("2015_ECS505U_Final_Exam.pdf")?.reason, 'activity:"Past exam papers"');
  assert.equal(byFile.get("Week4_EX1_v20.pdf")?.reason, 'file:"Week4_EX1_v20.pdf"');
  assert.equal(byFile.get("02_Systems_concepts_and_modelling.pdf")?.reason, 'activity:"Week 2 lecture slides"');
  assert.equal(byFile.get("git-for-beginners-handout.pdf")?.reason, 'section:"Week 2 - Lab 1 (tutorial)"');
  assert.equal(byFile.get("04_Domain_requirememts_usecase_analysis_sommerville.pdf")?.reason, 'activity:"Domain & Requirements Analysis - Lecture slides"');
  assert.equal(byFile.get("Level 5 - Task 3.docx")?.relativePath, `${BASE}/Assessment Guidance/Level 5 - Task 3.docx`);

  const lectures = jobs.filter((j) => j.category === "Lectures").map((j) => j.relativePath.slice(`${BASE}/Lectures/`.length));
  assert.equal(lectures.length, 17);
  assert.deepEqual(lectures.slice(0, 4), [
    "01 - 01_Introduction_and_Overview.pdf",
    "02 - chaos-report.pdf",
    "03 - What should you do next as a 2nd year CS student.pptx",
    "04 - 02_Systems_concepts_and_modelling.pdf",
  ]);
  assert.equal(lectures.at(-1), "17 - 505_revision_guide.pdf");
  assert.equal(jobs.filter((j) => j.category === "Other").length, 0);
});
