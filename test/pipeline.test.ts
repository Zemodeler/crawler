import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { changeLines, deadlinesFromItems, mergeDeadlines, placeCourse, textDeadlines, titleOverlap, weekMapForCourse } from "../src/index.ts";
import type { AiRunner, Course, Deadline, ManifestEntry, TextDeadlinesInput, VleItem } from "../src/index.ts";

const NOW = new Date("2026-10-16T09:00:00Z");
const SITE = "https://moodle.example.ac.uk";
const unix = (iso: string) => Date.parse(iso) / 1000;

const COURSE: Course = {
  id: 1,
  shortname: "TST101U 2026/27",
  fullname: "TST101U Testing Basics 2026/27",
  startdate: unix("2026-09-21T00:00:00Z"),
  enddate: unix("2027-01-29T00:00:00Z"),
  url: `${SITE}/course/view.php?id=1`,
};
const PLACEMENT = placeCourse(COURSE);

const assignment = (title = "Coursework 1 (20%)", due: string | null = "2026-12-14T10:00:00Z"): VleItem => ({
  kind: "assignment",
  id: 5,
  activityId: 5,
  title,
  due: due ? unix(due) : null,
  cutoff: null,
  introHtml: "",
  briefFiles: [],
  url: `${SITE}/mod/assign/view.php?id=5`,
  modified: null,
});

const announcement = (id: number, body: string, subject = "News"): VleItem => ({
  kind: "announcement",
  id,
  subject,
  bodyHtml: `<p>${body}</p>`,
  posted: unix("2026-10-10T09:00:00Z"),
  url: `${SITE}/mod/forum/discuss.php?d=${id}`,
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "crawler-pipeline-"));
  const run = (items: VleItem[], extra: Partial<TextDeadlinesInput> = {}) =>
    textDeadlines({
      universityId: "qmul",
      root,
      course: COURSE,
      placement: PLACEMENT,
      items,
      manifest: [],
      deadlines: deadlinesFromItems(items, COURSE, PLACEMENT, NOW),
      now: NOW,
      ...extra,
    });
  const json = async <T>(...parts: string[]) => JSON.parse(await readFile(join(root, ...parts), "utf8")) as T;
  return { root, run, json, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const EXTENDED = "Coursework 1 deadline has been extended to 21 December 2026 at 12:00 for everyone in the module.";
const FINAL_EXAM = "Remember that the final exam takes place on 12 January 2027 at 10:00 in the main hall.";
const WEEK_TEST = "The Software Quality test will take place in week 9 for all students in the module.";

type AiItem = { title: string; kind: string; date: string | null; weekNumber: number | null; quote: string; page: number; weight: number | null; formative: boolean | null };
const aiItem = (over: Partial<AiItem>): AiItem => ({ title: "Oral presentation", kind: "presentation", date: null, weekNumber: null, quote: "", page: 1, weight: 10, formative: false, ...over });

/** A runner whose answers come from `answer(prompt)`; counts its requests. */
function fakeRunner(answer: (prompt: string) => AiItem[], cli: "claude" | "codex" | null = "claude") {
  const runner = {
    requests: 0,
    async available() {
      return { cli };
    },
    async structured<T>(request: { prompt: string }): Promise<T> {
      runner.requests++;
      return { items: answer(request.prompt) } as T;
    },
  };
  return runner satisfies AiRunner & { requests: number };
}

const ORAL = "The oral presentation is worth 10% of the module mark. It happens in week 11 on Friday.";
const ORAL_QUOTE = "It happens in week 11 on Friday.";

test("a rule candidate becomes a second source on the VLE deadline and a different date is a conflict", async () => {
  const t = await setup();
  try {
    const { deadlines, counts } = await t.run([assignment(), announcement(1, EXTENDED)]);
    assert.equal(deadlines.length, 1);
    const d = deadlines[0]!;
    assert.equal(d.id, "moodle:TST101U 2026/27:assign:5");
    assert.equal(d.status, "conflict");
    assert.equal(d.due?.iso, "2026-12-14T10:00:00.000Z", "the VLE date is kept; the student resolves the conflict");
    assert.deepEqual(d.sources.map((s) => [s.type, s.strength]), [["vle-field", "structured"], ["announcement", "quoted"]]);
    const quoted = d.sources[1]!;
    assert.equal(quoted.date?.iso, "2026-12-21T12:00:00.000Z");
    assert.equal(quoted.quote, EXTENDED);
    assert.equal(quoted.url, `${SITE}/mod/forum/discuss.php?d=1`);
    assert.equal(quoted.page, 1);
    assert.deepEqual(counts, { sources: 1, candidates: 1, verified: 1, rejected: 0, adjusted: 0, aiRuns: 0, aiMs: 0 });
  } finally {
    await t.cleanup();
  }
});

test("a text source that agrees with the VLE date keeps the deadline confirmed", async () => {
  const t = await setup();
  try {
    const { deadlines } = await t.run([assignment(), announcement(1, "Reminder: Coursework 1 is due on 14 December 2026 at 10:00 through the QMplus link.")]);
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0]!.status, "confirmed");
    assert.equal(deadlines[0]!.sources.length, 2);
  } finally {
    await t.cleanup();
  }
});

test("a deadline only the text knows about is created with a stable id", async () => {
  const t = await setup();
  try {
    const first = await t.run([assignment(), announcement(1, FINAL_EXAM)]);
    assert.equal(first.deadlines.length, 2);
    const exam = first.deadlines.find((d) => d.id.includes(":text:"))!;
    assert.match(exam.id, /^qmul:TST101U:text:[0-9a-f]{40}$/);
    assert.deepEqual([exam.title, exam.kind, exam.status, exam.module, exam.year], ["Final exam", "exam", "confirmed", "TST101U", "2026-27"]);
    assert.equal(exam.due?.iso, "2027-01-12T10:00:00.000Z");
    assert.equal(exam.sources.length, 1);
    assert.equal(exam.sources[0]!.strength, "quoted");

    // Another post of the same exam, worded differently, is the same deadline.
    const again = await t.run([announcement(2, "Reminder for everyone: the final exam takes place on 12 January 2027 at 10:00 in the main hall.")]);
    const same = again.deadlines.find((d) => d.id.includes(":text:"))!;
    assert.equal(same.id, exam.id);
  } finally {
    await t.cleanup();
  }
});

test("a text date outside the academic year needs checking", async () => {
  const t = await setup();
  try {
    const { deadlines } = await t.run([announcement(1, "Remember that the final exam takes place on 12 January 2029 at 10:00 in the main hall.")]);
    assert.equal(deadlines[0]!.status, "needs-check");
    assert.match(deadlines[0]!.checkReason ?? "", /outside the 2026-27 academic year/);
  } finally {
    await t.cleanup();
  }
});

test("a week-and-day quote is resolved with the term's week map; a week alone or no map stays tbc", async () => {
  const t = await setup();
  try {
    const mapped = await t.run([announcement(1, WEEK_TEST.replace("in week 9", "on Friday of week 9"))]);
    const d = mapped.deadlines[0]!;
    assert.equal(d.status, "confirmed");
    assert.equal(d.due?.iso, "2026-11-20T00:00:00.000Z", "Friday of teaching week 9, London midnight");
    assert.equal(d.due?.allDay, true);

    const weekOnly = await t.run([announcement(1, WEEK_TEST)]);
    assert.equal(weekOnly.deadlines[0]!.status, "tbc", "a week without a day is not a date");
    assert.equal(weekOnly.deadlines[0]!.due, null);

    const unknownUniversity = await t.run([announcement(1, WEEK_TEST)], { universityId: "tst" });
    assert.equal(unknownUniversity.deadlines[0]!.status, "tbc");
    assert.equal(unknownUniversity.deadlines[0]!.due, null);
    assert.equal(unknownUniversity.deadlines[0]!.sources[0]!.date, null);
    assert.equal(unknownUniversity.counts.verified, 1);

    const yearLong = await t.run([announcement(1, WEEK_TEST)], { course: { ...COURSE, enddate: unix("2027-06-30T00:00:00Z") } });
    assert.equal(yearLong.deadlines[0]!.status, "tbc");
  } finally {
    await t.cleanup();
  }
});

test("the week map follows the course's semester", () => {
  const map = (startdate: string, enddate: string | null) =>
    weekMapForCourse("qmul", { ...COURSE, startdate: unix(startdate), enddate: enddate === null ? null : unix(enddate) }, PLACEMENT);
  assert.equal(map("2026-09-21T00:00:00Z", "2027-01-29T00:00:00Z")?.termStart, "2026-09-21");
  assert.equal(map("2027-01-25T00:00:00Z", "2027-05-28T00:00:00Z")?.termStart, "2027-01-25");
  assert.equal(map("2026-09-21T00:00:00Z", "2027-06-30T00:00:00Z"), null, "year-long");
  assert.equal(map("2026-09-21T00:00:00Z", null), null, "unknown end");
  assert.equal(weekMapForCourse("qmul", { ...COURSE, startdate: null }, PLACEMENT), null);
});

test("titles match on token overlap, never across different numbers", () => {
  assert.equal(titleOverlap("Coursework 1", "Coursework 1 (20%)"), 1);
  assert.ok(titleOverlap("Lab test", "Lab test 1 - submission link") >= 0.6);
  assert.equal(titleOverlap("Coursework 2", "Coursework 1"), 0);
  assert.equal(titleOverlap("Final exam", "Coursework 1"), 0);
});

test("a same-kind candidate on the same London day attaches even when the titles differ", async () => {
  const t = await setup();
  try {
    const { deadlines } = await t.run([assignment("Portfolio (30%)"), announcement(1, "Please remember the coursework is due on 14 December 2026 at 10:00 for all of you.")]);
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0]!.sources.length, 2);
    assert.equal(deadlines[0]!.status, "confirmed");
  } finally {
    await t.cleanup();
  }
});

test("documents are read from the folder, in the cache, and big or non-text files are skipped", async () => {
  const t = await setup();
  try {
    const dir = join(t.root, "2026-27", "TST101U - Testing Basics", "Course Materials", "Reference");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Brief.txt"), "The lab test is due on 3 December 2026 at 16:00 and counts for 10% of the module.");
    await writeFile(join(dir, "Picture.png"), "not text");
    const big = await open(join(dir, "Huge.txt"), "w");
    await big.truncate(51 * 1024 * 1024);
    await big.close();
    const entry = (name: string, id: number): ManifestEntry => ({
      vleId: `moodle:file:${id}`,
      module: COURSE.shortname,
      sourceUrl: `${SITE}/pluginfile.php/${id}/${name}`,
      localPath: `2026-27/TST101U - Testing Basics/Course Materials/Reference/${name}`,
      category: "Reference",
      categoryReason: "test",
      vleModified: null,
      sha256: "x",
      writtenAt: NOW.toISOString(),
    });
    const { deadlines, counts } = await t.run([], { manifest: [entry("Brief.txt", 1), entry("Picture.png", 2), entry("Huge.txt", 3), entry("Missing.txt", 4)] });
    assert.equal(counts.sources, 1);
    assert.equal(deadlines.length, 1);
    const source = deadlines[0]!.sources[0]!;
    assert.equal(source.type, "document");
    assert.equal(source.localPath, "2026-27/TST101U - Testing Basics/Course Materials/Reference/Brief.txt");
    assert.equal(deadlines[0]!.weight, 10);
    assert.equal(deadlines[0]!.kind, "lab");
    assert.equal((await stat(join(t.root, ".crawler", "text"))).isDirectory(), true);
  } finally {
    await t.cleanup();
  }
});

test("page items and assignment intros are sources too", async () => {
  const t = await setup();
  try {
    const page: VleItem = {
      kind: "page",
      html: "<p>The final exam takes place on 12 January 2027 at 10:00 in the main hall.</p>",
      files: [],
      section: "Assessment",
      sectionIndex: 3,
      activity: "Assessment information",
      activityType: "page",
      activityId: 40,
      activityUrl: `${SITE}/mod/page/view.php?id=40`,
    };
    const withIntro = { ...(assignment() as Extract<VleItem, { kind: "assignment" }>), introHtml: "<p>Coursework 1 is due on 14 December 2026 at 10:00 through the link below.</p>" };
    const { deadlines, counts } = await t.run([page, withIntro]);
    assert.equal(counts.sources, 2);
    assert.deepEqual(deadlines.map((d) => d.sources.map((s) => s.type)).sort(), [["page"], ["vle-field", "page"]]);
  } finally {
    await t.cleanup();
  }
});

test("AI runs only on flagged sources, resolves week-only quotes and skips unchanged sources next time", async () => {
  const t = await setup();
  try {
    const items = [announcement(1, ORAL), announcement(2, "Welcome to the module, the first lecture is on Monday at the usual time and place.")];
    const ai = fakeRunner(() => [aiItem({ weekNumber: 11, quote: ORAL_QUOTE })]);

    const first = await t.run(items, { ai });
    assert.equal(ai.requests, 1, "only the announcement that talks about an assessment goes to the AI");
    assert.equal(first.counts.aiRuns, 1);
    assert.equal(first.counts.sources, 2);
    assert.equal(first.counts.verified, 1);
    const oral = first.deadlines[0]!;
    assert.equal(oral.title, "Oral presentation");
    assert.equal(oral.due?.iso, "2026-12-04T00:00:00.000Z", "Friday of teaching week 11");
    assert.equal(oral.weight, 10);
    assert.equal(oral.status, "confirmed");

    const hashes = await t.json<Record<string, string>>(".crawler", "ai-hashes.json");
    assert.deepEqual(Object.keys(hashes), [`${SITE}/mod/forum/discuss.php?d=1`]);

    const second = await t.run(items, { ai });
    assert.equal(ai.requests, 1, "nothing changed, so nothing is sent");
    assert.equal(second.counts.aiRuns, 0);
    assert.equal(second.counts.verified, 0, "the AI candidate is not re-found; the merge keeps the earlier deadline");

    const changed = await t.run([announcement(1, `${ORAL} Bring your own laptop.`)], { ai });
    assert.equal(ai.requests, 2);
    assert.equal(changed.counts.aiRuns, 1);
  } finally {
    await t.cleanup();
  }
});

test("without a week map the AI's week-only quote stays tbc", async () => {
  const t = await setup();
  try {
    const ai = fakeRunner(() => [aiItem({ weekNumber: 11, quote: ORAL_QUOTE })]);
    const { deadlines } = await t.run([announcement(1, ORAL)], { ai, universityId: "tst" });
    assert.equal(deadlines[0]!.status, "tbc");
    assert.equal(deadlines[0]!.due, null);
    assert.match(deadlines[0]!.sources[0]!.quote, /week 11/);
  } finally {
    await t.cleanup();
  }
});

test("AI is skipped when the runner has no CLI, and nothing is sent", async () => {
  const t = await setup();
  try {
    const ai = fakeRunner(() => [], null);
    const { counts } = await t.run([announcement(1, ORAL)], { ai });
    assert.equal(ai.requests, 0);
    assert.match(counts.aiSkipped ?? "", /no AI/);
    assert.equal(counts.aiRuns, 0);
  } finally {
    await t.cleanup();
  }
});

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => announcement(100 + i, `Announcement ${i}: the oral presentation is worth 10% of the module mark. It happens in week 11 on Friday.`));

test("more than 20 documents on a first run need the student's confirmation", async () => {
  const t = await setup();
  try {
    const items = many(21);
    const ai = fakeRunner(() => []);

    const unasked = await t.run(items, { ai });
    assert.equal(ai.requests, 0);
    assert.match(unasked.counts.aiSkipped ?? "", /21 documents/);

    const asked: number[] = [];
    const declined = await t.run(items, { ai, confirmAi: async (n) => (asked.push(n), false) });
    assert.deepEqual(asked, [21]);
    assert.equal(ai.requests, 0);
    assert.ok(declined.counts.aiSkipped);
    await assert.rejects(readFile(join(t.root, ".crawler", "ai-hashes.json")), "a declined run records no hashes");

    const accepted = await t.run(items, { ai, confirmAi: async (n) => (asked.push(n), true) });
    assert.equal(ai.requests, 21);
    assert.equal(accepted.counts.aiRuns, 21);
    assert.equal(accepted.counts.aiSkipped, undefined);

    // With hashes from an earlier run the course is no longer on its first run: no question.
    const changed = many(21).map((item, i) => (item.kind === "announcement" ? { ...item, bodyHtml: `${item.bodyHtml}<p>Updated ${i}.</p>` } : item));
    await t.run(changed, { ai, confirmAi: async () => assert.fail("must not ask again") });
    assert.equal(ai.requests, 42);
  } finally {
    await t.cleanup();
  }
});

test("20 documents need no confirmation", async () => {
  const t = await setup();
  try {
    const ai = fakeRunner(() => []);
    await t.run(many(20), { ai });
    assert.equal(ai.requests, 20);
  } finally {
    await t.cleanup();
  }
});

test("rejected candidates and their reasons go to rejected.json, latest run only", async () => {
  const t = await setup();
  try {
    const invented = aiItem({ title: "Secret exam", kind: "exam", date: "2027-01-12", quote: "The secret exam is on 12 January 2027 in the great hall." });
    const ai = fakeRunner(() => [invented]);
    const first = await t.run([announcement(1, ORAL)], { ai });
    assert.equal(first.counts.rejected, 1);
    assert.equal(first.counts.verified, 0);
    assert.equal(first.deadlines.length, 0, "a candidate whose quote is not in the text becomes no deadline");
    const rejected = await t.json<{ module: string; reason: string; candidate: { title: string; origin: string } }[]>(".crawler", "rejected.json");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.module, "TST101U");
    assert.equal(rejected[0]!.candidate.title, "Secret exam");
    assert.equal(rejected[0]!.candidate.origin, "ai");
    assert.match(rejected[0]!.reason, /quote not found/);

    await t.run([announcement(1, "Nothing about assessments in this note at all, only a friendly hello.")]);
    assert.deepEqual(await t.json(".crawler", "rejected.json"), []);
  } finally {
    await t.cleanup();
  }
});

test("a text-only deadline found twice, in two sources, gathers both quotes", async () => {
  const t = await setup();
  try {
    const { deadlines } = await t.run([announcement(1, FINAL_EXAM), announcement(2, "Reminder for everyone: the final exam takes place on 13 January 2027 at 10:00 in the main hall.")]);
    const exams = deadlines.filter((d): d is Deadline => d.id.includes(":text:"));
    assert.equal(exams.length, 1);
    assert.equal(exams[0]!.sources.length, 2);
    assert.equal(exams[0]!.status, "conflict");
  } finally {
    await t.cleanup();
  }
});

test("quoted dates fill undated VLE deadlines with history and plausibility checks, preserving user choices", async () => {
  const t = await setup();
  try {
    for (const year of [2026, 2029]) {
      const items = [assignment("Coursework 1", null), announcement(1, `Coursework 1 is due on 21 December ${year} at 12:00 for everyone in the module.`)];
      const { deadlines, counts } = await t.run(items);
      const d = deadlines[0]!;
      assert.equal(deadlines.length, 1);
      assert.equal(counts.verified, 1);
      assert.equal(d.due?.iso, `${year}-12-21T12:00:00.000Z`);
      assert.equal(d.status, year === 2026 ? "confirmed" : "needs-check");
      if (year === 2029) assert.match(d.checkReason ?? "", /outside the 2026-27 academic year/);
      assert.equal(d.sources[0]!.type, "vle-field");
      assert.equal(d.sources[0]!.date, null);
      assert.equal(d.sources[1]!.strength, "quoted");
      assert.deepEqual(d.history, [{ at: NOW.toISOString(), field: "due", from: null, to: d.due!.iso, source: d.sources[1] }]);
    }
    for (const due of [null, "2026-12-14T10:00:00Z"]) {
      const items = [assignment("Coursework 1", due), announcement(1, EXTENDED)];
      const original = deadlinesFromItems(items, COURSE, PLACEMENT, NOW)[0]!;
      original.status = "user-verified";
      const { deadlines } = await t.run(items, { deadlines: [original] });
      assert.deepEqual(deadlines[0]!.due, original.due);
      assert.equal(deadlines[0]!.status, "user-verified");
      assert.equal(deadlines[0]!.sources.length, 2);
      assert.deepEqual(deadlines[0]!.history, []);
    }
  } finally {
    await t.cleanup();
  }
});

test("semester boundaries exclude year-long and unknown courses and leave week quotes tbc", async () => {
  const t = await setup();
  try {
    const course = (start: string, end: string | null): Course => ({ ...COURSE, startdate: unix(start), enddate: end === null ? null : unix(end) });
    assert.ok(weekMapForCourse("qmul", course("2027-01-25", "2027-07-31T23:59:59Z"), PLACEMENT));
    assert.ok(weekMapForCourse("qmul", course("2026-09-21", "2027-01-31T23:59:59Z"), PLACEMENT));
    for (const c of [
      course("2027-01-25", "2027-08-01"),
      course("2027-01-25", "2028-05-28"),
      course("2027-01-25", null),
      course("2026-09-21", "2027-02-01"),
      course("2026-06-01", "2026-07-31"),
    ]) {
      assert.equal(weekMapForCourse("qmul", c, PLACEMENT), null);
      const { deadlines } = await t.run([announcement(1, WEEK_TEST)], { course: c });
      assert.equal(deadlines[0]!.due, null);
      assert.equal(deadlines[0]!.status, "tbc");
    }
  } finally {
    await t.cleanup();
  }
});

test("AI week-only quotes preserve a single stated time and otherwise resolve all-day", async () => {
  const t = await setup();
  try {
    for (const [id, suffix, iso, allDay] of [
      [1, " at 16:00", "2026-11-20T16:00:00.000Z", false],
      [2, "", "2026-11-20T00:00:00.000Z", true],
      [3, " at 10:00 or 16:00", "2026-11-20T00:00:00.000Z", true],
    ] as const) {
      const quote = `It happens in week 9 Friday${suffix}.`;
      const ai = fakeRunner(() => [aiItem({ weekNumber: 9, quote })]);
      const { deadlines, counts } = await t.run([announcement(id, `The oral presentation is worth 10% of the module mark. ${quote}`)], { ai });
      assert.equal(counts.verified, 1);
      assert.equal(counts.rejected, 0);
      assert.equal(deadlines[0]!.due?.iso, iso);
      assert.equal(deadlines[0]!.due?.allDay, allDay);
      assert.equal(deadlines[0]!.status, "confirmed");
    }
  } finally {
    await t.cleanup();
  }
});

test("an AI-found date on an undated VLE deadline survives the next sync, which skips the unchanged document", async () => {
  const t = await setup();
  try {
    const items = [assignment("Oral presentation", null), announcement(7, ORAL)];
    const runner = fakeRunner(() => [aiItem({ weekNumber: 11, quote: ORAL_QUOTE })]);
    const first = await t.run(items, { ai: runner });
    const oral1 = first.deadlines.find((d) => d.title === "Oral presentation")!;
    assert.ok(oral1.due, "the AI date fills the VLE deadline");
    const merged1 = mergeDeadlines([], first.deadlines, NOW);

    const later = new Date("2026-10-19T09:00:00Z");
    const second = await t.run(items, { ai: runner, now: later });
    assert.equal(runner.requests, 1, "the unchanged announcement is not sent again");
    assert.equal(second.deadlines.find((d) => d.id === oral1.id)!.due, null, "the fresh deadline arrives undated");

    const merged2 = mergeDeadlines(merged1, second.deadlines, later);
    const oral2 = merged2.find((d) => d.id === oral1.id)!;
    assert.equal(oral2.due?.iso, oral1.due!.iso);
    assert.equal(oral2.status, oral1.status);
    assert.deepEqual(changeLines(merged1, merged2), []);
  } finally {
    await t.cleanup();
  }
});

test("a generic title that fits several undated VLE deadlines equally fills none of them", async () => {
  const t = await setup();
  try {
    const cw = (id: number, title: string): VleItem => ({ ...(assignment(title, null) as Extract<VleItem, { kind: "assignment" }>), id, activityId: id, url: `${SITE}/mod/assign/view.php?id=${id}` });
    const items = [cw(5, "Coursework 1"), cw(6, "Coursework 2"), announcement(1, "The coursework is due on 21 December 2026 at 12:00 for everyone in the module.")];
    const { deadlines } = await t.run(items);
    for (const title of ["Coursework 1", "Coursework 2"]) {
      const d = deadlines.find((x) => x.title === title)!;
      assert.equal(d.due, null, `${title} keeps no date`);
      assert.equal(d.status, "tbc");
    }
  } finally {
    await t.cleanup();
  }
});
